import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { targetFor } from '../src/config.ts'
import { chatKey } from '../src/core/dispatch.ts'
import { collectingChat, httpHistory, httpIdentity, httpStateKey, isChatKey, isModelName,
         resetHttpChat, runHttpTurn } from '../src/http/chat.ts'
import { authorized, createHttpServer, intParam } from '../src/http/server.ts'
import { gitLog, isHidden, listDir, looksBinary, MAX_FILE_BYTES, parseGitLog, readFile,
         resolveInside, WorkspaceError } from '../src/http/workspace.ts'
import type { Deps } from '../src/core/ports.ts'
import type { HttpConfig } from '../src/types.ts'
import { flush, makeDeps, testConfig } from './helpers.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const HTTP: HttpConfig = { port: 0, bind: '127.0.0.1', token: 'rahasia', account: 'main', workspaceDir: '/ws-ghina' }
const httpDeps = (over: Partial<Deps> = {}) => makeDeps({ config: testConfig({ http: HTTP }), ...over })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'killa-http-'))

describe('chatKey -> chat identity', () => {
    it('prefixes jid and number with http: so no WhatsApp chat or owner can collide', () => {
        expect(httpIdentity('user-42')).toEqual({ jid: 'http:user-42', number: 'http:user-42' })
        expect(httpStateKey('user-42')).toBe('http:user-42#http:user-42')
    })

    it('gives each chatKey its own state key', () => {
        expect(httpStateKey('a')).not.toBe(httpStateKey('b'))
    })

    it('keeps a digits-only chatKey apart from the WhatsApp owner with that number', () => {
        expect(httpStateKey('628111')).not.toBe(chatKey({ jid: '628111@s.whatsapp.net', number: '628111' }))
    })

    it.each([['user-1', true], ['a.b:c@d_e', true], ['', false], ['a b', false], ['../x', false],
             ['x'.repeat(129), false], [42, false], [null, false]])('isChatKey(%j) = %s', (v, ok) => {
        expect(isChatKey(v)).toBe(ok)
    })

    it.each([['opus', true], ['claude-opus-4-1[1m]', true], ['--help x', false], ['', false], [3, false]])(
        'isModelName(%j) = %s', (v, ok) => { expect(isModelName(v)).toBe(ok) })

    it('runs every HTTP chat in the HTTP workspace, never a contact persona', () => {
        const config = testConfig({ http: HTTP, contactWorkspaces: { 628111: '/ws-private' } })
        expect(targetFor(config, { account: 'main', ...httpIdentity('628111') }))
            .toEqual({ workspace: '/ws-ghina', runAs: null })
    })

    it('collecting chat is unchunked and filed under the HTTP account', () => {
        const chat = collectingChat({ ...HTTP, account: 'kerja' }, 'u1')
        expect(chat.unchunked).toBe(true)
        expect(chat.account).toBe('kerja')
    })
})

describe('dispatch integration', () => {
    it('runs a turn in the HTTP workspace and returns the reply', async () => {
        const deps = httpDeps()
        const out = await runHttpTurn(HTTP, deps, 'u1', 'halo')
        expect(out).toEqual({ reply: 'halo', attachments: [] })
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/ws-ghina', sessionId: null }))
        expect(deps.sessions.get(httpStateKey('u1'))).toBe('sess-1')
    })

    it('resumes the session on the next turn for the same chatKey only', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'satu')
        await runHttpTurn(HTTP, deps, 'u1', 'dua')
        await runHttpTurn(HTTP, deps, 'u2', 'tiga')
        const calls = vi.mocked(deps.runAgent).mock.calls.map(c => c[0].sessionId)
        expect(calls).toEqual([null, 'sess-1', null])
    })

    it('returns attachment paths instead of sending media, and strips the markers', async () => {
        const deps = httpDeps({
            runAgent: vi.fn(async () => ({ reply: 'ini dia [[send:/ws-ghina/a.png]] [[send:/ws-ghina/b.pdf]]', sessionId: 's' })),
        })
        const out = await runHttpTurn(HTTP, deps, 'u1', 'kirim')
        expect(out).toEqual({ reply: 'ini dia', attachments: ['/ws-ghina/a.png', '/ws-ghina/b.pdf'] })
    })

    it('keeps a long reply in one piece instead of WhatsApp chunks', async () => {
        const long = 'x'.repeat(9000)
        const deps = httpDeps({ runAgent: vi.fn(async () => ({ reply: long, sessionId: 's' })) })
        expect((await runHttpTurn(HTTP, deps, 'u1', 'panjang')).reply).toBe(long)
    })

    it('schedules [[remind:]] under the http identity and confirms it in the reply', async () => {
        const deps = httpDeps({ runAgent: vi.fn(async () => ({ reply: 'siap [[remind:in 1h|minum]]', sessionId: 's' })) })
        const out = await runHttpTurn(HTTP, deps, 'u1', 'ingetin')
        expect(out.reply).toMatch(/^siap\n\n⏰ Diingetin: /)
        expect(deps.reminders.list('http:u1')).toEqual([expect.objectContaining({ jid: 'http:u1', text: 'minum' })])
    })

    it('applies a per-request model without storing it', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'halo', 'opus')
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }))
        expect(deps.models.get(httpStateKey('u1'))).toBeUndefined()
    })

    it('waits for the turn already running for that chatKey', async () => {
        let release!: () => void
        const deps = httpDeps({
            runAgent: vi.fn(() => new Promise<{ reply: string; sessionId: string }>(r => { release = () => r({ reply: 'ok', sessionId: 's' }) })),
        })
        const first = runHttpTurn(HTTP, deps, 'u1', 'satu')
        await flush()
        let resetDone = false
        const reset = resetHttpChat(HTTP, deps, 'u1').then(() => { resetDone = true })
        await flush()
        expect(resetDone).toBe(false)
        release()
        expect((await first).reply).toBe('ok')
        await reset
        expect(deps.sessions.get(httpStateKey('u1'))).toBeNull()
    })

    it('/new resets the session and clears the transcript', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'halo')
        expect(httpHistory(deps, 'u1', 20)).toHaveLength(2)
        await resetHttpChat(HTTP, deps, 'u1')
        expect(deps.sessions.get(httpStateKey('u1'))).toBeNull()
        expect(httpHistory(deps, 'u1', 20)).toEqual([])
    })

    it('history returns the last N lines', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'halo')
        expect(httpHistory(deps, 'u1', 1)).toEqual([expect.objectContaining({ who: 'agent', text: 'halo' })])
    })

    it('returns an empty reply when the turn threw', async () => {
        const deps = httpDeps({ runAgent: vi.fn(async () => { throw new Error('boom') }) })
        expect(await runHttpTurn(HTTP, deps, 'u1', 'halo')).toEqual({ reply: '', attachments: [] })
    })
})

describe('path traversal', () => {
    it.each(['../etc/passwd', 'a/../../x', '..', '/etc/passwd', 'a\\..\\..\\x', 'a\0b', '.git/config',
             'sub/.env', '.env.local', 'node_modules/x'])('rejects %j', rel => {
        expect(resolveInside('/ws', rel)).toBeNull()
    })

    it.each([['', '/ws'], ['.', '/ws'], ['memory/2026.md', '/ws/memory/2026.md'], ['./a/b', '/ws/a/b']])(
        'resolves %j inside the root', (rel, full) => { expect(resolveInside('/ws', rel)).toBe(full) })

    it('refuses a symlink that points out of the workspace', () => {
        const root = tmp()
        const outside = tmp()
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
        fs.symlinkSync(outside, path.join(root, 'link'))
        expect(() => readFile(root, 'link/secret.txt')).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => listDir(root, 'link')).toThrow(WorkspaceError)
    })

    it('hides .git, node_modules and .env files', () => {
        expect(['.git', 'node_modules', '.env', '.env.prod'].every(isHidden)).toBe(true)
        expect(isHidden('.envrc')).toBe(false)
        expect(isHidden('env.md')).toBe(false)
    })
})

describe('workspace files', () => {
    const ws = () => {
        const root = tmp()
        fs.mkdirSync(path.join(root, 'memory'))
        fs.mkdirSync(path.join(root, '.git'))
        fs.mkdirSync(path.join(root, 'node_modules'))
        fs.writeFileSync(path.join(root, 'MEMORY.md'), 'ingat')
        fs.writeFileSync(path.join(root, '.env'), 'PASS=x')
        return root
    }

    it('lists dirs first, skipping hidden entries', () => {
        expect(listDir(ws(), '')).toEqual([
            { name: 'memory', type: 'dir', size: 0 },
            { name: 'MEMORY.md', type: 'file', size: 5 },
        ])
    })

    it('reads a text file', () => {
        expect(readFile(ws(), 'MEMORY.md')).toBe('ingat')
    })

    it.each([
        ['missing.md', 404],
        ['memory', 400],
    ])('%s -> %i', (rel, status) => {
        expect(() => readFile(ws(), rel)).toThrow(expect.objectContaining({ status }))
    })

    it('refuses to list a file', () => {
        expect(() => listDir(ws(), 'MEMORY.md')).toThrow(expect.objectContaining({ status: 400 }))
    })

    it('413 over the size cap, 415 for binary', () => {
        const root = ws()
        fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1))
        fs.writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
        expect(() => readFile(root, 'big.txt')).toThrow(expect.objectContaining({ status: 413 }))
        expect(() => readFile(root, 'img.png')).toThrow(expect.objectContaining({ status: 415 }))
        expect(looksBinary(Buffer.from('teks biasa'))).toBe(false)
    })
})

describe('git log', () => {
    it('parses the separator-delimited format', () => {
        const out = 'abc\x1f2026-09-30T10:00:00+07:00\x1fKilla\x1ftulis memori\x1e\ndef\x1f2026-09-29T09:00:00+07:00\x1fHenry\x1finit\x1e\n'
        expect(parseGitLog(out)).toEqual([
            { hash: 'abc', date: '2026-09-30T10:00:00+07:00', author: 'Killa', subject: 'tulis memori' },
            { hash: 'def', date: '2026-09-29T09:00:00+07:00', author: 'Henry', subject: 'init' },
        ])
    })

    const fakeSpawn = (behave: (child: EventEmitter & { stdout: EventEmitter; kill: () => void }) => void) =>
        vi.fn(() => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() })
            setImmediate(() => behave(child))
            return child
        }) as never

    it('passes the limit as an argument, never through a shell', async () => {
        const spawn = fakeSpawn(c => { c.stdout.emit('data', Buffer.from('h\x1fd\x1fa\x1fs\x1e')); c.emit('close', 0) })
        expect(await gitLog('/ws', 5, spawn)).toHaveLength(1)
        expect(spawn).toHaveBeenCalledWith('git', ['log', '-n5', expect.stringMatching(/^--format=/)],
                                           expect.objectContaining({ cwd: '/ws' }))
    })

    it('is empty for a non-repo, a missing git, or a hang', async () => {
        expect(await gitLog('/ws', 5, fakeSpawn(c => c.emit('close', 128)))).toEqual([])
        expect(await gitLog('/ws', 5, fakeSpawn(c => c.emit('error', new Error('ENOENT'))))).toEqual([])
        expect(await gitLog('/ws', 5, fakeSpawn(() => {}), 5)).toEqual([])
    })
})

describe('auth', () => {
    it.each([
        [undefined, false], ['', false], ['rahasia', false], ['Bearer salah', false],
        ['Bearer rahasiaa', false], ['Basic rahasia', false], ['Bearer rahasia', true], ['bearer  rahasia', true],
    ])('authorized(%j) = %s', (header, ok) => {
        expect(authorized(header, 'rahasia')).toBe(ok)
    })

    it('never authorizes against an empty token', () => {
        expect(authorized('Bearer ', '')).toBe(false)
    })

    it.each([[null, 20], ['', 20], ['5', 5], ['9999', 200]])('intParam(%j) = %i', (v, n) => {
        expect(intParam(v, 20, 200)).toBe(n)
    })

    it.each(['0', '-1', 'abc', '1.5'])('intParam rejects %j', v => {
        expect(() => intParam(v, 20, 200)).toThrow()
    })
})

describe('server', () => {
    let server: http.Server | null = null
    afterEach(() => { server?.close(); server = null })

    async function start(deps: Deps, workspaceDir = '/ws-ghina') {
        server = createHttpServer({ http: { ...HTTP, workspaceDir }, deps })
        await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
        const { port } = server.address() as AddressInfo
        return async (method: string, url: string, body?: unknown, token: string | null = 'rahasia') => {
            const res = await fetch(`http://127.0.0.1:${port}${url}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
            })
            return { status: res.status, json: await res.json() as Record<string, unknown> }
        }
    }

    it.each([null, 'salah'])('rejects token %j with 401 on every route, before running anything', async token => {
        const deps = httpDeps()
        const call = await start(deps)
        for (const [m, u] of [['POST', '/v1/chat'], ['GET', '/v1/workspace/files'], ['GET', '/nope']]) {
            expect(await call(m!, u!, m === 'POST' ? { chatKey: 'u1', text: 'halo' } : undefined, token))
                .toEqual({ status: 401, json: { error: 'unauthorized' } })
        }
        expect(deps.runAgent).not.toHaveBeenCalled()
    })

    it('POST /v1/chat runs a turn and returns the reply', async () => {
        const call = await start(httpDeps())
        expect(await call('POST', '/v1/chat', { chatKey: 'u1', text: 'halo' }))
            .toEqual({ status: 200, json: { reply: 'halo' } })
    })

    it.each([
        [{ text: 'halo' }], [{ chatKey: 'u 1', text: 'halo' }], [{ chatKey: 'u1' }], [{ chatKey: 'u1', text: '  ' }],
        [{ chatKey: 'u1', text: 'halo', model: '--x y' }], ['not json'], [[1, 2]],
    ])('POST /v1/chat 400 on %j', async body => {
        const deps = httpDeps()
        const call = await start(deps)
        expect((await call('POST', '/v1/chat', body)).status).toBe(400)
        expect(deps.runAgent).not.toHaveBeenCalled()
    })

    it('POST /v1/chat 502 when the agent turn failed outright', async () => {
        const call = await start(httpDeps({ runAgent: vi.fn(async () => { throw new Error('boom') }) }))
        expect((await call('POST', '/v1/chat', { chatKey: 'u1', text: 'halo' })).status).toBe(502)
    })

    it('POST /v1/chat/new then GET history', async () => {
        const deps = httpDeps()
        const call = await start(deps)
        await call('POST', '/v1/chat', { chatKey: 'u1', text: 'hai' })
        const hist = await call('GET', '/v1/chat/history?chatKey=u1&limit=5')
        expect(hist.json.messages).toEqual([
            { at: expect.any(Number), who: 'user', text: 'hai' },
            { at: expect.any(Number), who: 'agent', text: 'halo' },
        ])
        expect(await call('POST', '/v1/chat/new', { chatKey: 'u1' })).toEqual({ status: 200, json: { ok: true } })
        expect((await call('GET', '/v1/chat/history?chatKey=u1')).json).toEqual({ messages: [] })
    })

    it('workspace endpoints: listing, file, traversal', async () => {
        const root = tmp()
        fs.writeFileSync(path.join(root, 'SOUL.md'), 'jiwa')
        const call = await start(httpDeps(), root)
        expect((await call('GET', '/v1/workspace/files')).json).toEqual({ entries: [{ name: 'SOUL.md', type: 'file', size: 4 }] })
        expect((await call('GET', '/v1/workspace/file?path=SOUL.md')).json).toEqual({ path: 'SOUL.md', content: 'jiwa' })
        expect((await call('GET', '/v1/workspace/file?path=..%2F..%2Fetc%2Fpasswd')).status).toBe(400)
        expect((await call('GET', '/v1/workspace/files?path=%2Fetc')).status).toBe(400)
        expect((await call('GET', '/v1/workspace/file')).status).toBe(400)
    })

    it('git log on a non-repo is an empty list', async () => {
        const call = await start(httpDeps(), tmp())
        expect((await call('GET', '/v1/git/log?limit=3')).json).toEqual({ commits: [] })
        expect((await call('GET', '/v1/git/log?limit=0')).status).toBe(400)
    })

    it('404 for unknown paths, 405 for a known path with the wrong method', async () => {
        const call = await start(httpDeps())
        expect((await call('GET', '/v1/nope')).status).toBe(404)
        expect((await call('GET', '/v1/chat')).status).toBe(405)
    })

    it('500 hides the message and logs it', async () => {
        const log = vi.fn()
        const deps = httpDeps({ log })
        deps.transcripts.recent = () => { throw new Error('disk rusak') }
        const call = await start(deps)
        expect(await call('GET', '/v1/chat/history?chatKey=u1')).toEqual({ status: 500, json: { error: 'internal error' } })
        expect(log).toHaveBeenCalledWith('main', expect.stringContaining('disk rusak'))
    })

    it('allows a request to run as long as an agent turn', () => {
        const s = createHttpServer({ http: HTTP, deps: httpDeps() })
        expect(s.requestTimeout).toBeGreaterThan(testConfig().agentTimeoutMs)
    })
})
