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
    | 'unavailable'
    | 'waiting'
    | 'recovered'
    | 'wait_timeout'
    | 'attempts_exhausted'
    | 'not_retried'
    | 'still_unavailable'

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
    const code = record.code ?? record.cause?.code
    return typeof code === 'string' ? code : ''
}

function errorMessage(error: unknown): string {
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message
    }
    return 'Unknown error'
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
    const suffix = response.statusMessage ? ' ' + response.statusMessage : ''
    return { message: `HTTP ${response.statusCode}${suffix}` }
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

function cancellationOutcome(deps: WaitDependencies, label: string, httpStatus?: number): RequestOutcome | undefined {
    if (!deps.isCancelled()) return undefined
    return {
        ok: false,
        odooUnavailable: false,
        message: `Execution cancelled before completing ${label}`,
        httpStatus
    }
}

/** Fails at once while an outage this process already gave up on is still going on. */
async function checkRememberedOutage(
    deps: WaitDependencies,
    target: RequestTarget,
    outages: OutageRegistry,
    label: string
): Promise<RequestOutcome | undefined> {
    const gaveUpAt = outages.get(target.odooUrl)
    if (gaveUpAt === undefined) return undefined
    const healthy = await deps.isHealthy()
    const cancelled = cancellationOutcome(deps, label)
    if (cancelled) return cancelled
    if (!healthy) {
        const minutes = minutesBetween(gaveUpAt, deps.now())
        const message = `Odoo is still unavailable (gave up ${minutes} min ago); ${label} was not sent`
        await deps.log({ level: 'error', event: 'still_unavailable', message, attempt: 0 })
        return {
            ok: false,
            odooUnavailable: true,
            message
        }
    }
    outages.delete(target.odooUrl)
    return undefined
}

function giveUpReason(
    classification: Extract<Classification, { kind: 'unavailable' }>,
    target: RequestTarget,
    attempt: number,
    settings: WaitSettings,
    label: string
): { event: OdooEvent; message: string } | undefined {
    const reason = classification.reason
    if (!classification.notDelivered && !target.retryable) {
        return {
            event: 'not_retried',
            message: `Odoo is unavailable (${reason}) for ${label}. Not retried because the request may already have been executed; check the result in Odoo`
        }
    }
    if (attempt >= settings.maxAttempts) {
        return {
            event: 'attempts_exhausted',
            message: `Odoo is unavailable (${reason}) for ${label}; gave up after ${attempt} attempts`
        }
    }
    return undefined
}

interface WaitContext {
    label: string
    reason: string
    attempt: number
    httpStatus?: number
    waitingSince: number
}

/** Polls /web/health until it passes. Returns undefined once Odoo is back, otherwise the failed outcome. */
async function waitForRecovery(
    deps: WaitDependencies,
    target: RequestTarget,
    settings: WaitSettings,
    outages: OutageRegistry,
    context: WaitContext
): Promise<RequestOutcome | undefined> {
    const { label, attempt, httpStatus, waitingSince } = context
    const deadline = waitingSince + settings.maxWaitMs
    const base = { attempt, httpStatus, waitingSince: new Date(waitingSince).toISOString() }
    await deps.log({
        ...base,
        level: 'warn',
        event: 'unavailable',
        message: `Odoo is unavailable (${context.reason}) for ${label}, attempt ${attempt}; waiting for /web/health`
    })

    let lastLog = deps.now()
    for (;;) {
        const cancelled = cancellationOutcome(deps, label, httpStatus)
        if (cancelled) return cancelled
        const remaining = deadline - deps.now()
        if (remaining <= 0) {
            outages.set(target.odooUrl, deps.now())
            const minutes = minutesBetween(waitingSince, deps.now())
            const message = `Odoo did not recover within ${minutes} min; stopped retrying ${label}. Check Odoo before repeating requests that may have been executed`
            await deps.log({ ...base, level: 'error', event: 'wait_timeout', message })
            return { ok: false, odooUnavailable: true, message, httpStatus }
        }
        await deps.sleep(Math.min(settings.checkIntervalMs, remaining))
        if (deps.isCancelled()) continue
        // The last sleep ends at the deadline; its health check still counts, even if the request returns late.
        const healthy = await deps.isHealthy()
        if (deps.isCancelled()) continue
        if (healthy) {
            outages.delete(target.odooUrl)
            await deps.log({
                ...base,
                level: 'info',
                event: 'recovered',
                message: `Odoo recovered after ${minutesBetween(waitingSince, deps.now())} min; retrying ${label}`
            })
            return undefined
        }
        if (deps.now() - lastLog >= settings.waitingLogIntervalMs) {
            lastLog = deps.now()
            await deps.log({
                ...base,
                level: 'warn',
                event: 'waiting',
                message: `Odoo has been unavailable for ${minutesBetween(waitingSince, deps.now())} min; ${label} is still waiting`
            })
        }
    }
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
    const cancelled = cancellationOutcome(deps, label)
    if (cancelled) return cancelled
    const remembered = await checkRememberedOutage(deps, target, outages, label)
    if (remembered) return remembered

    let waitingSince: number | undefined
    for (let attempt = 1; ; attempt++) {
        const stoppedBeforeSend = cancellationOutcome(deps, label)
        if (stoppedBeforeSend) return stoppedBeforeSend
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

        const giveUp = giveUpReason(classification, target, attempt, settings, label)
        if (giveUp) {
            await deps.log({ level: 'error', event: giveUp.event, message: giveUp.message, attempt, httpStatus })
            return { ok: false, odooUnavailable: true, message: giveUp.message, httpStatus }
        }

        waitingSince ??= deps.now()
        const stopped = await waitForRecovery(deps, target, settings, outages, {
            label,
            reason: classification.reason,
            attempt,
            httpStatus,
            waitingSince
        })
        if (stopped) return stopped
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

/** Trimmed http(s) URL without trailing slashes, or undefined. A loop instead of /\/+$/ avoids regex backtracking. */
function toHttpUrl(raw: string): string | undefined {
    let value = (raw ?? '').trim()
    while (value.endsWith('/')) value = value.slice(0, -1)
    try {
        const url = new URL(value)
        // The parser reports an empty query or fragment ("https://odoo.test?") as '', so check the raw value too.
        if (url.username || url.password || /[?#]/.test(value)) return undefined
        return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
    } catch {
        return undefined
    }
}

export function normalizeOdooUrl(raw: string, node: INode, itemIndex: number): string {
    const url = toHttpUrl(raw)
    if (!url) {
        throw new NodeOperationError(
            node,
            'Odoo URL must be an HTTP(S) base URL without credentials, query parameters or a fragment',
            { itemIndex }
        )
    }
    return url
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
