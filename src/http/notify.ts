/**
 * POST /v1/notify: the app on this machine pushes one plain WhatsApp message
 * to the owner — an urgent email, a digest. A side door, not a chat: nothing
 * here touches a session, transcript, queue or reminder, no agent turn runs,
 * and a reply from the owner is just an ordinary DM.
 *
 * Owner-only like everything else: the recipient is the first owner of
 * HTTP_ACCOUNT, or `to` when it names another owner of that account.
 *
 * With `remember: true` the sent text is also filed into the owner's DM
 * conversation — a pending note the agent is shown on the owner's next turn,
 * a transcript line, a mirror copy — still without running anything.
 */

import { dmJid, forAccountConfig } from '../config.ts'
import { chatKey } from '../core/dispatch.ts'
import { shouldMirror } from '../core/mirror.ts'
import type { Deps } from '../core/ports.ts'
import type { Notice } from '../store/notices.ts'
import type { Config, HttpConfig } from '../types.ts'

export const MAX_NOTIFY_CHARS = 4000
export const NOTIFY_PER_MINUTE = 30
export const MAX_REF_CHARS = 200

/** The WhatsApp side of a notice. `null` = that account's socket is not open. */
export interface Notifier {
    send(account: string, jid: string, text: string): Promise<{ id?: string } | null>
}

export class NotifyError extends Error {
    readonly status: number
    constructor(status: number, message: string) { super(message); this.status = status }
}

export interface NotifyRequest {
    text: string
    number: string
    remember: boolean
    ref?: string
}

/** Validated `{text, to?, remember?, ref?}`: the trimmed text, the owner number it goes to, and what to file. */
export function parseNotify(config: Config, http: HttpConfig, body: Record<string, unknown>): NotifyRequest {
    if (typeof body.text !== 'string' || !body.text.trim()) throw new NotifyError(400, 'text wajib')
    const text = body.text.trim()
    if (text.length > MAX_NOTIFY_CHARS) throw new NotifyError(400, `text maksimal ${MAX_NOTIFY_CHARS} karakter`)
    if (body.remember !== undefined && typeof body.remember !== 'boolean') {
        throw new NotifyError(400, 'remember harus boolean')
    }
    if (body.ref !== undefined && body.ref !== null
        && (typeof body.ref !== 'string' || body.ref.trim().length > MAX_REF_CHARS)) {
        throw new NotifyError(400, `ref harus string maksimal ${MAX_REF_CHARS} karakter`)
    }
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
    const extra = { remember: body.remember === true, ...(ref ? { ref } : {}) }
    const owners = forAccountConfig(config, http.account).ownerNumbers
    if (body.to === undefined || body.to === null) {
        if (!owners[0]) throw new NotifyError(503, 'no_owner')
        return { text, number: owners[0], ...extra }
    }
    const to = typeof body.to === 'string' ? body.to.replace(/\D/g, '') : ''
    if (!to || !owners.includes(to)) throw new NotifyError(400, 'to harus salah satu OWNER_NUMBERS')
    return { text, number: to, ...extra }
}

/** Sliding one-minute window: `take()` is false once `max` sends happened in the last 60s. */
export function rateLimiter(max: number, now: () => number): { take(): boolean } {
    let stamps: number[] = []
    return {
        take() {
            const t = now()
            stamps = stamps.filter(s => s > t - 60_000)
            if (stamps.length >= max) return false
            stamps.push(t)
            return true
        },
    }
}

/**
 * File a sent notice into the owner's DM conversation — the state the WhatsApp
 * DM and a `wa:<number>` HTTP chat share: a pending note for the agent's next
 * turn, a transcript line marked `kind: 'notice'`, and (mirror on) a copy for
 * Ghina. No session, queue or agent is touched.
 */
export function rememberNotice(deps: Deps, account: string, number: string, text: string, ref?: string): Notice {
    const chat = { account, jid: dmJid(number), number }
    const key = chatKey(chat)
    const note = deps.notices.add(key, text, ref)
    deps.transcripts.append(key, 'agent', note.text, 'notice')
    if (deps.mirror && shouldMirror(deps.config, chat)) {
        try {
            deps.mirror({ channel: 'wa', number, messages: [{ role: 'assistant', text: note.text, at: note.at, kind: 'notice' }] })
        } catch (e) {
            deps.log(account, `mirror gagal: ${(e as Error).message}`)
        }
    }
    return note
}

/** Send one notice (and file it, if asked). Logs a line per send — recipient and length, never the text. */
export async function sendNotify(http: HttpConfig, notifier: Notifier | undefined, deps: Deps,
                                 { text, number, remember, ref }: NotifyRequest):
        Promise<{ sent: true; id?: string; remembered?: true }> {
    const log = deps.log
    let out: { id?: string } | null
    try {
        out = notifier ? await notifier.send(http.account, dmJid(number), text) : null
    } catch (e) {
        log(http.account, `notify → ${number} gagal: ${(e as Error).message}`)
        throw new NotifyError(502, 'wa_send_failed')
    }
    if (!out) {
        log(http.account, `notify → ${number} tidak dikirim (WA belum terhubung)`)
        throw new NotifyError(503, 'wa_not_connected')
    }
    log(http.account, `notify → ${number} terkirim (${text.length} karakter)${out.id ? ` id ${out.id}` : ''}`
        + (remember ? ', diingat' : ''))
    // Only after the send: a notice the owner never got must not be "remembered".
    if (remember) rememberNotice(deps, http.account, number, text, ref)
    return { sent: true, ...(out.id ? { id: out.id } : {}), ...(remember ? { remembered: true as const } : {}) }
}
