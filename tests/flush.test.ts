import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FLUSH_PROMPT, flushSession, flushStale } from '../src/core/flush.ts'
import { dispatch } from '../src/core/dispatch.ts'
import { createSessionStore } from '../src/store/sessions.ts'
import { fakeChat, flush, makeDeps, memFile, testConfig } from './helpers.ts'
import type { ChatSession } from '../src/types.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const KEY = '628111@s.whatsapp.net#628111'
const CHAT = { account: 'main', jid: '628111@s.whatsapp.net', number: '628111' }
const session = (over: Partial<ChatSession> = {}): ChatSession =>
    ({ sessionId: 'old', lastAt: 0, startedAt: 0, turns: 5, chat: CHAT, ...over })

describe('flushSession', () => {
    it('resumes the old session on the cheap model with the flush prompt', async () => {
        const deps = makeDeps()
        expect(await flushSession(session(), deps)).toBe('flushed')
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({
            text: FLUSH_PROMPT, sessionId: 'old', model: 'haiku', workspace: '/ws',
        }))
    })

    it('skips a short session — nothing worth a run', async () => {
        const deps = makeDeps()
        expect(await flushSession(session({ turns: 3 }), deps)).toBe('skipped-short')
        expect(deps.runAgent).not.toHaveBeenCalled()
    })

    it('skips when memory files already changed during the session', async () => {
        const deps = makeDeps({ memoryTouchedSince: (ws, since) => ws === '/ws' && since === 0 })
        expect(await flushSession(session(), deps)).toBe('skipped-touched')
        expect(deps.runAgent).not.toHaveBeenCalled()
    })

    it('is off entirely when MEMORY_FLUSH_MODEL=off', async () => {
        const deps = makeDeps({ config: testConfig({ flushModel: null }) })
        expect(await flushSession(session(), deps)).toBe('skipped-off')
        expect(deps.runAgent).not.toHaveBeenCalled()
    })

    it('runs a routed group flush as that group’s OS user in its workspace', async () => {
        const deps = makeDeps({ config: testConfig({ groups: [{
            name: 'tim', jid: 'g@g.us', workspaceDir: '/home/tim/ws', trigger: 'bot', runAs: 'tim',
            elevated: [], elevatedEnv: {},
        }] }) })
        await flushSession(session({ chat: { ...CHAT, jid: 'g@g.us' } }), deps)
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/home/tim/ws', runAs: 'tim' }))
        expect(deps.runAgent).toHaveBeenCalledWith(expect.not.objectContaining({ extraEnv: expect.anything() }))
    })
})

describe('flushStale', () => {
    const idle = 60_000
    const store = (now: () => number) => createSessionStore(memFile<Record<string, ChatSession>>({}), idle, now)

    it('flushes only sessions past the idle window, then forgets them', async () => {
        let t = 0
        const sessions = store(() => t)
        sessions.remember(KEY, 'old', CHAT)
        for (let i = 0; i < 4; i++) sessions.remember(KEY, 'old', CHAT)
        sessions.remember('other#x', 'live', CHAT)
        t = 30_000
        sessions.remember('other#x', 'live', CHAT)
        t = 90_000
        const deps = makeDeps({ sessions })

        await flushStale(deps)
        expect(deps.runAgent).toHaveBeenCalledTimes(1)
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old' }))
        expect(sessions.peek(KEY)).toBeNull()
        expect(sessions.peek('other#x')?.sessionId).toBe('live')
    })

    it('leaves a chat alone if a new session replaced the stale one meanwhile', async () => {
        let t = 0
        const sessions = store(() => t)
        for (let i = 0; i < 5; i++) sessions.remember(KEY, 'old', CHAT)
        t = 90_000
        const deps = makeDeps({ sessions })
        // A turn is running on this chat's queue when the timer fires.
        void deps.queue.enqueue(KEY, async () => { sessions.remember(KEY, 'new', CHAT) })

        await flushStale(deps)
        expect(deps.runAgent).not.toHaveBeenCalled()
        expect(sessions.peek(KEY)?.sessionId).toBe('new')
    })
})

describe('coming back after idle', () => {
    it('briefs the new session, and flushes the leftover one alongside', async () => {
        let t = 0
        const sessions = createSessionStore(memFile<Record<string, ChatSession>>({}), 60_000, () => t)
        for (let i = 0; i < 5; i++) sessions.remember(KEY, 'old', CHAT)
        const deps = makeDeps({ sessions })
        deps.transcripts.append(KEY, 'user', 'aku mau resign')
        deps.transcripts.append(KEY, 'agent', 'serius?')
        t = 90_000
        deps.now = () => t

        await dispatch(fakeChat(), { text: 'iya', hasFile: false, file: null }, deps)
        await flush()

        const calls = vi.mocked(deps.runAgent).mock.calls.map(c => c[0])
        const turn = calls.find(c => c.sessionId === null)!
        expect(turn.text).toContain('aku mau resign')
        expect(turn.text).toContain('Kamu: serius?')
        expect(turn.text).toMatch(/\] iya$/)
        expect(calls.find(c => c.sessionId === 'old')?.text).toBe(FLUSH_PROMPT)
        expect(sessions.peek(KEY)?.sessionId).toBe('sess-1')
    })

    it('does not brief a resumed session', async () => {
        const deps = makeDeps()
        deps.sessions.remember(KEY, 'live', CHAT)
        deps.transcripts.append(KEY, 'user', 'sebelumnya')

        await dispatch(fakeChat(), { text: 'halo', hasFile: false, file: null }, deps)
        await flush()
        expect(vi.mocked(deps.runAgent).mock.calls[0]![0].text).not.toContain('sebelumnya')
    })

    it('records both sides of the turn in the transcript, markers stripped', async () => {
        const deps = makeDeps({ runAgent: vi.fn(async () => ({ reply: 'okee [[remind:in 5m|x]]', sessionId: 's' })) })
        await dispatch(fakeChat(), { text: 'ingetin', hasFile: false, file: null }, deps)
        await flush()
        expect(deps.transcripts.recent(KEY).map(l => `${l.who}:${l.text}`)).toEqual(['user:ingetin', 'agent:okee'])
    })
})
