/**
 * Chat -> Claude session map, persisted so a restart doesn't amnesia every
 * conversation. Idle expiry is read-time, not a timer: a session older than
 * the idle window simply isn't offered for resume.
 */

import type { ChatSession } from '../types.ts'
import type { JsonFile } from './json-file.ts'

export interface SessionStore {
    get(number: string): string | null
    remember(number: string, sessionId: string | null): void
    all(): Record<string, ChatSession>
}

export function createSessionStore(file: JsonFile<Record<string, ChatSession>>, idleMs: number,
                                   now: () => number = Date.now): SessionStore {
    const sessions = file.read()

    return {
        get(number) {
            const s = sessions[number]
            if (!s) return null
            if (now() - s.lastAt > idleMs) return null // stale -> fresh session
            return s.sessionId
        },
        remember(number, sessionId) {
            if (sessionId) sessions[number] = { sessionId, lastAt: now() }
            else delete sessions[number]
            file.write(sessions)
        },
        all: () => sessions,
    }
}
