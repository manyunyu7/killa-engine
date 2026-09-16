import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonFile } from '../src/store/json-file.ts'
import { createSessionStore } from '../src/store/sessions.ts'
import { createModelStore } from '../src/store/models.ts'
import { memFile } from './helpers.ts'
import type { ChatSession } from '../src/types.ts'

describe('jsonFile', () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'killa-'))

    it('round-trips through disk', () => {
        const f = jsonFile<{ a: number }>(path.join(tmp(), 'x.json'), () => ({ a: 0 }))
        f.write({ a: 1 })
        expect(f.read()).toEqual({ a: 1 })
    })

    it('starts from the fallback when the file is missing', () => {
        expect(jsonFile(path.join(tmp(), 'nope.json'), () => ({ a: 7 })).read()).toEqual({ a: 7 })
    })

    it('starts from the fallback when the file is corrupt, rather than crashing', () => {
        const file = path.join(tmp(), 'bad.json')
        fs.writeFileSync(file, '{not json')
        expect(jsonFile(file, () => ({ a: 7 })).read()).toEqual({ a: 7 })
    })

    it('creates missing directories on write', () => {
        const file = path.join(tmp(), 'deep', 'nested', 'x.json')
        jsonFile(file, () => ({})).write({ ok: true })
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ok: true })
    })

    it('leaves no temp file behind', () => {
        const dir = tmp()
        const file = path.join(dir, 'x.json')
        jsonFile(file, () => ({})).write({ ok: true })
        expect(fs.readdirSync(dir)).toEqual(['x.json'])
    })

    it('reports a failed write instead of throwing into the caller', () => {
        const onError = vi.fn()
        // A directory where the file should be: writeFileSync will fail.
        const dir = tmp()
        fs.mkdirSync(path.join(dir, 'x.json.tmp'))
        jsonFile(path.join(dir, 'x.json'), () => ({}), onError).write({ ok: true })
        expect(onError).toHaveBeenCalled()
    })
})

describe('createSessionStore', () => {
    const idle = 30 * 60_000

    it('returns null for an unknown chat', () => {
        expect(createSessionStore(memFile({}), idle).get('628111')).toBeNull()
    })

    it('remembers and returns a session', () => {
        const s = createSessionStore(memFile({}), idle)
        s.remember('628111', 'sess-1')
        expect(s.get('628111')).toBe('sess-1')
    })

    it('expires a session after the idle window — deliberate amnesia', () => {
        let now = 1_000_000
        const s = createSessionStore(memFile({}), idle, () => now)
        s.remember('628111', 'sess-1')
        now += idle + 1
        expect(s.get('628111')).toBeNull()
    })

    it('keeps a session that is still inside the window', () => {
        let now = 1_000_000
        const s = createSessionStore(memFile({}), idle, () => now)
        s.remember('628111', 'sess-1')
        now += idle - 1
        expect(s.get('628111')).toBe('sess-1')
    })

    it('forgets on a null session id (/new)', () => {
        const file = memFile<Record<string, never>>({})
        const s = createSessionStore(file, idle)
        s.remember('628111', 'sess-1')
        s.remember('628111', null)
        expect(s.get('628111')).toBeNull()
        expect(file.read()).toEqual({})
    })

    it('survives a restart by reloading the file', () => {
        const file = memFile<Record<string, ChatSession>>({})
        createSessionStore(file, idle).remember('628111', 'sess-1')
        expect(createSessionStore(file, idle).get('628111')).toBe('sess-1')
    })

    it('keeps chats separate', () => {
        const s = createSessionStore(memFile({}), idle)
        s.remember('628111', 'a')
        s.remember('628222', 'b')
        expect(s.get('628111')).toBe('a')
        expect(s.get('628222')).toBe('b')
    })
})

describe('createModelStore', () => {
    it('is empty by default', () => {
        expect(createModelStore(memFile({})).get('628111')).toBeUndefined()
    })

    it('stores, overwrites and clears a choice', () => {
        const m = createModelStore(memFile({}))
        m.set('628111', 'opus')
        expect(m.get('628111')).toBe('opus')
        m.set('628111', 'sonnet')
        expect(m.get('628111')).toBe('sonnet')
        m.set('628111', null)
        expect(m.get('628111')).toBeUndefined()
    })

    it('persists so a model choice outlives a restart', () => {
        const file = memFile<Record<string, string>>({})
        createModelStore(file).set('628111', 'opus')
        expect(createModelStore(file).get('628111')).toBe('opus')
    })
})
