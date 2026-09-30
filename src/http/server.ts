/**
 * The local HTTP channel: a second front door into the same agent, for an app
 * on the same machine (the Ghina web app). Contract: docs/http-channel.md.
 *
 * Deliberately small and deliberately local: bound to 127.0.0.1 by default,
 * one bearer token, JSON in and out, Node's own http module. Everything the
 * agent does still goes through dispatch — this file only translates.
 */

import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { cancelHttpReminder, chatIdentity, ChatKeyForbidden, httpHistory, httpModel, httpReminders, isChatKey,
         isModelName, resetHttpChat, runHttpTurn, setHttpModel } from './chat.ts'
import { contentTypeFor, MAX_CHAT_BODY_BYTES, mediaRoots, parseMedia, resolveMedia, saveMedia } from './media.ts'
import { summarizeUsage, windowStart } from '../core/usage.ts'
import { DEFAULT_COMMIT_MESSAGE, deleteFile, gitCommit, gitLog, listDir, readFile, WorkspaceError,
         writeFile } from './workspace.ts'
import type { Deps } from '../core/ports.ts'
import type { HttpConfig } from '../types.ts'

/** Request bodies are a chat message or a text file, not an upload. */
export const MAX_BODY_BYTES = 1024 * 1024

export interface HttpServerOptions {
    http: HttpConfig
    deps: Deps
    spawn?: typeof nodeSpawn
}

/**
 * Constant-time token check. Hashing both sides first makes the comparison
 * length-independent, so a wrong-length guess leaks nothing either.
 */
export function authorized(header: string | undefined, token: string): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
    if (!m || !token) return false
    const a = crypto.createHash('sha256').update(m[1]!.trim()).digest()
    const b = crypto.createHash('sha256').update(token).digest()
    return crypto.timingSafeEqual(a, b)
}

class HttpError extends Error {
    readonly status: number
    constructor(status: number, message: string) { super(message); this.status = status }
}

/** Positive integer query param, clamped to `max`; `fallback` when absent. */
export function intParam(v: string | null, fallback: number, max: number): number {
    if (v === null || v === '') return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit harus bilangan bulat positif')
    return Math.min(n, max)
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
                            'Content-Length': Buffer.byteLength(json) })
    res.end(json)
}

async function readJson(req: http.IncomingMessage, max = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    let size = 0
    const parts: Buffer[] = []
    for await (const c of req as AsyncIterable<Buffer>) {
        size += c.length
        if (size > max) throw new HttpError(413, 'body terlalu besar')
        parts.push(c)
    }
    try {
        const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
        if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
    } catch { /* fall through */ }
    throw new HttpError(400, 'body harus objek JSON')
}

function chatKeyOf(v: unknown): string {
    if (!isChatKey(v)) throw new HttpError(400, 'chatKey wajib: 1-128 karakter [A-Za-z0-9._:@-]')
    return v
}

/** A handler's result: JSON to send, or a file to stream as-is. */
class FileBody {
    readonly file: string
    readonly size: number
    constructor(file: string, size: number) { this.file = file; this.size = size }
}

function streamFile(res: http.ServerResponse, { file, size }: FileBody): void {
    res.writeHead(200, { 'Content-Type': contentTypeFor(file), 'Content-Length': size,
                         'X-Content-Type-Options': 'nosniff' })
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

type Handler = (req: http.IncomingMessage, url: URL) => Promise<unknown>

export const MAX_USAGE_DAYS = 90

export function createHttpServer({ http: cfg, deps, spawn = nodeSpawn }: HttpServerOptions): http.Server {
    const ws = cfg.workspaceDir
    let commitQueue: Promise<unknown> = Promise.resolve()

    /** A syntactically valid chatKey that also names a chat this caller may use (403 for a foreign `wa:`). */
    const keyOf = (v: unknown): string => {
        const key = chatKeyOf(v)
        chatIdentity(deps.config, cfg, key)
        return key
    }

    const routes: Record<string, Handler> = {
        'POST /v1/chat': async req => {
            const body = await readJson(req, MAX_CHAT_BODY_BYTES)
            const key = keyOf(body.chatKey)
            const media = parseMedia(body.media)
            if (typeof body.text !== 'string' || (!body.text.trim() && !media.length)) throw new HttpError(400, 'text wajib')
            if (body.model !== undefined && !isModelName(body.model)) throw new HttpError(400, 'model tidak valid')
            const files = saveMedia(media, deps.config.mediaDir, deps.now)
            const { reply, attachments } = await runHttpTurn(cfg, deps, key, body.text, body.model, files)
            // Nothing collected means the turn threw before delivering (it was
            // logged by the queue). deliver() itself always sends something.
            if (!reply && !attachments.length) throw new HttpError(502, 'agent gagal menjawab')
            return attachments.length ? { reply, attachments } : { reply }
        },
        'POST /v1/chat/new': async req => {
            const key = keyOf((await readJson(req)).chatKey)
            await resetHttpChat(cfg, deps, key)
            return { ok: true }
        },
        'GET /v1/chat/history': async (_req, url) => {
            const key = keyOf(url.searchParams.get('chatKey'))
            const limit = intParam(url.searchParams.get('limit'), 20, 1000)
            return { messages: httpHistory(cfg, deps, key, limit).map(({ at, who, text }) => ({ at, who, text })) }
        },
        'GET /v1/reminders': async (_req, url) =>
            ({ reminders: httpReminders(cfg, deps, keyOf(url.searchParams.get('chatKey'))) }),
        'POST /v1/reminders/cancel': async req => {
            const body = await readJson(req)
            const key = keyOf(body.chatKey)
            if (!Number.isInteger(body.id) || (body.id as number) < 1) throw new HttpError(400, 'id harus bilangan bulat positif')
            return { ok: cancelHttpReminder(cfg, deps, key, body.id as number) }
        },
        'GET /v1/model': async (_req, url) => httpModel(cfg, deps, keyOf(url.searchParams.get('chatKey'))),
        'POST /v1/model': async req => {
            const body = await readJson(req)
            const key = keyOf(body.chatKey)
            if (!isModelName(body.model)) throw new HttpError(400, 'model tidak valid')
            const choice = await setHttpModel(cfg, deps, key, body.model)
            if (!choice.ok) throw new HttpError(400, choice.message)
            return { ok: true, model: choice.model }
        },
        'GET /v1/usage': async (_req, url) => {
            const days = intParam(url.searchParams.get('days'), 7, MAX_USAGE_DAYS)
            const now = deps.now()
            const entries = deps.usage.since(windowStart(now, days)).filter(e => e.at <= now)
            return { entries, ...summarizeUsage(entries, days, now) }
        },
        'GET /v1/media': async (_req, url) => {
            const p = url.searchParams.get('path') ?? ''
            if (!p) throw new HttpError(400, 'path wajib')
            const { file, size } = resolveMedia(mediaRoots(deps.config, cfg), p)
            return new FileBody(file, size)
        },
        'GET /v1/workspace/files': async (_req, url) =>
            ({ entries: listDir(ws, url.searchParams.get('path') ?? '') }),
        'GET /v1/workspace/file': async (_req, url) => {
            const rel = url.searchParams.get('path') ?? ''
            if (!rel) throw new HttpError(400, 'path wajib')
            return { path: rel, content: readFile(ws, rel) }
        },
        'PUT /v1/workspace/file': async req => {
            const body = await readJson(req)
            if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, 'path wajib')
            if (typeof body.content !== 'string') throw new HttpError(400, 'content harus string')
            return { ok: true, path: writeFile(ws, body.path, body.content) }
        },
        'DELETE /v1/workspace/file': async (_req, url) => {
            const rel = url.searchParams.get('path') ?? ''
            if (!rel) throw new HttpError(400, 'path wajib')
            deleteFile(ws, rel)
            return { ok: true }
        },
        'GET /v1/git/log': async (_req, url) =>
            ({ commits: await gitLog(ws, intParam(url.searchParams.get('limit'), 20, 200), spawn) }),
        'POST /v1/git/commit': async req => {
            const { message } = await readJson(req)
            if (message !== undefined && message !== null && typeof message !== 'string') {
                throw new HttpError(400, 'message harus string')
            }
            if (typeof message === 'string' && message.includes('\0')) throw new HttpError(400, 'message tidak valid')
            const msg = typeof message === 'string' && message.trim() ? message : DEFAULT_COMMIT_MESSAGE
            // One commit at a time: two concurrent `git add` would fight over index.lock.
            const run = commitQueue.then(() => gitCommit(ws, msg, spawn))
            commitQueue = run.catch(() => {})
            return run
        },
    }
    const paths = new Set(Object.keys(routes).map(r => r.split(' ')[1]))

    const server = http.createServer((req, res) => {
        void (async () => {
            if (!authorized(req.headers.authorization, cfg.token)) {
                // Drain nothing, say nothing beyond this.
                send(res, 401, { error: 'unauthorized' })
                return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const handler = routes[`${req.method} ${url.pathname}`]
            if (!handler) {
                send(res, paths.has(url.pathname) ? 405 : 404, { error: paths.has(url.pathname) ? 'method not allowed' : 'not found' })
                return
            }
            try {
                const out = await handler(req, url)
                if (out instanceof FileBody) streamFile(res, out)
                else send(res, 200, out)
            } catch (e) {
                const status = e instanceof HttpError || e instanceof WorkspaceError || e instanceof ChatKeyForbidden
                    ? e.status : 500
                if (status === 500) deps.log(cfg.account, `http ${req.method} ${url.pathname}: ${(e as Error).message}`)
                send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message })
            }
        })()
    })

    // A turn may legitimately take the whole agent timeout, plus the queue
    // ahead of it; Node's 300s default request timeout would cut it short.
    server.requestTimeout = deps.config.agentTimeoutMs + 60_000
    server.timeout = 0
    return server
}
