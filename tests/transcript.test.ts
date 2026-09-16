import { describe, expect, it } from 'vitest'
import { createTranscriptStore, KEEP_CHARS, KEEP_LINES } from '../src/store/transcript.ts'
import { createSessionStore } from '../src/store/sessions.ts'
import { memFile } from './helpers.ts'
import type { Line } from '../src/store/transcript.ts'
import type { ChatSession } from '../src/types.ts'

describe('createTranscriptStore', () => {
    it('keeps the last N lines only', () => {
        const t = createTranscriptStore(memFile<Record<string, Line[]>>({}))
        for (let i = 0; i < KEEP_LINES + 5; i++) t.append('k', 'user', `m${i}`)
        expect(t.recent('k')).toHaveLength(KEEP_LINES)
        expect(t.recent('k')[0]!.text).toBe('m5')
    })

    it('truncates long lines and collapses whitespace', () => {
        const t = createTranscriptStore(memFile<Record<string, Line[]>>({}))
        t.append('k', 'agent', `a\n\n  b ${'x'.repeat(500)}`)
        const line = t.recent('k')[0]!.text
        expect(line.startsWith('a b x')).toBe(true)
        expect(line.length).toBe(KEEP_CHARS + 1)
    })

    it('drops empty lines and clears per chat', () => {
        const t = createTranscriptStore(memFile<Record<string, Line[]>>({}))
        t.append('k', 'user', '   ')
        expect(t.recent('k')).toEqual([])
        t.append('k', 'user', 'hi')
        t.clear('k')
        expect(t.recent('k')).toEqual([])
    })
})

describe('session turns and age', () => {
    it('counts turns on the same session and restarts on a new id', () => {
        let t = 100
        const s = createSessionStore(memFile<Record<string, ChatSession>>({}), 60_000, () => t)
        s.remember('k', 'a'); t = 200; s.remember('k', 'a')
        expect(s.peek('k')).toMatchObject({ turns: 2, startedAt: 100, lastAt: 200 })
        s.remember('k', 'b')
        expect(s.peek('k')).toMatchObject({ turns: 1, startedAt: 200 })
    })

    it('peek sees a stale session that get() no longer offers', () => {
        let t = 0
        const s = createSessionStore(memFile<Record<string, ChatSession>>({}), 60_000, () => t)
        s.remember('k', 'a')
        t = 90_000
        expect(s.get('k')).toBeNull()
        expect(s.peek('k')?.sessionId).toBe('a')
        expect(s.stale().map(([k]) => k)).toEqual(['k'])
    })
})
