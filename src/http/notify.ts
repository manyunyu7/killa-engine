/**
 * POST /v1/notify: the app on this machine pushes one plain WhatsApp message
 * to the owner — an urgent email, a digest. A side door, not a chat: nothing
 * here touches a session, transcript, queue or reminder, no agent turn runs,
 * and a reply from the owner is just an ordinary DM.
 *
 * Owner-only like everything else: the recipient is the first owner of
 * HTTP_ACCOUNT, or `to` when it names another owner of that account.
 */

import { dmJid, forAccountConfig } from '../config.ts'
import type { Config, HttpConfig } from '../types.ts'

export const MAX_NOTIFY_CHARS = 4000
export const NOTIFY_PER_MINUTE = 30

/** The WhatsApp side of a notice. `null` = that account's socket is not open. */
export interface Notifier {
    send(account: string, jid: string, text: string): Promise<{ id?: string } | null>
}

export class NotifyError extends Error {
    readonly status: number
    constructor(status: number, message: string) { super(message); this.status = status }
}

/** Validated `{text, to?}`: the trimmed text and the owner number it goes to. */
export function parseNotify(config: Config, http: HttpConfig, body: Record<string, unknown>):
        { text: string; number: string } {
    if (typeof body.text !== 'string' || !body.text.trim()) throw new NotifyError(400, 'text wajib')
    const text = body.text.trim()
    if (text.length > MAX_NOTIFY_CHARS) throw new NotifyError(400, `text maksimal ${MAX_NOTIFY_CHARS} karakter`)
    const owners = forAccountConfig(config, http.account).ownerNumbers
    if (body.to === undefined || body.to === null) {
        if (!owners[0]) throw new NotifyError(503, 'no_owner')
        return { text, number: owners[0] }
    }
    const to = typeof body.to === 'string' ? body.to.replace(/\D/g, '') : ''
    if (!to || !owners.includes(to)) throw new NotifyError(400, 'to harus salah satu OWNER_NUMBERS')
    return { text, number: to }
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

/** Send one notice. Logs a line per send — recipient and length, never the text. */
export async function sendNotify(http: HttpConfig, notifier: Notifier | undefined, log: (a: string, m: string) => void,
                                 text: string, number: string): Promise<{ sent: true; id?: string }> {
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
    log(http.account, `notify → ${number} terkirim (${text.length} karakter)${out.id ? ` id ${out.id}` : ''}`)
    return out.id ? { sent: true, id: out.id } : { sent: true }
}
