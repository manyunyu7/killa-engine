/**
 * A short rolling log of what was said in each chat — not a message DB, just
 * enough for a fresh Claude session to pick up where the last one left off.
 *
 * Claude Code keeps the real transcript; this exists because a new session
 * cannot see the old one, and "what were we just talking about" is the single
 * most common thing a resumed agent gets wrong.
 */

import type { JsonFile } from './json-file.ts'

export interface Line {
    at: number
    who: 'user' | 'agent'
    text: string
}

export interface TranscriptStore {
    append(key: string, who: Line['who'], text: string): void
    recent(key: string): Line[]
    clear(key: string): void
}

/** Lines kept per chat, and characters kept per line — both small on purpose. */
export const KEEP_LINES = 20
export const KEEP_CHARS = 240

export function createTranscriptStore(file: JsonFile<Record<string, Line[]>>,
                                      now: () => number = Date.now): TranscriptStore {
    const data = file.read()
    return {
        append(key, who, text) {
            const clean = text.replace(/\s+/g, ' ').trim()
            if (!clean) return
            const lines = data[key] ?? (data[key] = [])
            lines.push({ at: now(), who, text: clean.length > KEEP_CHARS ? `${clean.slice(0, KEEP_CHARS)}…` : clean })
            if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES)
            file.write(data)
        },
        recent: key => data[key] ?? [],
        clear(key) { delete data[key]; file.write(data) },
    }
}
