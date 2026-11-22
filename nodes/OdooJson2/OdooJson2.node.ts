import {
    type ICredentialDataDecryptedObject,
    type IDataObject,
    type IExecuteFunctions,
    type IHttpRequestOptions,
    type INodeExecutionData,
    type INodeType,
    type INodeTypeDescription,
    type JsonObject,
    NodeApiError,
    NodeConnectionTypes,
    NodeOperationError,
    sleep
} from 'n8n-workflow'
import {
    isRetryable,
    type LogEvent,
    normalizeOdooUrl,
    type OdooResponse,
    type OutageRegistry,
    parseBody,
    type RequestOutcome,
    type RetryMode,
    type SendResult,
    sendWithWaiting,
    toRecords,
    validateTarget,
    type WaitDependencies,
    type WaitSettings
} from './GenericFunctions'
import { odooJson2Properties } from './OdooJson2Description'

const outages: OutageRegistry = new Map()

const HEALTH_TIMEOUT_MS = 10000

function readSettings(this: IExecuteFunctions, itemIndex: number): WaitSettings & { timeoutMs: number } {
    const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject
    const positive = (value: unknown, fallback: number) =>
        Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    return {
        maxWaitMs: positive(options.maxWaitMinutes, 60) * 60000,
        checkIntervalMs: positive(options.checkIntervalSeconds, 30) * 1000,
        maxAttempts: positive(options.maxAttempts, 5),
        waitingLogIntervalMs: positive(options.waitingLogMinutes, 5) * 60000,
        timeoutMs: positive(options.timeoutSeconds, 120) * 1000
    }
}

async function isHealthy(this: IExecuteFunctions, odooUrl: string): Promise<boolean> {
    try {
        const response = (await this.helpers.httpRequest({
            method: 'GET',
            url: `${odooUrl}/web/health`,
            json: true,
            timeout: HEALTH_TIMEOUT_MS,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true
        })) as OdooResponse
        const body = response.body as { status?: unknown } | undefined
        return Number(response.statusCode) >= 200 && Number(response.statusCode) < 300 && body?.status === 'pass'
    } catch (error) {
        this.logger.debug(`Odoo health check ${odooUrl}/web/health failed: ${(error as Error).message}`)
        return false
    }
}

function toErrorItem(outcome: Extract<RequestOutcome, { ok: false }>, model: string, method: string): IDataObject {
    return {
        message: outcome.message,
        name: outcome.name ?? 'OdooJson2Error',
        status: outcome.httpStatus ?? null,
        httpCode: outcome.httpStatus === undefined ? null : String(outcome.httpStatus),
        odoo_nicht_erreichbar: outcome.odooUnavailable,
        model,
        methode: method
    }
}

interface ItemRequest {
    model: string
    method: string
    odooUrl: string
    database: string
    body: IDataObject
    retryMode: RetryMode
    output: string
    settings: WaitSettings & { timeoutMs: number }
}

function readItemRequest(
    this: IExecuteFunctions,
    itemIndex: number,
    credentials: ICredentialDataDecryptedObject,
    model: string,
    method: string
): ItemRequest {
    const node = this.getNode()
    validateTarget(model, method, node, itemIndex)
    const odooUrl = normalizeOdooUrl(
        String(this.getNodeParameter('odooUrl', itemIndex, '') || credentials.url || ''),
        node,
        itemIndex
    )
    const database = String(this.getNodeParameter('database', itemIndex, '') || credentials.database || '').trim()
    if (!database) {
        throw new NodeOperationError(node, 'Database is empty in the node and in the credential', { itemIndex })
    }
    return {
        model,
        method,
        odooUrl,
        database,
        body: parseBody(this.getNodeParameter('body', itemIndex, {}), node, itemIndex),
        retryMode: this.getNodeParameter('retryMode', itemIndex, 'automatic') as RetryMode,
        output: this.getNodeParameter('output', itemIndex, 'records') as string,
        settings: readSettings.call(this, itemIndex)
    }
}

function createDependencies(
    this: IExecuteFunctions,
    request: ItemRequest,
    logData: INodeExecutionData[],
    itemIndex: number
): WaitDependencies {
    const node = this.getNode()
    const workflow = this.getWorkflow()
    const httpRequest: IHttpRequestOptions = {
        method: 'POST',
        url: `${request.odooUrl}/json/2/${request.model}/${request.method}`,
        headers: { 'X-Odoo-Database': request.database },
        body: request.body,
        json: true,
        timeout: request.settings.timeoutMs,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true
    }
    return {
        send: async (): Promise<SendResult> => {
            try {
                const response = (await this.helpers.httpRequestWithAuthentication.call(
                    this,
                    'odooJson2Api',
                    httpRequest
                )) as OdooResponse
                return { response }
            } catch (error) {
                return { error }
            }
        },
        isHealthy: () => isHealthy.call(this, request.odooUrl),
        // n8n's sleep rejects only when the signal aborts; the waiting loop then returns its cancellation outcome.
        sleep: ms => sleep(ms, this.getExecutionCancelSignal?.()).catch(() => undefined),
        now: () => Date.now(),
        isCancelled: () => this.getExecutionCancelSignal?.()?.aborted === true,
        log: async (event: LogEvent) => {
            this.logger[event.level](`Odoo JSON-2 ${node.name}: ${event.event}: ${event.message}`)
            const inherited = this.getInputData()[itemIndex]?.json._lokiLogging
            logData.push({
                json: {
                    log: {
                        ...event,
                        timestamp: new Date().toISOString(),
                        workflow: workflow.name ?? '',
                        workflow_id: workflow.id ?? '',
                        execution_id: this.getExecutionId(),
                        node: node.name,
                        model: request.model,
                        method: request.method,
                        odoo_url: request.odooUrl
                    },
                    ...(inherited === undefined ? {} : { _lokiLogging: inherited })
                },
                pairedItem: { item: itemIndex }
            })
        }
    }
}

function toOutputItems(response: OdooResponse, output: string, itemIndex: number): INodeExecutionData[] {
    if (output === 'fullResponse') {
        return [
            {
                json: {
                    statusCode: response.statusCode ?? null,
                    headers: response.headers ?? {},
                    body: (response.body ?? null) as IDataObject
                },
                pairedItem: { item: itemIndex }
            }
        ]
    }
    return toRecords(response.body).map(record => ({ json: record, pairedItem: { item: itemIndex } }))
}

async function processItem(
    this: IExecuteFunctions,
    itemIndex: number,
    credentials: ICredentialDataDecryptedObject,
    model: string,
    method: string,
    logData: INodeExecutionData[]
): Promise<INodeExecutionData[]> {
    const request = readItemRequest.call(this, itemIndex, credentials, model, method)
    const outcome = await sendWithWaiting(
        createDependencies.call(this, request, logData, itemIndex),
        { odooUrl: request.odooUrl, model, method, retryable: isRetryable(method, request.retryMode) },
        request.settings,
        outages
    )
    if (outcome.ok) {
        return toOutputItems(outcome.response, request.output, itemIndex)
    }
    const error = toErrorItem(outcome, model, method)
    if (this.continueOnFail()) {
        return [{ json: { error }, pairedItem: { item: itemIndex } }]
    }
    throw new NodeApiError(this.getNode(), error as JsonObject, {
        message: outcome.message,
        httpCode: (error.httpCode as string | null) ?? undefined,
        itemIndex
    })
}

export class OdooJson2 implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Odoo JSON-2',
        name: 'odooJson2',
        icon: {
            light: 'file:odoo.svg',
            dark: 'file:odoo.dark.svg'
        },
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["model"] + " / " + $parameter["method"]}}',
        description: 'Call the Odoo JSON-2 API and wait out Odoo outages',
        defaults: {
            name: 'Odoo JSON-2'
        },
        usableAsTool: true,
        inputs: [NodeConnectionTypes.Main],
        outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
        outputNames: ['Results', 'Outage Logs'],
        credentials: [{ name: 'odooJson2Api', required: true }],
        properties: odooJson2Properties
    }

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData()
        const returnData: INodeExecutionData[] = []
        const logData: INodeExecutionData[] = []
        const credentials = await this.getCredentials('odooJson2Api')
        const node = this.getNode()

        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            const model = String(this.getNodeParameter('model', itemIndex, '')).trim()
            const method = String(this.getNodeParameter('method', itemIndex, '')).trim()
            try {
                const results = await processItem.call(this, itemIndex, credentials, model, method, logData)
                for (const result of results) returnData.push(result)
            } catch (error) {
                if (this.continueOnFail() && !(error instanceof NodeApiError)) {
                    returnData.push({
                        json: { error: { message: (error as Error).message, model, methode: method } },
                        pairedItem: { item: itemIndex }
                    })
                    continue
                }
                throw error instanceof NodeApiError || error instanceof NodeOperationError
                    ? error
                    : new NodeOperationError(node, error as Error, { itemIndex })
            }
        }

        return [returnData, logData]
    }
}
