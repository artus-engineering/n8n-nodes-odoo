import type { INode } from 'n8n-workflow'
import { NodeOperationError } from 'n8n-workflow'
import { describe, expect, it } from 'vitest'
import {
    buildLokiPayload,
    classify,
    isRetryable,
    type LogEvent,
    normalizeOdooUrl,
    type OutageRegistry,
    parseBody,
    resolveLokiPushUrl,
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
        expect(classify({ error: 42 })).toEqual({ kind: 'failed', message: 'unbekannter Fehler' })
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
        expect(h.logs.map(l => l.event)).toEqual(['odoo_nicht_erreichbar', 'odoo_wieder_erreichbar'])
        expect(h.logs[0]).toMatchObject({ level: 'warn', httpStatus: 405, attempt: 1 })
        expect(h.logs[1].message).toContain('nach 2 min')
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
        expect(outcome.ok === false && outcome.message).toContain('in Odoo pruefen')
        expect(h.logs.map(l => l.event)).toEqual(['odoo_nicht_wiederholt'])
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
        expect(events.filter(e => e === 'odoo_wartet')).toHaveLength(2)
        expect(events[0]).toBe('odoo_nicht_erreichbar')
        expect(events.at(-1)).toBe('odoo_wieder_erreichbar')
    })

    it('gives up after max wait and fails following requests at once while Odoo stays down', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [status(503)], health: [false] })
        const first = await sendWithWaiting(h.deps, target, settings, outages)
        expect(first).toMatchObject({ ok: false, odooUnavailable: true })
        expect(h.logs.at(-1)?.event).toBe('odoo_wartezeit_ueberschritten')
        expect(outages.has(target.odooUrl)).toBe(true)

        const sendsBefore = h.sends()
        const second = await sendWithWaiting(h.deps, target, settings, outages)
        expect(second).toMatchObject({ ok: false, odooUnavailable: true })
        expect(second.ok === false && second.message).toContain('weiterhin nicht erreichbar')
        expect(h.sends()).toBe(sendsBefore)
    })

    it('waits again once the remembered outage is older than max wait', async () => {
        const outages: OutageRegistry = new Map()
        const h = harness({ responses: [ok()], health: [false] })
        outages.set(target.odooUrl, h.deps.now())
        h.advance(settings.maxWaitMs)
        const outcome = await sendWithWaiting(h.deps, target, settings, outages)
        expect(outcome.ok).toBe(true)
        expect(outages.has(target.odooUrl)).toBe(false)
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
        expect(outcome.ok === false && outcome.message).toContain('nach 3 Versuchen aufgegeben')
        expect(h.sends()).toBe(3)
        expect(h.logs.at(-1)?.event).toBe('odoo_aufgegeben')
    })

    it('stops waiting when the execution is cancelled', async () => {
        const h = harness({ responses: [status(503)], cancelled: true })
        const outcome = await sendWithWaiting(h.deps, target, settings, new Map())
        expect(outcome.ok === false && outcome.message).toContain('abgebrochen')
        expect(h.healthChecks()).toBe(0)
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

    it('resolves the Loki push URL', () => {
        expect(resolveLokiPushUrl('https://loki.test/', node)).toBe('https://loki.test/loki/api/v1/push')
        expect(resolveLokiPushUrl('https://loki.test/loki/api/v1', node)).toBe('https://loki.test/loki/api/v1/push')
        expect(resolveLokiPushUrl('https://loki.test/loki/api/v1/push', node)).toBe(
            'https://loki.test/loki/api/v1/push'
        )
        expect(() => resolveLokiPushUrl('', node)).toThrow(NodeOperationError)
    })
})

describe('buildLokiPayload', () => {
    it('writes labels like the Loki node and the event as JSON line', () => {
        const payload = buildLokiPayload(
            { level: 'warn', event: 'odoo_nicht_erreichbar', message: 'weg', attempt: 1, httpStatus: 502 },
            {
                workflowId: 'wf1',
                workflowName: 'Odoo Kontakte',
                executionId: '123',
                nodeName: 'Partner suchen',
                model: 'res.partner',
                method: 'search_read',
                odooUrl: 'https://odoo.test'
            },
            1_700_000_000_000
        ) as { streams: Array<{ stream: Record<string, string>; values: [string, string, Record<string, string>][] }> }
        const [stream] = payload.streams
        expect(stream.stream).toEqual({
            job: 'n8n',
            workflow: 'Odoo Kontakte',
            workflow_id: 'wf1',
            stufe: 'odoo_verfuegbarkeit',
            level: 'warn'
        })
        const [timestamp, line, metadata] = stream.values[0]
        expect(timestamp).toBe('1700000000000000000')
        expect(metadata).toEqual({ execution_id: '123' })
        expect(JSON.parse(line)).toEqual({
            message: 'Odoo Kontakte / Partner suchen: weg',
            ereignis: 'odoo_nicht_erreichbar',
            node: 'Partner suchen',
            model: 'res.partner',
            methode: 'search_read',
            http_status: 502,
            versuch: 1,
            wartet_seit: null,
            odoo_url: 'https://odoo.test'
        })
    })

    it('omits the execution id when there is none', () => {
        const payload = buildLokiPayload(
            { level: 'info', event: 'odoo_wieder_erreichbar', message: 'da', attempt: 2 },
            { nodeName: 'X', model: 'm', method: 'read', odooUrl: 'https://o' },
            0
        ) as { streams: Array<{ stream: Record<string, string>; values: unknown[][] }> }
        expect(payload.streams[0].values[0][2]).toEqual({})
        expect(payload.streams[0].stream.workflow).toBe('')
    })
})
