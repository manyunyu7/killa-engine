/**
 * Chat -> Claude session map, persisted so a restart doesn't amnesia every
 * conversation. Idle expiry is read-time, not a timer: a session older than
 * the idle window simply isn't offered for resume — but it is kept around
 * until the memory flush has had its say (see core/flush.ts), because that
 * is exactly the moment the agent should write down what it learned.
 */

import type { ChatSession } from '../types.ts'
import type { JsonFile } from './json-file.ts'

export interface SessionStore {
    /** Resumable session id, or null when there is none or it went idle. */
    get(key: string): string | null
    /** The stored entry regardless of idle state. */
    peek(key: string): ChatSession | null
    remember(key: string, sessionId: string | null, chat?: ChatSession['chat']): void
    forget(key: string): void
    /** Entries past the idle window: candidates for a flush. */
    stale(): [string, ChatSession][]
    all(): Record<string, ChatSession>
}

export function createSessionStore(file: JsonFile<Record<string, ChatSession>>, idleMs: number,
                                   now: () => number = Date.now): SessionStore {
    const sessions = file.read()
    const isStale = (s: ChatSession) => now() - s.lastAt > idleMs

    return {
        get(key) {
            const s = sessions[key]
            if (!s || isStale(s)) return null
            return s.sessionId
        },
        peek: key => sessions[key] ?? null,
        remember(key, sessionId, chat) {
            if (!sessionId) { delete sessions[key]; file.write(sessions); return }
            const prev = sessions[key]
            const same = prev?.sessionId === sessionId
            sessions[key] = {
                sessionId,
                lastAt: now(),
                startedAt: same ? prev.startedAt : now(),
                turns: (same ? prev.turns : 0) + 1,
                chat: chat ?? prev?.chat ?? { account: '', jid: '', number: '' },
            }
            file.write(sessions)
        },
        forget(key) { delete sessions[key]; file.write(sessions) },
        stale: () => Object.entries(sessions).filter(([, s]) => isStale(s)),
        all: () => sessions,
    }
}
