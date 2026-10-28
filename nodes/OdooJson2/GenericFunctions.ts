import { type IDataObject, type INode, NodeOperationError } from 'n8n-workflow'

export type RetryMode = 'automatic' | 'always' | 'never'

export interface WaitSettings {
    maxWaitMs: number
    checkIntervalMs: number
    maxAttempts: number
    waitingLogIntervalMs: number
}

export interface OdooResponse {
    statusCode?: number
    statusMessage?: string
    body?: unknown
    headers?: IDataObject
}

export interface SendResult {
    response?: OdooResponse
    error?: unknown
}

export type Classification =
    | { kind: 'ok' }
    | { kind: 'unavailable'; notDelivered: boolean; reason: string }
    | { kind: 'failed'; message: string; name?: string }

export type LogLevel = 'info' | 'warn' | 'error'

export type OdooEvent =
    | 'odoo_nicht_erreichbar'
    | 'odoo_wartet'
    | 'odoo_wieder_erreichbar'
    | 'odoo_wartezeit_ueberschritten'
    | 'odoo_aufgegeben'
    | 'odoo_nicht_wiederholt'
    | 'odoo_weiterhin_nicht_erreichbar'

export interface LogEvent {
    level: LogLevel
    event: OdooEvent
    message: string
    attempt: number
    httpStatus?: number
    waitingSince?: string
}

export interface RequestTarget {
    odooUrl: string
    model: string
    method: string
    retryable: boolean
}

export interface WaitDependencies {
    send(): Promise<SendResult>
    isHealthy(): Promise<boolean>
    sleep(ms: number): Promise<void>
    now(): number
    log(event: LogEvent): Promise<void>
    isCancelled(): boolean
}

export type RequestOutcome =
    | { ok: true; response: OdooResponse }
    | { ok: false; message: string; httpStatus?: number; name?: string; odooUnavailable: boolean }

/**
 * Odoo URLs whose outage outlasted maxWaitMs in this n8n process, with the time the request gave up.
 * Without it every following request of a loop would wait the full maxWaitMs again.
 */
export type OutageRegistry = Map<string, number>

const READ_METHODS = new Set([
    'search_read',
    'read',
    'search',
    'search_count',
    'fields_get',
    'name_search',
    'read_group',
    'web_search_read',
    'web_read',
    'default_get',
    'check_access_rights',
    'context_get'
])

// nginx answers 405/503 itself before Odoo sees the request; a refused or unresolvable connection never reached it either.
const NOT_DELIVERED_STATUS = new Set([405, 503])
const NOT_DELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
// Odoo may already have executed the request when one of these comes back.
const UNCLEAR_STATUS = new Set([502, 504])
const UNCLEAR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'EPIPE'])

const MODEL_PATTERN = /^[a-z0-9_.]+$/
const METHOD_PATTERN = /^[a-z0-9_]+$/

export function isRetryable(method: string, mode: RetryMode): boolean {
    if (mode === 'always') return true
    if (mode === 'never') return false
    return READ_METHODS.has(method) || method === 'write'
}

function errorCode(error: unknown): string {
    if (!error || typeof error !== 'object') return ''
    const record = error as { code?: unknown; cause?: { code?: unknown } }
    return String(record.code ?? record.cause?.code ?? '')
}

function errorMessage(error: unknown): string {
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message
    }
    return 'unbekannter Fehler'
}

function odooErrorMessage(response: OdooResponse): { message: string; name?: string } {
    const body = response.body
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as { message?: unknown; name?: unknown }
        if (typeof record.message === 'string') {
            return { message: record.message, name: typeof record.name === 'string' ? record.name : undefined }
        }
    }
    if (typeof body === 'string' && body.trim()) {
        return { message: body.trim().slice(0, 300) }
    }
    return { message: `HTTP ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}` }
}

export function classify(result: SendResult): Classification {
    if (result.response) {
        const status = Number(result.response.statusCode)
        if (status >= 200 && status < 300) return { kind: 'ok' }
        if (NOT_DELIVERED_STATUS.has(status))
            return { kind: 'unavailable', notDelivered: true, reason: `HTTP ${status}` }
        if (UNCLEAR_STATUS.has(status)) return { kind: 'unavailable', notDelivered: false, reason: `HTTP ${status}` }
        return { kind: 'failed', ...odooErrorMessage(result.response) }
    }
    const code = errorCode(result.error)
    const message = errorMessage(result.error)
    if (NOT_DELIVERED_CODES.has(code)) return { kind: 'unavailable', notDelivered: true, reason: code }
    if (UNCLEAR_CODES.has(code) || /timeout|socket hang up/i.test(message)) {
        return { kind: 'unavailable', notDelivered: false, reason: code || message }
    }
    return { kind: 'failed', message }
}

function minutesBetween(from: number, to: number): number {
    return Math.round((to - from) / 60000)
}

function statusOf(result: SendResult): number | undefined {
    const status = Number(result.response?.statusCode)
    return Number.isFinite(status) && status > 0 ? status : undefined
}

/**
 * Sends one request and waits out an Odoo outage: on a not-delivered failure (or an unclear one for retryable
 * methods) it polls /web/health until it reports pass and then resends.
 */
export async function sendWithWaiting(
    deps: WaitDependencies,
    target: RequestTarget,
    settings: WaitSettings,
    outages: OutageRegistry
): Promise<RequestOutcome> {
    const label = `${target.model}/${target.method}`

    const gaveUpAt = outages.get(target.odooUrl)
    if (gaveUpAt !== undefined) {
        if (await deps.isHealthy()) {
            outages.delete(target.odooUrl)
        } else if (deps.now() - gaveUpAt < settings.maxWaitMs) {
            return {
                ok: false,
                odooUnavailable: true,
                message: `Odoo weiterhin nicht erreichbar (aufgegeben vor ${minutesBetween(gaveUpAt, deps.now())} min), ${label} nicht ausgefuehrt`
            }
        } else {
            outages.delete(target.odooUrl)
        }
    }

    let attempt = 0
    for (;;) {
        attempt++
        const result = await deps.send()
        const classification = classify(result)
        const httpStatus = statusOf(result)

        if (classification.kind === 'ok') {
            return { ok: true, response: result.response as OdooResponse }
        }
        if (classification.kind === 'failed') {
            return {
                ok: false,
                odooUnavailable: false,
                message: classification.message,
                name: classification.name,
                httpStatus
            }
        }

        const reason = classification.reason
        if (!classification.notDelivered && !target.retryable) {
            const message = `Odoo nicht erreichbar (${reason}) bei ${label}. Nicht wiederholt, weil die Anfrage schon ausgefuehrt sein kann: in Odoo pruefen`
            await deps.log({ level: 'error', event: 'odoo_nicht_wiederholt', message, attempt, httpStatus })
            return { ok: false, odooUnavailable: true, message, httpStatus }
        }
        if (attempt >= settings.maxAttempts) {
            const message = `Odoo nicht erreichbar (${reason}) bei ${label}, nach ${attempt} Versuchen aufgegeben`
            await deps.log({ level: 'error', event: 'odoo_aufgegeben', message, attempt, httpStatus })
            return { ok: false, odooUnavailable: true, message, httpStatus }
        }

        const waitingSince = deps.now()
        const since = new Date(waitingSince).toISOString()
        await deps.log({
            level: 'warn',
            event: 'odoo_nicht_erreichbar',
            message: `Odoo nicht erreichbar (${reason}) bei ${label}, Versuch ${attempt}, warte auf /web/health`,
            attempt,
            httpStatus,
            waitingSince: since
        })

        let lastLog = waitingSince
        for (;;) {
            if (deps.isCancelled()) {
                return {
                    ok: false,
                    odooUnavailable: true,
                    message: `Lauf abgebrochen, waehrend ${label} auf Odoo wartete`,
                    httpStatus
                }
            }
            await deps.sleep(settings.checkIntervalMs)
            if (await deps.isHealthy()) {
                await deps.log({
                    level: 'info',
                    event: 'odoo_wieder_erreichbar',
                    message: `Odoo wieder erreichbar nach ${minutesBetween(waitingSince, deps.now())} min, ${label} wird erneut geschickt`,
                    attempt,
                    httpStatus,
                    waitingSince: since
                })
                break
            }
            if (deps.now() - waitingSince >= settings.maxWaitMs) {
                outages.set(target.odooUrl, deps.now())
                const message = `Odoo seit ${minutesBetween(waitingSince, deps.now())} min nicht erreichbar (/web/health meldet kein pass), ${label} nicht ausgefuehrt`
                await deps.log({
                    level: 'error',
                    event: 'odoo_wartezeit_ueberschritten',
                    message,
                    attempt,
                    httpStatus,
                    waitingSince: since
                })
                return { ok: false, odooUnavailable: true, message, httpStatus }
            }
            if (deps.now() - lastLog >= settings.waitingLogIntervalMs) {
                lastLog = deps.now()
                await deps.log({
                    level: 'warn',
                    event: 'odoo_wartet',
                    message: `Odoo seit ${minutesBetween(waitingSince, deps.now())} min nicht erreichbar, ${label} wartet weiter`,
                    attempt,
                    httpStatus,
                    waitingSince: since
                })
            }
        }
    }
}

/** Splits a JSON-2 response the way the HTTP Request node does: one item per array entry, `{ data }` for scalars. */
export function toRecords(body: unknown): IDataObject[] {
    const entries = Array.isArray(body) ? body : [body]
    return entries.map(entry =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as IDataObject)
            : ({ data: entry } as IDataObject)
    )
}

export function normalizeOdooUrl(raw: string, node: INode, itemIndex: number): string {
    const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/\S+$/.test(trimmed)) {
        throw new NodeOperationError(node, `Odoo URL "${raw}" is not a valid http(s) URL`, { itemIndex })
    }
    return trimmed
}

export function validateTarget(model: string, method: string, node: INode, itemIndex: number): void {
    if (!MODEL_PATTERN.test(model)) {
        throw new NodeOperationError(node, `Model "${model}" is not a valid Odoo model name`, { itemIndex })
    }
    if (!METHOD_PATTERN.test(method)) {
        throw new NodeOperationError(node, `Method "${method}" is not a valid Odoo method name`, { itemIndex })
    }
}

export function parseBody(raw: unknown, node: INode, itemIndex: number): IDataObject {
    let value = raw
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return {}
        try {
            value = JSON.parse(trimmed)
        } catch {
            throw new NodeOperationError(node, 'Body is not valid JSON', { itemIndex })
        }
    }
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new NodeOperationError(node, 'Body must be a JSON object', { itemIndex })
    }
    return value as IDataObject
}

export function resolveLokiPushUrl(raw: string, node: INode): string {
    const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/\S+$/.test(trimmed)) {
        throw new NodeOperationError(node, `Loki URL "${raw}" is not a valid http(s) URL`)
    }
    return trimmed.endsWith('/loki/api/v1/push')
        ? trimmed
        : `${trimmed.replace(/\/loki\/api\/v1$/, '')}/loki/api/v1/push`
}

export interface LokiContext {
    workflowId?: string
    workflowName?: string
    executionId?: string
    nodeName: string
    model: string
    method: string
    odooUrl: string
}

/** Loki push body in the shape the Loki node writes: job/workflow labels, execution_id as structured metadata. */
export function buildLokiPayload(event: LogEvent, context: LokiContext, nowMs: number): IDataObject {
    const line = {
        message: `${context.workflowName ?? 'Workflow'} / ${context.nodeName}: ${event.message}`,
        ereignis: event.event,
        node: context.nodeName,
        model: context.model,
        methode: context.method,
        http_status: event.httpStatus ?? null,
        versuch: event.attempt,
        wartet_seit: event.waitingSince ?? null,
        odoo_url: context.odooUrl
    }
    const metadata: Record<string, string> = {}
    if (context.executionId) metadata.execution_id = context.executionId
    return {
        streams: [
            {
                stream: {
                    job: 'n8n',
                    workflow: context.workflowName ?? '',
                    workflow_id: context.workflowId ?? '',
                    stufe: 'odoo_verfuegbarkeit',
                    level: event.level
                },
                values: [[`${BigInt(nowMs) * 1_000_000n}`, JSON.stringify(line), metadata]]
            }
        ]
    }
}
