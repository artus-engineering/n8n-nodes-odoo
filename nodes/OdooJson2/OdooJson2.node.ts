import {
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
    buildLokiPayload,
    isRetryable,
    type LogEvent,
    normalizeOdooUrl,
    type OdooResponse,
    type OutageRegistry,
    parseBody,
    type RequestOutcome,
    type RetryMode,
    resolveLokiPushUrl,
    type SendResult,
    sendWithWaiting,
    toRecords,
    validateTarget,
    type WaitSettings
} from './GenericFunctions'
import { odooJson2Properties } from './OdooJson2Description'

const outages: OutageRegistry = new Map()

const HEALTH_TIMEOUT_MS = 10000
const LOKI_TIMEOUT_MS = 10000

function readSettings(this: IExecuteFunctions, itemIndex: number): WaitSettings & { timeoutMs: number } {
    const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject
    const positive = (value: unknown, fallback: number) => (Number(value) > 0 ? Number(value) : fallback)
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
        })) as { body?: { status?: unknown } }
        return response.body?.status === 'pass'
    } catch (error) {
        this.logger.debug(`Odoo health check ${odooUrl}/web/health failed: ${(error as Error).message}`)
        return false
    }
}

async function pushToLoki(this: IExecuteFunctions, pushUrl: string, payload: IDataObject): Promise<void> {
    try {
        await this.helpers.httpRequestWithAuthentication.call(this, 'odooLokiApi', {
            method: 'POST',
            url: pushUrl,
            body: payload,
            json: true,
            timeout: LOKI_TIMEOUT_MS
        })
    } catch (error) {
        // An unreachable Loki must not break the Odoo call; n8n's own log keeps the trace.
        this.logger.warn(`Odoo JSON-2: Loki push failed: ${(error as Error).message}`)
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
        outputs: [NodeConnectionTypes.Main],
        credentials: [
            { name: 'odooJson2Api', required: true },
            { name: 'odooLokiApi', required: true, displayOptions: { show: { lokiLogging: [true] } } }
        ],
        properties: odooJson2Properties
    }

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData()
        const returnData: INodeExecutionData[] = []
        const credentials = await this.getCredentials('odooJson2Api')
        const node = this.getNode()
        const workflow = this.getWorkflow()

        let lokiPushUrl: string | undefined
        if (this.getNodeParameter('lokiLogging', 0, false) === true) {
            const lokiCredentials = await this.getCredentials('odooLokiApi')
            lokiPushUrl = resolveLokiPushUrl(lokiCredentials.url as string, node)
        }

        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            const model = String(this.getNodeParameter('model', itemIndex, '')).trim()
            const method = String(this.getNodeParameter('method', itemIndex, '')).trim()
            try {
                validateTarget(model, method, node, itemIndex)
                const odooUrl = normalizeOdooUrl(
                    String(this.getNodeParameter('odooUrl', itemIndex, '') || credentials.url || ''),
                    node,
                    itemIndex
                )
                const database = String(this.getNodeParameter('database', itemIndex, '') || credentials.database || '')
                if (!database.trim()) {
                    throw new NodeOperationError(node, 'Database is empty in the node and in the credential', {
                        itemIndex
                    })
                }
                const body = parseBody(this.getNodeParameter('body', itemIndex, {}), node, itemIndex)
                const retryMode = this.getNodeParameter('retryMode', itemIndex, 'automatic') as RetryMode
                const output = this.getNodeParameter('output', itemIndex, 'records') as string
                const settings = readSettings.call(this, itemIndex)

                const request: IHttpRequestOptions = {
                    method: 'POST',
                    url: `${odooUrl}/json/2/${model}/${method}`,
                    headers: { 'X-Odoo-Database': database.trim() },
                    body,
                    json: true,
                    timeout: settings.timeoutMs,
                    returnFullResponse: true,
                    ignoreHttpStatusErrors: true
                }

                const outcome = await sendWithWaiting(
                    {
                        send: async (): Promise<SendResult> => {
                            try {
                                const response = (await this.helpers.httpRequestWithAuthentication.call(
                                    this,
                                    'odooJson2Api',
                                    request
                                )) as OdooResponse
                                return { response }
                            } catch (error) {
                                return { error }
                            }
                        },
                        isHealthy: () => isHealthy.call(this, odooUrl),
                        sleep: ms => sleep(ms),
                        now: () => Date.now(),
                        isCancelled: () => this.getExecutionCancelSignal?.()?.aborted === true,
                        log: async (event: LogEvent) => {
                            this.logger.warn(`Odoo JSON-2 ${node.name}: ${event.event}: ${event.message}`)
                            if (lokiPushUrl) {
                                await pushToLoki.call(
                                    this,
                                    lokiPushUrl,
                                    buildLokiPayload(
                                        event,
                                        {
                                            workflowId: workflow.id,
                                            workflowName: workflow.name,
                                            executionId: this.getExecutionId(),
                                            nodeName: node.name,
                                            model,
                                            method,
                                            odooUrl
                                        },
                                        Date.now()
                                    )
                                )
                            }
                        }
                    },
                    { odooUrl, model, method, retryable: isRetryable(method, retryMode) },
                    settings,
                    outages
                )

                if (!outcome.ok) {
                    const error = toErrorItem(outcome, model, method)
                    if (this.continueOnFail()) {
                        returnData.push({ json: { error }, pairedItem: { item: itemIndex } })
                        continue
                    }
                    throw new NodeApiError(node, error as JsonObject, {
                        message: outcome.message,
                        httpCode: (error.httpCode as string | null) ?? undefined,
                        itemIndex
                    })
                }

                if (output === 'fullResponse') {
                    returnData.push({
                        json: {
                            statusCode: outcome.response.statusCode ?? null,
                            headers: outcome.response.headers ?? {},
                            body: (outcome.response.body ?? null) as IDataObject
                        },
                        pairedItem: { item: itemIndex }
                    })
                    continue
                }
                for (const record of toRecords(outcome.response.body)) {
                    returnData.push({ json: record, pairedItem: { item: itemIndex } })
                }
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

        return [returnData]
    }
}
