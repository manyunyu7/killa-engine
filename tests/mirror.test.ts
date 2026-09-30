import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createMirror, MIRROR_TIMEOUT_MS, shouldMirror, type MirrorPayload } from '../src/core/mirror.ts'
import { dispatch } from '../src/core/dispatch.ts'
import { runHttpTurn } from '../src/http/chat.ts'
import { fakeChat, flush, makeDeps, testConfig } from './helpers.ts'
import type { HttpConfig } from '../src/types.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const MIRROR = { url: 'https://ghina.test/api/mirror', token: 'm-tok' }
const HTTP: HttpConfig = { port: 0, bind: '127.0.0.1', token: 't', account: 'main', workspaceDir: '/ws-ghina' }
const msg = (text: string) => ({ text, hasFile: false, file: null })

describe('shouldMirror', () => {
    const config = testConfig({ mirror: MIRROR })
    const dm = { account: 'main', jid: '628111@s.whatsapp.net', number: '628111' }

    it('mirrors an owner WhatsApp DM, on a PN or a LID jid', () => {
        expect(shouldMirror(config, dm)).toBe(true)
        expect(shouldMirror(config, { ...dm, jid: '99@lid' })).toBe(true)
    })

    it.each([
        ['mirror off', testConfig(), dm],
        ['HTTP channel (wa: key shares the DM jid)', config, { ...dm, channel: 'http' as const }],
        ['plain HTTP chat', config, { account: 'main', jid: 'http:u1', number: 'http:u1' }],
        ['group', config, { ...dm, jid: '123@g.us' }],
        ['non-owner', config, { ...dm, number: '628999' }],
    ])('skips: %s', (_label, cfg, chat) => {
        expect(shouldMirror(cfg, chat)).toBe(false)
    })
})

describe('createMirror', () => {
    const payload: MirrorPayload = { channel: 'wa', number: '628111',
        messages: [{ role: 'user', text: 'halo', at: 1 }, { role: 'assistant', text: 'hai', at: 2 }] }

    it('POSTs the payload with the bearer token and a 10s timeout, without waiting', async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 204 }))
        const log = vi.fn()
        const post = createMirror({ ...MIRROR, fetch, log })
        expect(post(payload)).toBeUndefined()
        await flush()
        expect(fetch).toHaveBeenCalledTimes(1)
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe(MIRROR.url)
        expect(init.method).toBe('POST')
        expect(init.headers).toMatchObject({ Authorization: 'Bearer m-tok', 'Content-Type': 'application/json' })
        expect(JSON.parse(init.body as string)).toEqual(payload)
        expect(init.signal).toBeInstanceOf(AbortSignal)
        expect(MIRROR_TIMEOUT_MS).toBe(10_000)
        expect(log).not.toHaveBeenCalled()
    })

    it.each([
        ['a rejected fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }), /gagal: ECONNREFUSED/],
        ['a synchronous throw', vi.fn(() => { throw new Error('boom') }), /gagal: boom/],
        ['a non-2xx', vi.fn(async () => new Response('no', { status: 500 })), /ditolak: HTTP 500/],
        ['a non-Error rejection', vi.fn(async () => { throw 'aneh' }), /gagal: aneh/],
    ])('only logs %s', async (_label, fetch, pattern) => {
        const log = vi.fn()
        createMirror({ ...MIRROR, fetch: fetch as never, log })(payload)
        await flush(); await flush()
        expect(log).toHaveBeenCalledWith(expect.stringMatching(pattern))
    })

    it('aborts a receiver that never answers', async () => {
        const log = vi.fn()
        const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('timeout')))
        }))
        createMirror({ ...MIRROR, fetch: fetch as never, log, timeoutMs: 5 })(payload)
        await new Promise(r => setTimeout(r, 30))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('gagal: timeout'))
    })
})

describe('mirror in the turn', () => {
    const mirrorDeps = (over = {}) => {
        const mirror = vi.fn()
        let t = 1000
        const deps = makeDeps({ config: testConfig({ mirror: MIRROR, http: HTTP }), mirror, now: () => t++, ...over })
        return { deps, mirror }
    }

    it('mirrors a completed WhatsApp DM turn: inbound text and the marker-free reply', async () => {
        const { deps, mirror } = mirrorDeps({
            runAgent: vi.fn(async () => ({ reply: 'siap [[remind:in 1h|minum]]', sessionId: 's' })),
        })
        const chat = fakeChat()
        await dispatch(chat, msg('ingetin minum'), deps)
        await flush()
        expect(mirror).toHaveBeenCalledTimes(1)
        const payload = mirror.mock.calls[0]![0] as MirrorPayload
        expect(payload).toEqual({ channel: 'wa', number: '628111', messages: [
            { role: 'user', text: 'ingetin minum', at: expect.any(Number) },
            { role: 'assistant', text: 'siap', at: expect.any(Number) },
        ] })
        expect(payload.messages[1]!.at).toBeGreaterThanOrEqual(payload.messages[0]!.at)
        // Mirrored after the reply went out, never before.
        expect(chat.texts[0]).toBe('siap')
    })

    it('does not mirror slash commands, HTTP turns (wa: included) or groups', async () => {
        const { deps, mirror } = mirrorDeps()
        await dispatch(fakeChat(), msg('/reminders'), deps)
        await runHttpTurn(HTTP, deps, 'wa:628111', 'dari ghina')
        await runHttpTurn(HTTP, deps, 'u1', 'dari ghina')
        await dispatch(fakeChat({ jid: '123@g.us' }), msg('killa halo'), deps)
        await flush()
        expect(mirror).not.toHaveBeenCalled()
    })

    it('a throwing mirror is logged and the turn still completes', async () => {
        const log = vi.fn()
        const { deps } = mirrorDeps({ mirror: vi.fn(() => { throw new Error('rusak') }), log })
        const chat = fakeChat()
        await dispatch(chat, msg('halo'), deps)
        await flush()
        expect(chat.texts).toEqual(['halo'])
        expect(log).toHaveBeenCalledWith('main', 'mirror gagal: rusak')
    })

    it('records a file-only message the way the transcript does', async () => {
        const { deps, mirror } = mirrorDeps()
        await dispatch(fakeChat(), { text: '', hasFile: true, file: { path: '/m/a.jpg', kind: 'image', name: 'gambar' } }, deps)
        await flush()
        expect((mirror.mock.calls[0]![0] as MirrorPayload).messages[0]!.text).toBe('[gambar]')
    })
})
