import type { IExecuteFunctions, INode } from 'n8n-workflow'
import { NodeApiError, NodeOperationError } from 'n8n-workflow'
import { describe, expect, it, vi } from 'vitest'
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
}

const BASE_PARAMS = {
    odooUrl: '',
    database: '',
    model: 'res.partner',
    method: 'search_read',
    body: '{"domain": [], "fields": ["name"]}',
    retryMode: 'automatic',
    output: 'records',
    lokiLogging: false,
    options: { checkIntervalSeconds: 1, maxWaitMinutes: 1 }
}

function stub(opts: StubOptions) {
    const node: INode = {
        id: '1',
        name: 'Partner suchen',
        type: 'odooJson2',
        typeVersion: 1,
        position: [0, 0],
        parameters: {}
    }
    const items = Array.from({ length: opts.items ?? 1 }, (_, i) => ({ json: { i } }))
    const credentialsByType: Record<string, Record<string, unknown>> = {
        odooJson2Api: opts.credentials ?? { url: 'https://odoo.test/', database: 'db1', apiKey: 'k' },
        odooLokiApi: { url: 'https://loki.test' }
    }
    const httpRequestWithAuthentication = vi.fn(async (type: string, options: Record<string, unknown>) =>
        type === 'odooJson2Api' ? opts.odoo(options) : { ok: true }
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
        getWorkflow: () => ({ id: 'wf1', name: 'Odoo Kontakte', active: true }),
        getExecutionId: () => '42',
        getExecutionCancelSignal: () => undefined,
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
        expect(instance.description.credentials?.map(c => c.name)).toEqual(['odooJson2Api', 'odooLokiApi'])
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

    it('waits for /web/health after a 405, resends and logs to Loki', async () => {
        const odoo = vi
            .fn()
            .mockResolvedValueOnce({ statusCode: 405, body: '<html>' })
            .mockResolvedValueOnce({ statusCode: 200, body: [{ id: 9 }] })
        const health = vi.fn(async () => ({ statusCode: 200, body: { status: 'pass' } }))
        const { context, httpRequestWithAuthentication, logger } = stub({
            odoo,
            health,
            params: [{ lokiLogging: true, method: 'create', options: { checkIntervalSeconds: 0.001 } }]
        })
        const [out] = await new OdooJson2().execute.call(context)

        expect(out).toEqual([{ json: { id: 9 }, pairedItem: { item: 0 } }])
        expect(health).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://odoo.test/web/health' }))
        const lokiCalls = httpRequestWithAuthentication.mock.calls.filter(([type]) => type === 'odooLokiApi')
        expect(lokiCalls).toHaveLength(2)
        expect(lokiCalls[0][1]).toMatchObject({ url: 'https://loki.test/loki/api/v1/push', method: 'POST' })
        const line = JSON.parse(
            (lokiCalls[0][1] as { body: { streams: Array<{ values: string[][] }> } }).body.streams[0].values[0][1]
        )
        expect(line).toMatchObject({ ereignis: 'odoo_nicht_erreichbar', node: 'Partner suchen', http_status: 405 })
        expect(logger.warn).toHaveBeenCalled()
    })

    it('treats an unreachable health endpoint as not healthy and survives a failing Loki push', async () => {
        const odoo = vi.fn(async () => ({ statusCode: 502, body: '' }))
        const health = vi.fn(async () => {
            throw new Error('ECONNREFUSED')
        })
        const { context, httpRequestWithAuthentication, logger } = stub({
            odoo,
            health,
            continueOnFail: true,
            params: [{ lokiLogging: true, method: 'create' }]
        })
        httpRequestWithAuthentication.mockImplementation(async (type: string) => {
            if (type === 'odooLokiApi') throw new Error('loki down')
            return odoo()
        })
        const [out] = await new OdooJson2().execute.call(context)
        expect(out[0].json.error).toMatchObject({ odoo_nicht_erreichbar: true, status: 502 })
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Loki push failed'))
        expect(health).not.toHaveBeenCalled()
    })
})
