import type { INode } from 'n8n-workflow'
import { NodeOperationError } from 'n8n-workflow'
import { describe, expect, it, vi } from 'vitest'
import {
    classify,
    isRetryable,
    type LogEvent,
    normalizeOdooUrl,
    type OutageRegistry,
    parseBody,
    type SendResult,
    sendWithWaiting,
    toRecords,
    validateTarget,
    type WaitDependencies,
    type WaitSettings
} from '../nodes/OdooJson2/GenericFunctions'

const node: INode = { id: '1', name: 'Odoo', type: 'odooJson2', typeVersion: 1, position: [0, 0], parameters: {} }

const settings: WaitSettings = {
    maxWaitMs: 60 * 60000,
    checkIntervalMs: 30000,
    maxAttempts: 5,
    waitingLogIntervalMs: 5 * 60000
}

const target = { odooUrl: 'https://odoo.test', model: 'res.partner', method: 'search_read', retryable: true }

interface Scenario {
    responses: SendResult[]
    health?: boolean[]
    cancelled?: boolean
}

function harness(scenario: Scenario) {
    let clock = Date.UTC(2026, 9, 28, 8, 0, 0)
    const logs: LogEvent[] = []
    let sends = 0
    let healthChecks = 0
    const deps: WaitDependencies = {
        send: async () => scenario.responses[Math.min(sends++, scenario.responses.length - 1)],
        isHealthy: async () => {
            const health = scenario.health ?? []
            return health[Math.min(healthChecks++, health.length - 1)] ?? false
        },
        sleep: async ms => {
            clock += ms
        },
        now: () => clock,
        log: async event => {
            logs.push(event)
        },
        isCancelled: () => scenario.cancelled === true
    }
    return {
        deps,
        logs,
        sends: () => sends,
        healthChecks: () => healthChecks,
        advance: (ms: number) => {
            clock += ms
        }
    }
}

const ok = (body: unknown = [{ id: 1 }]): SendResult => ({ response: { statusCode: 200, body } })
const status = (statusCode: number, body: unknown = '<html></html>'): SendResult => ({ response: { statusCode, body } })
const networkError = (code: string, message = code): SendResult => ({ error: { code, message } })

describe('isRetryable', () => {
    it('retries read methods and write automatically', () => {
        expect(isRetryable('search_read', 'automatic')).toBe(true)
        expect(isRetryable('read', 'automatic')).toBe(true)
        expect(isRetryable('write', 'automatic')).toBe(true)
    })

    it('never retries create, unlink or actions automatically', () => {
        expect(isRetryable('create', 'automatic')).toBe(false)
        expect(isRetryable('unlink', 'automatic')).toBe(false)
        expect(isRetryable('message_post', 'automatic')).toBe(false)
    })

    it('follows an explicit mode', () => {
        expect(isRetryable('create', 'always')).toBe(true)
        expect(isRetryable('search_read', 'never')).toBe(false)
    })
})

describe('classify', () => {
    it('accepts 2xx', () => {
        expect(classify(ok())).toEqual({ kind: 'ok' })
        expect(classify(status(204, null))).toEqual({ kind: 'ok' })
    })

    it('treats 405, 503 and refused connections as not delivered', () => {
        expect(classify(status(405))).toEqual({ kind: 'unavailable', notDelivered: true, reason: 'HTTP 405' })
        expect(classify(status(503))).toMatchObject({ kind: 'unavailable', notDelivered: true })
        expect(classify(networkError('ECONNREFUSED'))).toMatchObject({ kind: 'unavailable', notDelivered: true })
        expect(classify({ error: { cause: { code: 'ENOTFOUND' }, message: 'x' } })).toMatchObject({
            notDelivered: true
        })
    })

    it('treats 502, 504 and timeouts as unclear', () => {
        expect(classify(status(502))).toMatchObject({ kind: 'unavailable', notDelivered: false })
        expect(classify(status(504))).toMatchObject({ kind: 'unavailable', notDelivered: false })
        expect(classify(networkError('ECONNABORTED'))).toMatchObject({ notDelivered: false })
        expect(classify({ error: { message: 'timeout of 120000ms exceeded' } })).toMatchObject({
            notDelivered: false
        })
    })

    it('passes Odoo errors through with message and name', () => {
        expect(classify(status(422, { name: 'odoo.exceptions.ValidationError', message: 'Name fehlt' }))).toEqual({
            kind: 'failed',
            message: 'Name fehlt',
            name: 'odoo.exceptions.ValidationError'
        })
        expect(classify(status(401, '<html>401 Authorization Required</html>'))).toEqual({
            kind: 'failed',
            message: '<html>401 Authorization Required</html>'
        })
        expect(classify({ response: { statusCode: 500, statusMessage: 'Internal Server Error' } })).toEqual({
            kind: 'failed',
            message: 'HTTP 500 Internal Server Error'
        })
        expect(classify({ error: new Error('certificate has expired') })).toEqual({
            kind: 'failed',
            message: 'certificate has expired'
        })
        expect(classify({ error: 'boom' })).toEqual({ kind: 'failed', message: 'boom' })
        expect(classify({ error: 42 })).toEqual({ kind: 'failed', message: 'Unknown error' })
    })

    it('falls back to the HTTP status when an error body has no usable message', () => {
        expect(classify(status(400, { unexpected: true }))).toEqual({ kind: 'failed', message: 'HTTP 400' })
        expect(classify(status(400, '   '))).toEqual({ kind: 'failed', message: 'HTTP 400' })
    })
})

describe('sendWithWaiting', () => {
    it('returns the response without waiting when Odoo answers', async () => {
        const h = harness({ responses: [ok([{ id: 7 }])] })
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome).toEqual({ ok: true, response: { statusCode: 200, body: [{ id: 7 }] } })
        expect(h.logs).toEqual([])
        expect(h.healthChecks()).toBe(0)
    })

    it('returns Odoo errors at once', async () => {
        const h = harness({ responses: [status(422, { message: 'Name fehlt' })] })
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome).toEqual({
            ok: false,
            odooUnavailable: false,
            message: 'Name fehlt',
            name: undefined,
            httpStatus: 422
        })
        expect(h.sends()).toBe(1)
    })

    it('waits for /web/health after 405 and resends', async () => {
        const h = harness({ responses: [status(405), ok()], health: [false, false, true] })
        const outcome = await sendWithWaiting(
            h.deps,
            { ...target, method: 'create', retryable: false },
            settings,
            new Map()
        )
        expect(outcome.ok).toBe(true)
        expect(h.sends()).toBe(2)
        expect(h.healthChecks()).toBe(3)
        expect(h.logs.map(l => l.event)).toEqual(['unavailable', 'recovered'])
        expect(h.logs[0]).toMatchObject({ level: 'warn', httpStatus: 405, attempt: 1 })
        expect(h.logs[1].message).toContain('after 2 min')
    })

    it('does not resend a non-retryable request after 502', async () => {
        const h = harness({ responses: [status(502)] })
        const outcome = await sendWithWaiting(
            h.deps,
            { ...target, method: 'create', retryable: false },
            settings,
            new Map()
        )
        expect(outcome).toMatchObject({ ok: false, odooUnavailable: true, httpStatus: 502 })
        expect(outcome.ok === false && outcome.message).toContain('check the result in Odoo')
        expect(h.logs.map(l => l.event)).toEqual(['not_retried'])
        expect(h.sends()).toBe(1)
    })

    it('resends a retryable request after 502', async () => {
        const h = harness({ responses: [status(502), ok()], health: [true] })
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome.ok).toBe(true)
        expect(h.sends()).toBe(2)
    })

    it('logs while waiting at most every waiting log interval', async () => {
        const health = Array.from({ length: 25 }, () => false)
        health.push(true)
        const h = harness({ responses: [networkError('ECONNREFUSED'), ok()], health })
        await sendWithWaiting(h.deps, target, settings, new Map())
        const events = h.logs.map(l => l.event)
        expect(events.filter(e => e === 'waiting')).toHaveLength(2)
        expect(events[0]).toBe('unavailable')
        expect(events.at(-1)).toBe('recovered')
    })

    it('gives up after max wait and fails following requests at once while Odoo stays down', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [status(503)], health: [false] })
        const first = await sendWithWaiting(h.deps, target, settings, outages)
        expect(first).toMatchObject({ ok: false, odooUnavailable: true })
        expect(h.logs.at(-1)?.event).toBe('wait_timeout')
        expect(outages.has(target.odooUrl)).toBe(true)

        const sendsBefore = h.sends()
        const second = await sendWithWaiting(h.deps, target, settings, outages)
        expect(second).toMatchObject({ ok: false, odooUnavailable: true })
        expect(second.ok === false && second.message).toContain('still unavailable')
        expect(h.sends()).toBe(sendsBefore)
    })

    it('keeps failing fast even when the remembered outage is older than max wait', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [ok()], health: [false] })
        outages.set(target.odooUrl, h.deps.now())
        h.advance(settings.maxWaitMs)
        const outcome = await sendWithWaiting(h.deps, target, settings, outages)
        expect(outcome.ok).toBe(false)
        expect(h.sends()).toBe(0)
        expect(outages.has(target.odooUrl)).toBe(true)
    })

    it('forgets the outage when Odoo is healthy again', async () => {
        const outages: OutageRegistry = new Map([[target.odooUrl, Date.UTC(2026, 9, 28, 7, 59, 0)]])
        const h = harness({ responses: [ok()], health: [true] })
        const outcome = await sendWithWaiting(h.deps, target, settings, outages)
        expect(outcome.ok).toBe(true)
        expect(outages.size).toBe(0)
    })

    it('gives up after max attempts', async () => {
        const h = harness({ responses: [status(405)], health: [true] })
        const outcome = await sendWithWaiting(h.deps, target, { ...settings, maxAttempts: 3 }, new Map())
        expect(outcome.ok === false && outcome.message).toContain('gave up after 3 attempts')
        expect(h.sends()).toBe(3)
        expect(h.logs.at(-1)?.event).toBe('attempts_exhausted')
    })

    it('does not send any request when the execution is already cancelled', async () => {
        const h = harness({ responses: [status(503)], cancelled: true })
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome.ok === false && outcome.message).toContain('cancelled')
        expect(h.sends()).toBe(0)
        expect(h.healthChecks()).toBe(0)
    })

    it('stops after cancellation during sleep without checking health or retrying', async () => {
        const scenario = { responses: [status(503), ok()], health: [true], cancelled: false }
        const h = harness(scenario)
        h.deps.sleep = async () => {
            scenario.cancelled = true
        }
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('cancelled') })
        expect(h.sends()).toBe(1)
        expect(h.healthChecks()).toBe(0)
    })

    it.each([false, true])('stops if cancellation arrives during a health check (cached: %s)', async cached => {
        const scenario = { responses: [status(503), ok()], cancelled: false }
        const h = harness(scenario)
        const outages: OutageRegistry = new Map()
        if (cached) outages.set(target.odooUrl, h.deps.now())
        h.deps.isHealthy = async () => {
            scenario.cancelled = true
            return true
        }
        const outcome = await sendWithWaiting(h.deps, target, settings, outages)
        expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('cancelled') })
        expect(h.sends()).toBe(cached ? 0 : 1)
    })

    it('checks cancellation again after logging recovery', async () => {
        const scenario = { responses: [status(503), ok()], health: [true], cancelled: false }
        const h = harness(scenario)
        h.deps.log = async event => {
            if (event.level === 'info') scenario.cancelled = true
        }
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('cancelled') })
        expect(h.sends()).toBe(1)
    })

    it('caps the sleep interval at the remaining wait budget', async () => {
        const h = harness({ responses: [status(503)], health: [true] })
        const sleep = vi.spyOn(h.deps, 'sleep')
        const started = h.deps.now()
        const outcome = await sendWithWaiting(h.deps, target, { ...settings, maxWaitMs: 1000 }, new Map())
        expect(outcome.ok).toBe(false)
        expect(sleep).toHaveBeenCalledExactlyOnceWith(1000)
        expect(h.deps.now() - started).toBe(1000)
        expect(h.healthChecks()).toBe(1)
        expect(h.sends()).toBe(2)
        expect(h.logs.at(-1)?.event).toBe('wait_timeout')
    })

    it('checks health at the deadline when the wait budget is shorter than the check interval', async () => {
        const h = harness({ responses: [status(503), ok()], health: [true] })
        const outcome = await sendWithWaiting(h.deps, target, { ...settings, maxWaitMs: 1000 }, new Map())
        expect(outcome.ok).toBe(true)
        expect(h.healthChecks()).toBe(1)
        expect(h.sends()).toBe(2)
    })

    it('gives up after a failed health check at the deadline', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [status(503)], health: [false] })
        const outcome = await sendWithWaiting(h.deps, target, { ...settings, maxWaitMs: 1000 }, outages)
        expect(outcome).toMatchObject({ ok: false, odooUnavailable: true })
        expect(h.healthChecks()).toBe(1)
        expect(h.sends()).toBe(1)
        expect(outages.has(target.odooUrl)).toBe(true)
    })

    it('does not restart the wait budget when Odoo repeatedly becomes unavailable', async () => {
        const h = harness({ responses: [status(503)], health: [true] })
        const started = h.deps.now()
        const outcome = await sendWithWaiting(h.deps, target, { ...settings, maxWaitMs: 75000 }, new Map())
        expect(outcome.ok).toBe(false)
        expect(h.deps.now() - started).toBe(75000)
        expect(h.sends()).toBe(4)
        expect(h.logs.at(-1)?.event).toBe('wait_timeout')
    })

    it('resends without recording an outage when a health check passes after the deadline', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [status(503), ok()] })
        h.deps.isHealthy = async () => {
            h.advance(settings.maxWaitMs)
            return true
        }
        const outcome = await sendWithWaiting(h.deps, target, settings, outages)
        expect(outcome.ok).toBe(true)
        expect(h.sends()).toBe(2)
        expect(outages.has(target.odooUrl)).toBe(false)
        expect(h.logs.map(l => l.event)).toEqual(['unavailable', 'recovered'])
    })
})

describe('toRecords', () => {
    it('splits arrays like the HTTP Request node', () => {
        expect(toRecords([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }])
        expect(toRecords([])).toEqual([])
        expect(toRecords({ id: 1 })).toEqual([{ id: 1 }])
        expect(toRecords(true)).toEqual([{ data: true }])
        expect(toRecords([42])).toEqual([{ data: 42 }])
        expect(toRecords(null)).toEqual([{ data: null }])
    })
})

describe('input helpers', () => {
    it('normalizes the Odoo URL', () => {
        expect(normalizeOdooUrl(' https://odoo.test/ ', node, 0)).toBe('https://odoo.test')
        expect(() => normalizeOdooUrl('odoo.test', node, 0)).toThrow(NodeOperationError)
        expect(() => normalizeOdooUrl('ftp://odoo.test', node, 0)).toThrow(NodeOperationError)
        expect(() => normalizeOdooUrl(undefined as unknown as string, node, 0)).toThrow(NodeOperationError)
    })

    it.each([
        'https://user@odoo.test',
        'https://:private-value@odoo.test',
        'https://odoo.test?token=private-value',
        'https://odoo.test#private-value',
        'https://odoo.test?',
        'https://odoo.test/#'
    ])('rejects unsafe base URLs without echoing their contents: %s', raw => {
        expect(() => normalizeOdooUrl(raw, node, 0)).toThrow(NodeOperationError)
        expect(() => normalizeOdooUrl(raw, node, 0)).not.toThrow(/private-value/)
    })

    it('validates model and method', () => {
        expect(() => validateTarget('res.partner', 'search_read', node, 0)).not.toThrow()
        expect(() => validateTarget('res partner', 'search_read', node, 0)).toThrow(/Model/)
        expect(() => validateTarget('res.partner', 'search/read', node, 0)).toThrow(/Method/)
    })

    it('parses the body', () => {
        expect(parseBody('{"domain": []}', node, 0)).toEqual({ domain: [] })
        expect(parseBody('', node, 0)).toEqual({})
        expect(parseBody(undefined, node, 0)).toEqual({})
        expect(parseBody({ ids: [1] }, node, 0)).toEqual({ ids: [1] })
        expect(() => parseBody('{', node, 0)).toThrow(/valid JSON/)
        expect(() => parseBody('[1]', node, 0)).toThrow(/JSON object/)
    })
})
