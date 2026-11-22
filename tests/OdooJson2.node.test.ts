import type { IExecuteFunctions, INode } from 'n8n-workflow'
import { NodeApiError, NodeOperationError } from 'n8n-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OdooJson2 } from '../nodes/OdooJson2/OdooJson2.node'
import codex from '../nodes/OdooJson2/OdooJson2.node.json'
import pkg from '../package.json'

interface StubOptions {
    params?: Array<Record<string, unknown>>
    items?: number
    credentials?: Record<string, unknown>
    odoo: (options?: Record<string, unknown>) => Promise<unknown>
    health?: (options?: Record<string, unknown>) => Promise<unknown>
    continueOnFail?: boolean
    cancelSignal?: AbortSignal
    inputJson?: Record<string, unknown>
}

const BASE_PARAMS = {
    odooUrl: '',
    database: '',
    model: 'res.partner',
    method: 'search_read',
    body: '{"domain": [], "fields": ["name"]}',
    retryMode: 'automatic',
    output: 'records',
    options: { checkIntervalSeconds: 1, maxWaitMinutes: 1 }
}

function stub(opts: StubOptions) {
    const node: INode = {
        id: '1',
        name: 'Find Partners',
        type: 'odooJson2',
        typeVersion: 1,
        position: [0, 0],
        parameters: {}
    }
    const items = Array.from({ length: opts.items ?? 1 }, (_, i) => ({ json: { i, ...opts.inputJson } }))
    const credentialsByType: Record<string, Record<string, unknown>> = {
        odooJson2Api: opts.credentials ?? { url: 'https://odoo.test/', database: 'db1', apiKey: 'k' }
    }
    const httpRequestWithAuthentication = vi.fn(async (type: string, options: Record<string, unknown>) =>
        type === 'odooJson2Api' ? opts.odoo(options) : Promise.reject(new Error('Unexpected credential type'))
    )
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }
    const context = {
        getInputData: () => items,
        getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
            const params = { ...BASE_PARAMS, ...(opts.params?.[itemIndex] ?? opts.params?.[0] ?? {}) } as Record<
                string,
                unknown
            >
            return name in params ? params[name] : fallback
        },
        getCredentials: vi.fn(async (type: string) => credentialsByType[type]),
        getNode: () => node,
        getWorkflow: () => ({ id: 'wf1', name: 'Odoo Contacts', active: true }),
        getExecutionId: () => '42',
        getExecutionCancelSignal: () => opts.cancelSignal,
        continueOnFail: () => opts.continueOnFail === true,
        logger,
        helpers: {
            httpRequestWithAuthentication,
            httpRequest: opts.health ?? vi.fn(async () => ({ statusCode: 200, body: { status: 'pass' } }))
        }
    }
    return { context: context as unknown as IExecuteFunctions, httpRequestWithAuthentication, logger }
}

describe('OdooJson2 node', () => {
    it('is registered in package.json and the codex', () => {
        const instance = new OdooJson2()
        expect(pkg.n8n.nodes).toContain('dist/nodes/OdooJson2/OdooJson2.node.js')
        expect(codex.node).toBe(`${pkg.name}.${instance.description.name}`)
        expect(instance.description.credentials?.map(c => c.name)).toEqual(['odooJson2Api'])
    })

    it('sends the JSON-2 request and splits the records', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 200, body: [{ id: 1 }, { id: 2 }] }))
        const { context, httpRequestWithAuthentication } = stub({ odoo })
        const [out] = await new OdooJson2().execute.call(context)

        expect(out).toEqual([
            { json: { id: 1 }, pairedItem: { item: 0 } },
            { json: { id: 2 }, pairedItem: { item: 0 } }
        ])
        expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
            'odooJson2Api',
            expect.objectContaining({
                method: 'POST',
                url: 'https://odoo.test/json/2/res.partner/search_read',
                headers: { 'X-Odoo-Database': 'db1' },
                body: { domain: [], fields: ['name'] },
                returnFullResponse: true,
                ignoreHttpStatusErrors: true,
                timeout: 120000
            })
        )
    })

    it('prefers URL and database from the node over the credential', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 200, body: true }))
        const { context, httpRequestWithAuthentication } = stub({
            odoo,
            params: [{ odooUrl: 'https://other.test', database: 'db2', method: 'write', body: { ids: [1], vals: {} } }]
        })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out).toEqual([{ json: { data: true }, pairedItem: { item: 0 } }])
        expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
            'odooJson2Api',
            expect.objectContaining({
                url: 'https://other.test/json/2/res.partner/write',
                headers: { 'X-Odoo-Database': 'db2' }
            })
        )
    })

    it('keeps item pairing across several inputs', async () => {
        const odoo = vi
            .fn()
            .mockResolvedValueOnce({ statusCode: 200, body: [{ id: 1 }] })
            .mockResolvedValueOnce({ statusCode: 200, body: [] })
            .mockResolvedValueOnce({ statusCode: 200, body: [{ id: 3 }] })
        const { context } = stub({ odoo, items: 3 })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out).toEqual([
            { json: { id: 1 }, pairedItem: { item: 0 } },
            { json: { id: 3 }, pairedItem: { item: 2 } }
        ])
    })

    it('returns large record sets without exceeding the JavaScript argument limit', async () => {
        const records = Array.from({ length: 150000 }, (_, id) => ({ id }))
        const { context } = stub({ odoo: async () => ({ statusCode: 200, body: records }) })
        const [out] = await new OdooJson2().execute.call(context)

        expect(out).toHaveLength(records.length)
        expect(out[0]).toEqual({ json: { id: 0 }, pairedItem: { item: 0 } })
        expect(out.at(-1)).toEqual({ json: { id: records.length - 1 }, pairedItem: { item: 0 } })
    })

    it('returns the full response when asked to', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 200, headers: { a: '1' }, body: [] }))
        const { context } = stub({ odoo, params: [{ output: 'fullResponse' }] })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out).toEqual([{ json: { statusCode: 200, headers: { a: '1' }, body: [] }, pairedItem: { item: 0 } }])
    })

    it('emits an error item on continueOnFail, like the HTTP Request node', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 422, body: { name: 'ValidationError', message: 'Name fehlt' } }))
        const { context } = stub({ odoo, continueOnFail: true })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out).toEqual([
            {
                json: {
                    error: {
                        message: 'Name fehlt',
                        name: 'ValidationError',
                        status: 422,
                        httpCode: '422',
                        odoo_nicht_erreichbar: false,
                        model: 'res.partner',
                        methode: 'search_read'
                    }
                },
                pairedItem: { item: 0 }
            }
        ])
    })

    it('throws a NodeApiError without continueOnFail', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 403, body: { message: 'Access denied' } }))
        const { context } = stub({ odoo })
        await expect(new OdooJson2().execute.call(context)).rejects.toBeInstanceOf(NodeApiError)
    })

    it('reports invalid input as NodeOperationError or error item', async () => {
        const odoo = vi.fn()
        const failing = stub({ odoo, params: [{ model: 'res partner' }] })
        await expect(new OdooJson2().execute.call(failing.context)).rejects.toBeInstanceOf(NodeOperationError)

        const tolerant = stub({ odoo, params: [{ body: '{' }], continueOnFail: true })
        const [out] = await new OdooJson2().execute.call(tolerant.context)
        expect(out[0].json.error).toMatchObject({ message: 'Body is not valid JSON', model: 'res.partner' })

        const noDatabase = stub({ odoo, credentials: { url: 'https://odoo.test', apiKey: 'k' } })
        await expect(new OdooJson2().execute.call(noDatabase.context)).rejects.toThrow(/Database is empty/)
        expect(odoo).not.toHaveBeenCalled()
    })

    it('emits paired outage and recovery events without accessing Loki credentials', async () => {
        const odoo = vi
            .fn()
            .mockResolvedValueOnce({ statusCode: 405, body: '<html>' })
            .mockResolvedValueOnce({ statusCode: 200, body: [{ id: 9 }] })
        const health = vi.fn(async () => ({ statusCode: 200, body: { status: 'pass' } }))
        const inherited = { enabled: false, labels: { env: 'test' } }
        const { context, httpRequestWithAuthentication, logger } = stub({
            odoo,
            health,
            inputJson: { _lokiLogging: inherited },
            params: [{ method: 'create', options: { checkIntervalSeconds: 0.001 } }]
        })
        const [out, logs] = await new OdooJson2().execute.call(context)
        expect(out).toEqual([{ json: { id: 9 }, pairedItem: { item: 0 } }])
        expect(health).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://odoo.test/web/health' }))
        expect(logs).toHaveLength(2)
        expect(logs[0]).toMatchObject({
            json: {
                log: {
                    event: 'unavailable',
                    level: 'warn',
                    httpStatus: 405,
                    attempt: 1,
                    node: 'Find Partners',
                    model: 'res.partner',
                    method: 'create',
                    workflow: 'Odoo Contacts',
                    workflow_id: 'wf1',
                    execution_id: '42',
                    odoo_url: 'https://odoo.test',
                    timestamp: expect.any(String)
                },
                _lokiLogging: inherited
            },
            pairedItem: { item: 0 }
        })
        expect(logs[1].json.log).toMatchObject({ event: 'recovered', level: 'info' })
        expect(context.getCredentials).toHaveBeenCalledExactlyOnceWith('odooJson2Api')
        expect(httpRequestWithAuthentication.mock.calls.every(([type]) => type === 'odooJson2Api')).toBe(true)
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'))
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('recovered'))
    })

    it('emits the final outage event on Continue without retrying a create', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 502, body: '' }))
        const { context, logger } = stub({ odoo, continueOnFail: true, params: [{ method: 'create' }] })
        const [out, logs] = await new OdooJson2().execute.call(context)
        expect(out[0].json.error).toMatchObject({ odoo_nicht_erreichbar: true, status: 502 })
        expect(logs[0].json.log).toMatchObject({ event: 'not_retried', level: 'error' })
        expect(logs[0].json).not.toHaveProperty('_lokiLogging')
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not_retried'))
        expect(odoo).toHaveBeenCalledTimes(1)
    })

    it('keeps the log output empty when there is no outage', async () => {
        const { context } = stub({ odoo: async () => ({ statusCode: 200, body: [] }) })
        expect(await new OdooJson2().execute.call(context)).toEqual([[], []])
    })

    it('keeps logs paired with each input even when recovery returns no records', async () => {
        const odoo = vi
            .fn()
            .mockResolvedValueOnce({ statusCode: 200, body: [{ id: 1 }] })
            .mockResolvedValueOnce({ statusCode: 503 })
            .mockResolvedValueOnce({ statusCode: 200, body: [] })
        const { context } = stub({ odoo, items: 2, params: [{ options: { checkIntervalSeconds: 0.001 } }] })
        const [out, logs] = await new OdooJson2().execute.call(context)
        expect(out).toHaveLength(1)
        expect(logs).toHaveLength(2)
        expect(logs.every(item => (item.pairedItem as { item: number }).item === 1)).toBe(true)
    })

    it('returns an empty full response body as null', async () => {
        const { context } = stub({ odoo: async () => ({ statusCode: 204 }), params: [{ output: 'fullResponse' }] })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out[0].json).toEqual({ statusCode: 204, headers: {}, body: null })
    })

    it('handles transport errors without a status as n8n errors or Continue items', async () => {
        const odoo = async () => {
            throw new Error('TLS certificate expired')
        }
        const strict = stub({ odoo })
        await expect(new OdooJson2().execute.call(strict.context)).rejects.toBeInstanceOf(NodeApiError)
        const tolerant = stub({ odoo, continueOnFail: true })
        const [out] = await new OdooJson2().execute.call(tolerant.context)
        expect(out[0].json.error).toMatchObject({ message: 'TLS certificate expired', status: null, httpCode: null })
    })

    it('rejects missing credential URLs before sending a request', async () => {
        const odoo = vi.fn()
        const { context } = stub({ odoo, credentials: { database: 'db1' } })
        await expect(new OdooJson2().execute.call(context)).rejects.toBeInstanceOf(NodeOperationError)
        expect(odoo).not.toHaveBeenCalled()
    })

    it('handles refused connections and failed health checks before recovering', async () => {
        const odoo = vi
            .fn()
            .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
            .mockResolvedValueOnce({ statusCode: 200, body: true })
        const health = vi
            .fn()
            .mockRejectedValueOnce(new Error('Connection refused'))
            .mockResolvedValueOnce({ statusCode: 503, body: { status: 'pass' } })
            .mockResolvedValueOnce({ statusCode: 200, body: { status: 'fail' } })
            .mockResolvedValueOnce({ statusCode: 200, body: { status: 'pass' } })
        const { context, logger } = stub({ odoo, health, params: [{ options: { checkIntervalSeconds: 0.001 } }] })
        const [out, logs] = await new OdooJson2().execute.call(context)
        expect(out[0].json).toEqual({ data: true })
        expect(health).toHaveBeenCalledTimes(4)
        expect(odoo).toHaveBeenCalledTimes(2)
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('health check'))
        expect(logs.map(item => (item.json.log as { event: string }).event)).toEqual(['unavailable', 'recovered'])
    })

    it('interrupts the polling sleep when the execution is cancelled', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const health = vi.fn()
        const odoo = vi.fn(async () => ({ statusCode: 503 }))
        const { context } = stub({ odoo, health, cancelSignal: controller.signal })
        const failure = new OdooJson2().execute.call(context).then(
            () => undefined,
            (error: unknown) => error
        )
        await vi.advanceTimersByTimeAsync(0)
        controller.abort(new Error('Execution cancelled'))
        const error = await failure
        expect(error).toBeInstanceOf(NodeApiError)
        expect((error as NodeApiError).message).toContain('cancelled')
        expect(health).not.toHaveBeenCalled()
        expect(odoo).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('wraps unexpected runtime errors in a NodeOperationError', async () => {
        const { context, logger } = stub({ odoo: async () => ({ statusCode: 503 }) })
        logger.warn.mockImplementation(() => {
            throw new Error('logger unavailable')
        })
        const failure = await new OdooJson2().execute.call(context).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(NodeOperationError)
        expect((failure as NodeOperationError).message).toBe('logger unavailable')
    })

    it('returns a regular error item when a cancelled wait runs with Continue', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const odoo = vi.fn(async () => ({ statusCode: 503 }))
        const { context } = stub({ odoo, continueOnFail: true, cancelSignal: controller.signal })
        const execution = new OdooJson2().execute.call(context)
        await vi.advanceTimersByTimeAsync(0)
        controller.abort(new Error('Execution cancelled'))
        const [out] = await execution
        expect(out[0].json.error).toMatchObject({
            message: expect.stringContaining('cancelled'),
            status: 503,
            odoo_nicht_erreichbar: false,
            methode: 'search_read'
        })
    })

    it('uses finite default timeouts for invalid expression values', async () => {
        const { context, httpRequestWithAuthentication } = stub({
            odoo: async () => ({ statusCode: 200, body: true }),
            params: [{ options: { timeoutSeconds: Infinity } }]
        })
        await new OdooJson2().execute.call(context)
        expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
            'odooJson2Api',
            expect.objectContaining({ timeout: 120000 })
        )
    })
})

afterEach(() => {
    vi.useRealTimers()
})
