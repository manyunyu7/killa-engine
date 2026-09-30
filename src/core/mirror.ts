/**
 * The mirror hook: a copy of each completed WhatsApp owner-DM turn, POSTed
 * to another app (Ghina) so it can show the WhatsApp side of a conversation
 * it shares through the `wa:<number>` chatKey.
 *
 * Fire-and-forget by design. The mirror is a convenience for a second
 * screen; WhatsApp is the conversation. A slow, down or rejecting receiver
 * costs one log line — never a delayed reply, never a crash, never a retry
 * queue that grows while it is down.
 */

import { forAccountConfig, isGroupJid, isHttpJid } from '../config.ts'
import type { Chat } from './ports.ts'
import type { Config } from '../types.ts'

export interface MirrorMessage { role: 'user' | 'assistant'; text: string; at: number }

export interface MirrorPayload {
    channel: 'wa'
    number: string
    messages: MirrorMessage[]
}

export const MIRROR_TIMEOUT_MS = 10_000

/**
 * Only an owner's WhatsApp DM is mirrored. HTTP turns are not (the caller
 * already has them — including `wa:` turns, which share the DM's jid), and
 * neither are groups (other people's words, other people's conversation).
 */
export function shouldMirror(config: Config, chat: Pick<Chat, 'account' | 'jid' | 'number' | 'channel'>): boolean {
    return !!config.mirror
        && chat.channel !== 'http'
        && !isHttpJid(chat.jid)
        && !isGroupJid(chat.jid)
        && forAccountConfig(config, chat.account).ownerNumbers.includes(chat.number)
}

export interface MirrorOptions {
    url: string
    token: string
    fetch: typeof globalThis.fetch
    log: (msg: string) => void
    timeoutMs?: number
}

/** A poster for MirrorPayloads. Returns immediately; the POST runs on its own. */
export function createMirror({ url, token, fetch, log, timeoutMs = MIRROR_TIMEOUT_MS }: MirrorOptions):
        (payload: MirrorPayload) => void {
    return payload => {
        // Promise.resolve().then: even a fetch that throws synchronously
        // becomes a logged rejection instead of an exception in the turn.
        void Promise.resolve()
            .then(() => fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            }))
            .then(res => { if (!res.ok) log(`mirror ${payload.number} ditolak: HTTP ${res.status}`) })
            .catch((e: unknown) => log(`mirror ${payload.number} gagal: ${e instanceof Error ? e.message : String(e)}`))
    }
}
