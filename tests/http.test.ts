import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { targetFor } from '../src/config.ts'
import { chatKey, dispatch } from '../src/core/dispatch.ts'
import { cancelHttpReminder, chatIdentity, ChatKeyForbidden, collectingChat, httpHistory, httpIdentity, httpReminders,
         httpStateKey, isChatKey, isModelName, resetHttpChat, runHttpTurn } from '../src/http/chat.ts'
import { ALLOWED_MIME_TYPES, contentTypeFor, MAX_MEDIA_BYTES, MAX_SERVE_BYTES, mediaRoots, parseMedia, resolveMedia,
         safeName, saveMedia } from '../src/http/media.ts'
import { authorized, createHttpServer, intParam } from '../src/http/server.ts'
import { deleteFile, gitCommit, gitLog, isHidden, listDir, looksBinary, MAX_FILE_BYTES, MAX_WRITE_BYTES,
         parseGitLog, readFile, resolveInside, runGit, WorkspaceError, writeFile } from '../src/http/workspace.ts'
import type { Deps } from '../src/core/ports.ts'
import type { HttpConfig } from '../src/types.ts'
import { fakeChat, flush, makeDeps, testConfig } from './helpers.ts'

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
        const chat = collectingChat({ ...HTTP, account: 'kerja' }, httpIdentity('u1'))
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
        expect(httpHistory(HTTP, deps, 'u1', 20)).toHaveLength(2)
        await resetHttpChat(HTTP, deps, 'u1')
        expect(deps.sessions.get(httpStateKey('u1'))).toBeNull()
        expect(httpHistory(HTTP, deps, 'u1', 20)).toEqual([])
    })

    it('history returns the last N lines', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'halo')
        expect(httpHistory(HTTP, deps, 'u1', 1)).toEqual([expect.objectContaining({ who: 'agent', text: 'halo' })])
    })

    it('returns an empty reply when the turn threw', async () => {
        const deps = httpDeps({ runAgent: vi.fn(async () => { throw new Error('boom') }) })
        expect(await runHttpTurn(HTTP, deps, 'u1', 'halo')).toEqual({ reply: '', attachments: [] })
    })
})

describe('wa:<number> chatKey — the owner\'s WhatsApp DM', () => {
    const WA_KEY = '628111@s.whatsapp.net#628111'
    const msg = (text: string) => ({ text, hasFile: false, file: null })

    it('maps an owner number to the WhatsApp DM identity and state key', () => {
        const id = chatIdentity(testConfig({ http: HTTP }), HTTP, 'wa:628111')
        expect(id).toEqual({ jid: '628111@s.whatsapp.net', number: '628111' })
        expect(chatKey(id)).toBe(WA_KEY)
        // Same key the gateway's chat produces, whether WhatsApp used a PN or a LID jid.
        expect(chatKey(fakeChat())).toBe(WA_KEY)
        expect(chatKey(fakeChat({ jid: '99887766@lid' }))).toBe(WA_KEY)
    })

    it.each(['wa:628999', 'wa:', 'wa:abc', 'wa:+628111'])('%s is forbidden (403)', key => {
        expect(() => chatIdentity(testConfig({ http: HTTP }), HTTP, key)).toThrow(ChatKeyForbidden)
        try { chatIdentity(testConfig({ http: HTTP }), HTTP, key) } catch (e) { expect((e as ChatKeyForbidden).status).toBe(403) }
    })

    it('checks owners of HTTP_ACCOUNT, not the global list', () => {
        const config = testConfig({ accounts: ['main', 'kerja'], perAccount: { kerja: { ownerNumbers: ['628222'] } } })
        const kerja = { ...HTTP, account: 'kerja' }
        expect(chatIdentity(config, kerja, 'wa:628222').number).toBe('628222')
        expect(() => chatIdentity(config, kerja, 'wa:628111')).toThrow(ChatKeyForbidden)
    })

    it('runs in the DM\'s workspace (contact persona included), not the HTTP one', async () => {
        const deps = makeDeps({ config: testConfig({ http: HTTP, contactWorkspaces: { 628111: '/ws-owner' } }) })
        await runHttpTurn(HTTP, deps, 'wa:628111', 'halo')
        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/ws-owner' }))
    })

    it('shares session, transcript and model with the WhatsApp DM', async () => {
        const deps = httpDeps()
        const chat = fakeChat()
        await dispatch(chat, msg('/model opus'), deps)
        await dispatch(chat, msg('dari wa'), deps)
        await flush()
        await runHttpTurn(HTTP, deps, 'wa:628111', 'dari ghina')
        const runs = vi.mocked(deps.runAgent).mock.calls.map(c => c[0])
        expect(runs.map(r => [r.sessionId, r.model])).toEqual([[null, 'opus'], ['sess-1', 'opus']])
        expect(httpHistory(HTTP, deps, 'wa:628111', 10).map(l => l.text)).toEqual(['dari wa', 'halo', 'dari ghina', 'halo'])
        // A WhatsApp /new also resets what Ghina sees.
        await dispatch(chat, msg('/new'), deps)
        await flush()
        expect(httpHistory(HTTP, deps, 'wa:628111', 10)).toEqual([])
    })

    it('serializes turns across both channels on one queue', async () => {
        const releases: (() => void)[] = []
        const deps = httpDeps({
            runAgent: vi.fn(() => new Promise<{ reply: string; sessionId: string }>(r => {
                releases.push(() => r({ reply: `r${releases.length}`, sessionId: 's' }))
            })),
        })
        const chat = fakeChat()
        await dispatch(chat, msg('dari wa'), deps)
        await flush()
        const http = runHttpTurn(HTTP, deps, 'wa:628111', 'dari ghina')
        await flush(); await flush()
        expect(deps.runAgent).toHaveBeenCalledTimes(1)
        releases[0]!()
        await flush(); await flush()
        expect(deps.runAgent).toHaveBeenCalledTimes(2)
        releases[1]!()
        expect((await http).reply).toBe('r2')
        expect(chat.texts).toEqual(['r1'])
    })

    it('files reminders under the owner number and DM jid, so they list on both sides and fire on WhatsApp', async () => {
        const deps = httpDeps({ runAgent: vi.fn(async () => ({ reply: 'ok [[remind:in 1h|minum]]', sessionId: 's' })) })
        await runHttpTurn(HTTP, deps, 'wa:628111', 'ingetin')
        expect(deps.reminders.list('628111')).toEqual([expect.objectContaining({
            number: '628111', jid: '628111@s.whatsapp.net', account: 'main', text: 'minum' })])
        const chat = fakeChat()
        await dispatch(chat, msg('/reminders'), deps)
        expect(chat.texts[0]).toContain('minum')
    })

    it('HTTP turns on a wa: key are delivered to the caller, never to WhatsApp', async () => {
        const deps = httpDeps()
        const out = await runHttpTurn(HTTP, deps, 'wa:628111', 'halo')
        expect(out.reply).toBe('halo')
        expect(collectingChat(HTTP, httpIdentity('x')).channel).toBe('http')
    })
})

describe('reminders over HTTP', () => {
    it('lists and cancels by chat, and cannot touch another chat\'s reminder', () => {
        const deps = httpDeps()
        const mine = deps.reminders.add({ spec: 'in 1h', text: 'minum', number: 'http:u1', account: 'main', jid: 'http:u1' })!
        const wa = deps.reminders.add({ spec: 'daily 07:00', text: 'olahraga', number: '628111', account: 'main',
                                        jid: '628111@s.whatsapp.net' })!
        expect(httpReminders(HTTP, deps, 'u1')).toEqual([{ id: mine.id, spec: 'in 1h', text: 'minum', nextAt: mine.nextAt }])
        expect(httpReminders(HTTP, deps, 'wa:628111')).toEqual([expect.objectContaining({ id: wa.id, text: 'olahraga' })])
        expect(httpReminders(HTTP, deps, 'u2')).toEqual([])
        expect(cancelHttpReminder(HTTP, deps, 'u2', mine.id)).toBe(false)
        expect(cancelHttpReminder(HTTP, deps, 'u1', mine.id)).toBe(true)
        expect(cancelHttpReminder(HTTP, deps, 'u1', mine.id)).toBe(false)
        expect(cancelHttpReminder(HTTP, deps, 'wa:628111', wa.id)).toBe(true)
    })
})

describe('inbound media', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64')

    it('accepts the allowlist and classifies it', () => {
        const items = parseMedia([
            { name: 'foto.png', mimeType: 'image/png', dataBase64: b64('png') },
            { name: 'laporan.pdf', mimeType: 'application/pdf; charset=binary', dataBase64: b64('pdf') },
            { mimeType: 'audio/ogg', dataBase64: b64('ogg') },
        ])
        expect(items.map(i => [i.name, i.kind, i.data.toString()])).toEqual([
            ['foto.png', 'image', 'png'], ['laporan.pdf', 'document', 'pdf'], ['lampiran.ogg', 'audio', 'ogg']])
        expect(parseMedia(undefined)).toEqual([])
        expect(ALLOWED_MIME_TYPES).toContain('text/plain')
    })

    it.each([
        ['not an array', {}, 400],
        ['too many', Array(4).fill({ mimeType: 'text/plain', dataBase64: 'YQ==' }), 413],
        ['missing data', [{ mimeType: 'text/plain' }], 400],
        ['not an object', ['x'], 400],
        ['bad name', [{ name: 3, mimeType: 'text/plain', dataBase64: 'YQ==' }], 400],
        ['html', [{ mimeType: 'text/html', dataBase64: 'YQ==' }], 415],
        ['svg', [{ mimeType: 'image/svg+xml', dataBase64: 'YQ==' }], 415],
        ['executable', [{ mimeType: 'application/x-msdownload', dataBase64: 'YQ==' }], 415],
        ['empty mime', [{ mimeType: '', dataBase64: 'YQ==' }], 415],
        ['bad base64', [{ mimeType: 'text/plain', dataBase64: 'a$b=' }], 400],
        ['empty base64', [{ mimeType: 'text/plain', dataBase64: '' }], 400],
        ['over 8 MB', [{ mimeType: 'image/png', dataBase64: 'A'.repeat(Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 8) }], 413],
    ])('rejects %s', (_label, media, status) => {
        expect(() => parseMedia(media)).toThrow(expect.objectContaining({ status }))
    })

    it('accepts exactly 8 MB', () => {
        const data = Buffer.alloc(MAX_MEDIA_BYTES, 1).toString('base64')
        expect(parseMedia([{ mimeType: 'image/png', dataBase64: data }])[0]!.data.length).toBe(MAX_MEDIA_BYTES)
    })

    it('never lets a filename escape the media dir', () => {
        expect(safeName('../../etc/passwd')).toBe('passwd')
        expect(safeName('..\\..\\x.pdf')).toBe('x.pdf')
        expect(safeName('..')).toBe('dokumen')
        expect(safeName('a<b>.md')).toBe('a_b_.md')
    })

    it('saves like WhatsApp media: in-<ms>, one file per item, no collisions', () => {
        const dir = path.join(tmp(), 'media')
        const files = saveMedia(parseMedia([
            { mimeType: 'image/jpeg', dataBase64: b64('a') }, { mimeType: 'image/jpeg', dataBase64: b64('b') },
            { name: '../laporan.pdf', mimeType: 'application/pdf', dataBase64: b64('c') },
        ]), dir, () => 42)
        expect(files).toEqual([
            { path: path.join(dir, 'in-42-0.jpeg'), kind: 'image', name: 'lampiran.jpeg' },
            { path: path.join(dir, 'in-42-1.jpeg'), kind: 'image', name: 'lampiran.jpeg' },
            { path: path.join(dir, 'in-42-2-laporan.pdf'), kind: 'document', name: 'laporan.pdf' },
        ])
        expect(files.map(f => fs.readFileSync(f.path, 'utf8'))).toEqual(['a', 'b', 'c'])
        expect(saveMedia([], path.join(dir, 'never'))).toEqual([])
        expect(fs.existsSync(path.join(dir, 'never'))).toBe(false)
    })

    it('hands every file to the agent in the prompt, like WhatsApp media', async () => {
        const deps = httpDeps()
        await runHttpTurn(HTTP, deps, 'u1', 'lihat ini', undefined, [
            { path: '/m/in-1-0.png', kind: 'image', name: 'lampiran.png' },
            { path: '/m/in-1-1-a.pdf', kind: 'document', name: 'a.pdf' },
            { path: '/m/in-1-2.ogg', kind: 'audio', name: 'vn.ogg' },
        ])
        const { text } = vi.mocked(deps.runAgent).mock.calls[0]![0]
        expect(text).toContain('lihat ini')
        expect(text).toContain('gambar. File-nya ada di /m/in-1-0.png')
        expect(text).toContain('dokumen "a.pdf". File-nya ada di /m/in-1-1-a.pdf')
        expect(text).toContain('audio "vn.ogg". File-nya ada di /m/in-1-2.ogg')
        expect(httpHistory(HTTP, deps, 'u1', 1)).toBeDefined()
    })
})

describe('GET /v1/media path fence', () => {
    function roots() {
        const ws = tmp()
        const media = tmp()
        const outside = tmp()
        fs.mkdirSync(path.join(ws, 'out'))
        fs.writeFileSync(path.join(ws, 'out', 'a.png'), 'png')
        fs.writeFileSync(path.join(ws, '.env'), 'PASS=x')
        fs.mkdirSync(path.join(ws, '.git'))
        fs.writeFileSync(path.join(ws, '.git', 'config'), 'x')
        fs.writeFileSync(path.join(media, 'in-1.jpeg'), 'jpg')
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'rahasia')
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'))
        fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'env-link.txt'))
        fs.mkdirSync(path.join(ws, 'dir'))
        return { ws, media, outside, list: [ws, media] }
    }

    it('serves absolute paths inside any root, and relative paths from the first', () => {
        const r = roots()
        expect(resolveMedia(r.list, path.join(r.ws, 'out', 'a.png'))).toEqual({ file: fs.realpathSync(path.join(r.ws, 'out', 'a.png')), size: 3 })
        expect(resolveMedia(r.list, path.join(r.media, 'in-1.jpeg')).size).toBe(3)
        expect(resolveMedia(r.list, 'out/a.png').size).toBe(3)
    })

    it.each([
        ['outside every root', (r: ReturnType<typeof roots>) => path.join(r.outside, 'secret.txt'), 400],
        ['traversal', (r: ReturnType<typeof roots>) => `${r.ws}/out/../../x`, 400],
        ['relative traversal', () => '../etc/passwd', 400],
        ['a symlink pointing out', () => 'link.txt', 400],
        ['.env', () => '.env', 400],
        ['.git', (r: ReturnType<typeof roots>) => path.join(r.ws, '.git', 'config'), 400],
        ['a symlink onto .env', () => 'env-link.txt', 400],
        ['NUL', () => 'a\0b', 400],
        ['empty', () => '', 400],
        ['/etc/passwd', () => '/etc/passwd', 400],
        ['missing', () => 'out/nope.png', 404],
        ['a directory', () => 'dir', 400],
        ['the root itself', (r: ReturnType<typeof roots>) => r.ws, 400],
    ])('refuses %s', (_label, p, status) => {
        const r = roots()
        expect(() => resolveMedia(r.list, p(r))).toThrow(expect.objectContaining({ status }))
    })

    it('refuses a file over the serve cap', () => {
        const r = roots()
        fs.writeFileSync(path.join(r.ws, 'big.bin'), '')
        fs.truncateSync(path.join(r.ws, 'big.bin'), MAX_SERVE_BYTES + 1)
        expect(() => resolveMedia(r.list, 'big.bin')).toThrow(expect.objectContaining({ status: 413 }))
    })

    it('roots are the HTTP workspace, each owner\'s workspace and the media dir', () => {
        const config = testConfig({ http: HTTP, ownerNumbers: ['628111', '628222'], contactWorkspaces: { 628222: '/ws-2' } })
        expect(mediaRoots(config, HTTP)).toEqual(['/ws-ghina', '/ws', '/ws-2', '/root/state/media'])
    })

    it('types: images and pdf as themselves, text with a charset, the rest as octet-stream', () => {
        expect(contentTypeFor('a.PNG')).toBe('image/png')
        expect(contentTypeFor('a.pdf')).toBe('application/pdf')
        expect(contentTypeFor('a.md')).toBe('text/markdown; charset=utf-8')
        expect(contentTypeFor('a.html')).toBe('application/octet-stream')
        expect(contentTypeFor('a.svg')).toBe('application/octet-stream')
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

describe('workspace writes', () => {
    const ws = () => {
        const root = tmp()
        fs.mkdirSync(path.join(root, '.git'))
        fs.writeFileSync(path.join(root, 'a.md'), 'lama')
        return root
    }

    it('writes a file, creating parent dirs', () => {
        const root = ws()
        expect(writeFile(root, 'memory/2026/10-01.md', 'baru')).toBe('memory/2026/10-01.md')
        expect(fs.readFileSync(path.join(root, 'memory/2026/10-01.md'), 'utf8')).toBe('baru')
        writeFile(root, 'a.md', 'ganti')
        expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('ganti')
    })

    it.each(['../x.md', 'a/../../x', '/etc/x', '', '.', '.git/config', '.git/hooks/pre-commit', '.GIT/config',
             'sub/.Git/x', '.env', 'x/.env.local', 'node_modules/x.js'])('refuses to write %j', rel => {
        const root = ws()
        expect(() => writeFile(root, rel, 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(fs.readdirSync(path.join(root, '.git'))).toEqual([])
    })

    it('413 over the write cap, counted in UTF-8 bytes', () => {
        const root = ws()
        expect(() => writeFile(root, 'big.md', 'é'.repeat(MAX_WRITE_BYTES / 2 + 1)))
            .toThrow(expect.objectContaining({ status: 413 }))
        expect(fs.existsSync(path.join(root, 'big.md'))).toBe(false)
        writeFile(root, 'ok.md', 'a'.repeat(MAX_WRITE_BYTES))
    })

    it('refuses a directory target', () => {
        const root = ws()
        fs.mkdirSync(path.join(root, 'dir'))
        expect(() => writeFile(root, 'dir', 'x')).toThrow(expect.objectContaining({ status: 400 }))
    })

    it('refuses to write through a symlinked dir out of the workspace', () => {
        const root = ws()
        const outside = tmp()
        fs.symlinkSync(outside, path.join(root, 'link'))
        expect(() => writeFile(root, 'link/x.md', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => writeFile(root, 'link/new/deep.md', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(fs.readdirSync(outside)).toEqual([])
    })

    it('refuses a symlink that leads into .git', () => {
        const root = ws()
        fs.symlinkSync(path.join(root, '.git'), path.join(root, 'g'))
        expect(() => writeFile(root, 'g/config', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref')
        fs.symlinkSync(path.join(root, '.git', 'HEAD'), path.join(root, 'head'))
        expect(() => writeFile(root, 'head', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8')).toBe('ref')
    })

    it('refuses file symlinks and dangling symlinks that point out', () => {
        const root = ws()
        const outside = tmp()
        fs.writeFileSync(path.join(outside, 'secret'), 's')
        fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'file-link'))
        fs.symlinkSync(path.join(outside, 'nope'), path.join(root, 'dangling'))
        fs.symlinkSync(path.join(outside, 'nodir'), path.join(root, 'dangling-dir'))
        expect(() => writeFile(root, 'file-link', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => writeFile(root, 'dangling', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(() => writeFile(root, 'dangling-dir/x.md', 'x')).toThrow(expect.objectContaining({ status: 400 }))
        expect(fs.readdirSync(outside)).toEqual(['secret'])
        expect(fs.readFileSync(path.join(outside, 'secret'), 'utf8')).toBe('s')
    })

    it('writes through a symlink that stays inside', () => {
        const root = ws()
        fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'alias.md'))
        writeFile(root, 'alias.md', 'lewat link')
        expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('lewat link')
    })

    it('404 when the workspace itself is gone', () => {
        expect(() => writeFile(path.join(tmp(), 'gone'), 'a.md', 'x')).toThrow(expect.objectContaining({ status: 404 }))
    })

    it('deletes a file; refuses dirs, missing files, hidden and outside paths', () => {
        const root = ws()
        fs.mkdirSync(path.join(root, 'dir'))
        deleteFile(root, 'a.md')
        expect(fs.existsSync(path.join(root, 'a.md'))).toBe(false)
        expect(() => deleteFile(root, 'a.md')).toThrow(expect.objectContaining({ status: 404 }))
        expect(() => deleteFile(root, 'dir')).toThrow(expect.objectContaining({ status: 400 }))
        for (const rel of ['../x', '.git/HEAD', '.env', ''])
            expect(() => deleteFile(root, rel)).toThrow(expect.objectContaining({ status: 400 }))
    })

    it('deleting a symlink removes the link, never its target', () => {
        const root = ws()
        const outside = tmp()
        fs.writeFileSync(path.join(outside, 'keep'), 'k')
        fs.symlinkSync(path.join(outside, 'keep'), path.join(root, 'link'))
        fs.symlinkSync(outside, path.join(root, 'dirlink'))
        expect(() => deleteFile(root, 'dirlink/keep')).toThrow(expect.objectContaining({ status: 400 }))
        deleteFile(root, 'link')
        expect(fs.existsSync(path.join(root, 'link'))).toBe(false)
        expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('k')
    })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const gitRepo = () => {
    const root = tmp()
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Killa')
    git(root, 'config', 'user.email', 'killa@example.com')
    git(root, 'config', 'commit.gpgsign', 'false')
    git(root, 'config', 'core.hooksPath', '/dev/null')
    return root
}

describe('git commit', () => {
    it('adds everything and commits; clean when nothing changed', async () => {
        const root = gitRepo()
        expect(await gitCommit(root, 'x')).toEqual({ ok: true, hash: null, clean: true })
        fs.writeFileSync(path.join(root, 'a.md'), 'satu')
        const first = await gitCommit(root, '--amend; rm -rf / $(whoami)')
        expect(first).toEqual({ ok: true, hash: expect.stringMatching(/^[0-9a-f]{40}$/) })
        expect(git(root, 'log', '-1', '--format=%H %s')).toBe(`${first.hash} --amend; rm -rf / $(whoami)`)
        expect(await gitCommit(root, 'lagi')).toEqual({ ok: true, hash: null, clean: true })
        fs.unlinkSync(path.join(root, 'a.md'))
        expect((await gitCommit(root, 'hapus')).hash).toMatch(/^[0-9a-f]{40}$/)
        expect(git(root, 'status', '--porcelain')).toBe('')
    })

    it('400 when the workspace is not a repo, or only a subdir of one', async () => {
        await expect(gitCommit(tmp(), 'x')).rejects.toMatchObject({ status: 400 })
        const root = gitRepo()
        fs.mkdirSync(path.join(root, 'sub'))
        await expect(gitCommit(path.join(root, 'sub'), 'x')).rejects.toMatchObject({ status: 400 })
        await expect(gitCommit(path.join(root, 'gone'), 'x')).rejects.toBeDefined()
    })

    it('throws (-> 500) when a git step fails', async () => {
        const replies = [[0, ''], [0, ''], [2, 'rusak']] as const
        let i = 0
        const root = tmp()
        const spawn = vi.fn(() => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
            const [code, err] = replies[i++]!
            setImmediate(() => {
                if (i === 1) child.stdout.emit('data', Buffer.from(fs.realpathSync(root) + '\n'))
                child.stderr.emit('data', Buffer.from(err))
                child.emit('close', code)
            })
            return child
        }) as never
        await expect(gitCommit(root, 'x', spawn)).rejects.toThrow(/diff gagal \(2\): rusak/)
    })

    it('runGit rejects on spawn error and on timeout', async () => {
        const spawn = (behave: (c: EventEmitter) => void) => vi.fn(() => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
            setImmediate(() => behave(child))
            return child
        }) as never
        await expect(runGit('/ws', ['status'], spawn(c => c.emit('error', new Error('ENOENT'))))).rejects.toThrow('ENOENT')
        await expect(runGit('/ws', ['status'], spawn(() => {}), 5)).rejects.toThrow('timeout')
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

    it('PUT / DELETE /v1/workspace/file', async () => {
        const root = tmp()
        const call = await start(httpDeps(), root)
        expect(await call('PUT', '/v1/workspace/file', { path: 'notes/a.md', content: 'isi' }))
            .toEqual({ status: 200, json: { ok: true, path: 'notes/a.md' } })
        expect((await call('GET', '/v1/workspace/file?path=notes/a.md')).json.content).toBe('isi')
        expect((await call('PUT', '/v1/workspace/file', { path: '../x.md', content: 'x' })).status).toBe(400)
        expect((await call('PUT', '/v1/workspace/file', { path: '.git/config', content: 'x' })).status).toBe(400)
        expect((await call('PUT', '/v1/workspace/file', { path: 'a.md' })).status).toBe(400)
        expect((await call('PUT', '/v1/workspace/file', { content: 'x' })).status).toBe(400)
        expect(await call('PUT', '/v1/workspace/file', { path: 'big.md', content: 'a'.repeat(MAX_WRITE_BYTES + 1) }))
            .toEqual({ status: 413, json: { error: expect.any(String) } })
        expect((await call('DELETE', '/v1/workspace/file?path=..%2Fx')).status).toBe(400)
        expect((await call('DELETE', '/v1/workspace/file')).status).toBe(400)
        expect((await call('DELETE', '/v1/workspace/file?path=notes')).status).toBe(400)
        expect(await call('DELETE', '/v1/workspace/file?path=notes/a.md')).toEqual({ status: 200, json: { ok: true } })
        expect((await call('DELETE', '/v1/workspace/file?path=notes/a.md')).status).toBe(404)
    })

    it('POST /v1/git/commit: commit, clean, default message, not a repo', async () => {
        const root = gitRepo()
        const call = await start(httpDeps(), root)
        expect(await call('POST', '/v1/git/commit', {})).toEqual({ status: 200, json: { ok: true, hash: null, clean: true } })
        await call('PUT', '/v1/workspace/file', { path: 'a.md', content: 'satu' })
        const res = await call('POST', '/v1/git/commit', {})
        expect(res).toEqual({ status: 200, json: { ok: true, hash: expect.stringMatching(/^[0-9a-f]{40}$/) } })
        expect(git(root, 'log', '-1', '--format=%s')).toBe('update via ghina')
        await call('PUT', '/v1/workspace/file', { path: 'b.md', content: 'dua' })
        await call('PUT', '/v1/workspace/file', { path: 'c.md', content: 'tiga' })
        const [r1, r2] = await Promise.all([call('POST', '/v1/git/commit', { message: 'catatan: b' }),
                                            call('POST', '/v1/git/commit', { message: '   ' })])
        expect(r1.json.hash).toMatch(/^[0-9a-f]{40}$/)
        expect(r2.json).toEqual({ ok: true, hash: null, clean: true })
        expect(git(root, 'log', '-1', '--format=%s')).toBe('catatan: b')
        expect((await call('POST', '/v1/git/commit', { message: 42 })).status).toBe(400)
        expect((await call('POST', '/v1/git/commit', { message: 'a\0b' })).status).toBe(400)
        server?.close()
        const call2 = await start(httpDeps(), tmp())
        expect(await call2('POST', '/v1/git/commit', { message: 'x' }))
            .toEqual({ status: 400, json: { error: 'workspace bukan repo git' } })
    })

    it('wa: chatKey: 403 for a non-owner on every chat route, 200 for the owner', async () => {
        const deps = httpDeps()
        const call = await start(deps)
        const forbidden = { status: 403, json: { error: 'chatKey wa: hanya untuk nomor owner' } }
        expect(await call('POST', '/v1/chat', { chatKey: 'wa:628999', text: 'halo' })).toEqual(forbidden)
        expect(await call('POST', '/v1/chat/new', { chatKey: 'wa:628999' })).toEqual(forbidden)
        expect(await call('GET', '/v1/chat/history?chatKey=wa:628999')).toEqual(forbidden)
        expect(await call('GET', '/v1/reminders?chatKey=wa:628999')).toEqual(forbidden)
        expect(await call('POST', '/v1/reminders/cancel', { chatKey: 'wa:628999', id: 1 })).toEqual(forbidden)
        expect(deps.runAgent).not.toHaveBeenCalled()
        expect(await call('POST', '/v1/chat', { chatKey: 'wa:628111', text: 'halo' })).toEqual({ status: 200, json: { reply: 'halo' } })
        expect(deps.sessions.get('628111@s.whatsapp.net#628111')).toBe('sess-1')
    })

    it('GET /v1/reminders and POST /v1/reminders/cancel', async () => {
        const deps = httpDeps()
        const r = deps.reminders.add({ spec: 'daily 07:00', text: 'minum', number: 'http:u1', account: 'main', jid: 'http:u1' })!
        const call = await start(deps)
        expect(await call('GET', '/v1/reminders?chatKey=u1')).toEqual({ status: 200, json: {
            reminders: [{ id: r.id, spec: 'daily 07:00', text: 'minum', nextAt: r.nextAt }] } })
        expect((await call('GET', '/v1/reminders')).status).toBe(400)
        for (const id of [undefined, 0, -1, 1.5, '1']) {
            expect((await call('POST', '/v1/reminders/cancel', { chatKey: 'u1', id })).status).toBe(400)
        }
        expect(await call('POST', '/v1/reminders/cancel', { chatKey: 'u2', id: r.id })).toEqual({ status: 200, json: { ok: false } })
        expect(await call('POST', '/v1/reminders/cancel', { chatKey: 'u1', id: r.id })).toEqual({ status: 200, json: { ok: true } })
        expect((await call('GET', '/v1/reminders?chatKey=u1')).json).toEqual({ reminders: [] })
        expect((await call('GET', '/v1/reminders/cancel')).status).toBe(405)
    })

    it('GET /v1/model and POST /v1/model: same store and rules as /model', async () => {
        const deps = httpDeps()
        const call = await start(deps)
        const options = ['default', 'opus', 'sonnet']
        expect(await call('GET', '/v1/model?chatKey=u1')).toEqual({ status: 200, json: { model: null, options } })
        expect((await call('GET', '/v1/model')).status).toBe(400)

        expect(await call('POST', '/v1/model', { chatKey: 'u1', model: 'Opus' }))
            .toEqual({ status: 200, json: { ok: true, model: 'opus' } })
        expect(deps.probeModel).toHaveBeenLastCalledWith('opus', '/ws-ghina')
        expect(deps.models.get(httpStateKey('u1'))).toBe('opus')
        expect(await call('GET', '/v1/model?chatKey=u1')).toEqual({ status: 200, json: { model: 'opus', options } })
        expect((await call('GET', '/v1/model?chatKey=u2')).json.model).toBeNull()

        // Free-form ids are allowed, as with /model — claude decides.
        expect((await call('POST', '/v1/model', { chatKey: 'u1', model: 'claude-opus-5-5[1m]' })).json)
            .toEqual({ ok: true, model: 'claude-opus-5-5[1m]' })

        vi.mocked(deps.probeModel).mockResolvedValueOnce({ ok: false, message: 'no such model' })
        expect(await call('POST', '/v1/model', { chatKey: 'u1', model: 'bogus' }))
            .toEqual({ status: 400, json: { error: 'no such model' } })
        expect(deps.models.get(httpStateKey('u1'))).toBe('claude-opus-5-5[1m]')

        const probes = vi.mocked(deps.probeModel).mock.calls.length
        expect(await call('POST', '/v1/model', { chatKey: 'u1', model: 'default' }))
            .toEqual({ status: 200, json: { ok: true, model: null } })
        expect(deps.models.get(httpStateKey('u1'))).toBeUndefined()
        expect(deps.probeModel).toHaveBeenCalledTimes(probes)

        for (const model of [undefined, '', 42, 'a b', '--help; rm', 'x'.repeat(101)]) {
            expect((await call('POST', '/v1/model', { chatKey: 'u1', model })).status).toBe(400)
        }
        expect((await call('POST', '/v1/model', { model: 'opus' })).status).toBe(400)
        expect((await call('DELETE', '/v1/model')).status).toBe(405)
    })

    it('/v1/model on a wa: key is the owner DM\'s choice; 403 for a non-owner', async () => {
        const deps = httpDeps()
        const call = await start(deps)
        const forbidden = { status: 403, json: { error: 'chatKey wa: hanya untuk nomor owner' } }
        expect(await call('GET', '/v1/model?chatKey=wa:628999')).toEqual(forbidden)
        expect(await call('POST', '/v1/model', { chatKey: 'wa:628999', model: 'opus' })).toEqual(forbidden)
        expect(deps.probeModel).not.toHaveBeenCalled()

        const chat = fakeChat()
        await dispatch(chat, { text: '/model sonnet', hasFile: false, file: null }, deps)
        expect((await call('GET', '/v1/model?chatKey=wa:628111')).json.model).toBe('sonnet')
        expect((await call('POST', '/v1/model', { chatKey: 'wa:628111', model: 'opus' })).status).toBe(200)
        expect(deps.probeModel).toHaveBeenLastCalledWith('opus', targetFor(deps.config, chat).workspace)
        expect(deps.models.get(chatKey(chat))).toBe('opus')
    })

    it('POST /v1/chat with media: saved to the media dir and named in the prompt', async () => {
        const stateDir = tmp()
        const deps = makeDeps({ config: testConfig({ http: HTTP, mediaDir: path.join(stateDir, 'media') }), now: () => 7 })
        const call = await start(deps)
        const res = await call('POST', '/v1/chat', { chatKey: 'u1', text: '', media: [
            { name: 'foto.png', mimeType: 'image/png', dataBase64: Buffer.from('PNG').toString('base64') }] })
        expect(res).toEqual({ status: 200, json: { reply: 'halo' } })
        const saved = path.join(stateDir, 'media', 'in-7-0.png')
        expect(fs.readFileSync(saved, 'utf8')).toBe('PNG')
        const { text } = vi.mocked(deps.runAgent).mock.calls[0]![0]
        expect(text).toContain(`(tanpa caption)\n\n[User mengirim sebuah gambar. File-nya ada di ${saved}`)
        expect(await call('POST', '/v1/chat', { chatKey: 'u1', text: 'x', media: [{ mimeType: 'text/html', dataBase64: 'YQ==' }] }))
            .toEqual({ status: 415, json: { error: expect.stringContaining('text/html') } })
        expect((await call('POST', '/v1/chat', { chatKey: 'u1', text: '', media: [] })).status).toBe(400)
        expect(deps.runAgent).toHaveBeenCalledTimes(1)
    })

    it('POST /v1/chat takes a multi-megabyte media body, still caps the rest at 1 MB', async () => {
        const deps = makeDeps({ config: testConfig({ http: HTTP, mediaDir: path.join(tmp(), 'media') }) })
        const call = await start(deps)
        const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64')
        expect((await call('POST', '/v1/chat', { chatKey: 'u1', text: 'x', media: [{ mimeType: 'application/pdf', dataBase64: big }] })).status)
            .toBe(200)
        expect((await call('PUT', '/v1/workspace/file', { path: 'a.md', content: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413)
    })

    it('GET /v1/media streams a file with its type, and refuses outside the roots', async () => {
        const root = tmp()
        fs.mkdirSync(path.join(root, 'out'))
        fs.writeFileSync(path.join(root, 'out', 'a.png'), 'PNGDATA')
        const outside = tmp()
        fs.writeFileSync(path.join(outside, 'x.txt'), 'rahasia')
        const deps = httpDeps()
        const call = await start(deps, root)
        const { port } = server!.address() as AddressInfo
        const res = await fetch(`http://127.0.0.1:${port}/v1/media?path=${encodeURIComponent(path.join(root, 'out', 'a.png'))}`,
                                { headers: { Authorization: 'Bearer rahasia' } })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('image/png')
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(await res.text()).toBe('PNGDATA')
        expect((await call('GET', `/v1/media?path=${encodeURIComponent(path.join(outside, 'x.txt'))}`)).status).toBe(400)
        expect((await call('GET', '/v1/media?path=out%2Fnope.png')).status).toBe(404)
        expect((await call('GET', '/v1/media')).status).toBe(400)
        expect((await call('GET', '/v1/media?path=out%2Fa.png', undefined, null)).status).toBe(401)
    })

    it('GET /v1/usage: raw entries in the window plus per-day, per-model and total', async () => {
        const NOW = new Date('2026-10-01T10:00:00+07:00').getTime()
        const deps = httpDeps({ now: () => NOW })
        const e = { chatId: 'c', model: 'sonnet', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0,
                    cacheCreationTokens: 0, costUsd: 0.5, durationMs: 10 }
        deps.usage.record({ ...e, at: NOW - 60_000 })
        deps.usage.record({ ...e, at: NOW - 24 * 3600_000, model: 'opus' })
        deps.usage.record({ ...e, at: NOW - 10 * 24 * 3600_000 })
        const call = await start(deps)
        const { status, json } = await call('GET', '/v1/usage?days=2')
        expect(status).toBe(200)
        expect(json.entries).toHaveLength(2)
        expect(json.days).toEqual([
            expect.objectContaining({ date: '2026-09-30', turns: 1, inputTokens: 1, outputTokens: 2, costUsd: 0.5 }),
            expect.objectContaining({ date: '2026-10-01', turns: 1 }),
        ])
        expect(Object.keys(json.byModel as object).sort()).toEqual(['opus', 'sonnet'])
        expect(json.total).toMatchObject({ turns: 2, costUsd: 1 })
        expect(((await call('GET', '/v1/usage')).json.days as unknown[])).toHaveLength(7)
        expect(((await call('GET', '/v1/usage?days=999')).json.days as unknown[])).toHaveLength(90)
        expect((await call('GET', '/v1/usage?days=0')).status).toBe(400)
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
