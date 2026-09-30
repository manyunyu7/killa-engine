/**
 * The HTTP channel's bridge into dispatch — no sockets, no fs, so it is
 * tested the same way the WhatsApp flow is.
 *
 * An HTTP caller is just another Chat: the turn runs through the same
 * dispatch, queue, session and transcript machinery as WhatsApp. The only
 * difference is that "sending" means collecting, and the caller waits for
 * the queue to drain instead of watching a phone.
 */

import { HTTP_JID_PREFIX } from '../config.ts'
import { chatKey, dispatch } from '../core/dispatch.ts'
import type { Chat, Deps } from '../core/ports.ts'
import type { HttpConfig } from '../types.ts'
import type { Line } from '../store/transcript.ts'

/**
 * What a caller may use as chatKey. It becomes part of a state-file key and
 * a log line, so keep it boring: no spaces, no path characters.
 */
export const isChatKey = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(v)

/** Model names are handed to `claude --model`; aliases and full ids only. */
export const isModelName = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9._[\]-]{1,100}$/.test(v)

/**
 * chatKey -> synthetic chat identity. jid and number are both `http:<key>`:
 * the prefix keeps it from ever colliding with a WhatsApp jid or an owner
 * number (reminders are filed by number), and gives every HTTP user their
 * own session and transcript inside the one shared workspace.
 */
export function httpIdentity(key: string): { jid: string; number: string } {
    const id = `${HTTP_JID_PREFIX}${key}`
    return { jid: id, number: id }
}

/** The per-chat state key (sessions, transcripts, models) for an HTTP chatKey. */
export const httpStateKey = (key: string): string => chatKey(httpIdentity(key))

export interface CollectingChat extends Chat {
    texts: string[]
    attachments: string[]
}

export function collectingChat(http: HttpConfig, key: string): CollectingChat {
    const chat: CollectingChat = {
        account: http.account,
        ...httpIdentity(key),
        unchunked: true,
        texts: [],
        attachments: [],
        async sendText(t) { chat.texts.push(t) },
        // Paths, not bytes: the caller lives on the same machine and can read
        // the file itself — or decide not to.
        async sendImage(f) { chat.attachments.push(f) },
        async sendDocument(f) { chat.attachments.push(f) },
        async presence() {},
    }
    return chat
}

export interface ChatReply {
    reply: string
    attachments: string[]
}

/**
 * Run one message through dispatch and wait for everything it queued.
 * Slash commands (/model, /reminders, …) work exactly as on WhatsApp.
 *
 * `model` overrides this chat's model for this one turn without storing it —
 * the per-request equivalent of /model, minus the probe.
 */
export async function runHttpTurn(http: HttpConfig, deps: Deps, key: string, text: string,
                                  model?: string): Promise<ChatReply> {
    const chat = collectingChat(http, key)
    const stateKey = chatKey(chat)
    const turnDeps: Deps = model
        ? { ...deps, models: { ...deps.models, get: k => k === stateKey ? model : deps.models.get(k) } }
        : deps

    await dispatch(chat, { text, hasFile: false, file: null }, turnDeps)
    // dispatch enqueues and returns; a no-op behind it resolves once the turn
    // (and anything queued before it for this chat) has finished.
    await deps.queue.enqueue(stateKey, async () => {})

    return { reply: chat.texts.join('\n\n'), attachments: chat.attachments }
}

/** Same as the /new command: flush if worth it, forget the session, clear the transcript. */
export async function resetHttpChat(http: HttpConfig, deps: Deps, key: string): Promise<void> {
    const chat = collectingChat(http, key)
    await dispatch(chat, { text: '/new', hasFile: false, file: null }, deps)
    await deps.queue.enqueue(chatKey(chat), async () => {})
}

/** The last `limit` transcript lines — at most KEEP_LINES exist, truncated to KEEP_CHARS. */
export function httpHistory(deps: Deps, key: string, limit: number): Line[] {
    return deps.transcripts.recent(httpStateKey(key)).slice(-limit)
}
