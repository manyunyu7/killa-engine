import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildPrompt, deliver, dispatch, NO_REMINDERS } from '../src/core/dispatch.ts'
import { fakeChat, flush, makeDeps } from './helpers.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const msg = (text: string) => ({ text, hasImage: false, imagePath: null })

describe('slash commands', () => {
    it('/new clears the session and says so', async () => {
        const deps = makeDeps()
        deps.sessions.remember('628111', 'sess-1')
        const chat = fakeChat()

        expect(await dispatch(chat, msg('/new'), deps)).toBe(true)
        expect(deps.sessions.get('628111')).toBeNull()
        expect(chat.texts[0]).toContain('sesi baru')
    })

    it('/reminders lists nothing helpfully when empty', async () => {
        const chat = fakeChat()
        await dispatch(chat, msg('/reminders'), makeDeps())
        expect(chat.texts[0]).toBe(NO_REMINDERS)
    })

    it('/reminders shows only this chat’s reminders with cancel help', async () => {
        const deps = makeDeps()
        deps.reminders.add({ spec: 'daily 07:00', text: 'bangunn', number: '628111', account: 'main', jid: 'j' })
        deps.reminders.add({ spec: 'daily 08:00', text: 'punya orang lain', number: '628999', account: 'main', jid: 'j' })
        const chat = fakeChat()

        await dispatch(chat, msg('/reminders'), deps)
        expect(chat.texts[0]).toContain('bangunn')
        expect(chat.texts[0]).not.toContain('punya orang lain')
        expect(chat.texts[0]).toContain('/cancel')
    })

    it('/cancel removes the reminder and confirms', async () => {
        const deps = makeDeps()
        const r = deps.reminders.add({ spec: 'daily 07:00', text: 'bangunn', number: '628111', account: 'main', jid: 'j' })!
        const chat = fakeChat()

        await dispatch(chat, msg(`/cancel ${r.id}`), deps)
        expect(chat.texts[0]).toContain('Dibatalkan')
        expect(deps.reminders.list('628111')).toHaveLength(0)
    })

    it.each(['/cancel', '/cancel abc', '/cancel 999'])('%s reports a miss instead of throwing', async cmd => {
        const chat = fakeChat()
        await dispatch(chat, msg(cmd), makeDeps())
        expect(chat.texts[0]).toContain('tidak ketemu')
    })

    it('/model with no argument shows the current choice and the aliases', async () => {
        const chat = fakeChat()
        await dispatch(chat, msg('/model'), makeDeps())
        expect(chat.texts[0]).toContain('default')
        expect(chat.texts[0]).toContain('opus | sonnet')
    })

    it('/model <name> probes claude before saving', async () => {
        const deps = makeDeps()
        const chat = fakeChat()

        await dispatch(chat, msg('/model opus'), deps)
        expect(deps.probeModel).toHaveBeenCalledWith('opus', '/ws')
        expect(deps.models.get('628111')).toBe('opus')
        expect(chat.texts.at(-1)).toContain('pakai opus')
    })

    it('/model <name> relays claude’s rejection and keeps the old model', async () => {
        const deps = makeDeps({ probeModel: vi.fn(async () => ({ ok: false, message: 'no such model' })) })
        deps.models.set('628111', 'opus')
        const chat = fakeChat()

        await dispatch(chat, msg('/model bogus'), deps)
        expect(chat.texts.at(-1)).toContain('no such model')
        expect(deps.models.get('628111')).toBe('opus')
    })

    it('/model default clears the choice without probing', async () => {
        const deps = makeDeps()
        deps.models.set('628111', 'opus')
        const chat = fakeChat()

        await dispatch(chat, msg('/model default'), deps)
        expect(deps.models.get('628111')).toBeUndefined()
        expect(deps.probeModel).not.toHaveBeenCalled()
    })

    it('ignores surrounding whitespace on commands', async () => {
        const chat = fakeChat()
        expect(await dispatch(chat, msg('  /new  '), makeDeps())).toBe(true)
    })

    it('treats a message that merely mentions a command as chat', async () => {
        const deps = makeDeps()
        expect(await dispatch(fakeChat(), msg('gimana cara pakai /new ya'), deps)).toBe(false)
        await flush()
        expect(deps.runAgent).toHaveBeenCalled()
    })
})

describe('agent turn', () => {
    it('runs the agent, replies, and remembers the session', async () => {
        const deps = makeDeps()
        const chat = fakeChat()

        await dispatch(chat, msg('halo'), deps)
        await flush()

        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({
            text: 'halo', sessionId: null, workspace: '/ws', timeoutMs: 300_000,
        }))
        expect(chat.texts).toEqual(['halo'])
        expect(deps.sessions.get('628111')).toBe('sess-1')
        expect(chat.presences).toEqual(['composing', 'paused'])
    })

    it('resumes an existing session and passes the chosen model', async () => {
        const deps = makeDeps()
        deps.sessions.remember('628111', 'sess-9')
        deps.models.set('628111', 'opus')

        await dispatch(fakeChat(), msg('halo'), deps)
        await flush()

        expect(deps.runAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-9', model: 'opus' }))
    })

    it('serializes turns per chat', async () => {
        const order: string[] = []
        const deps = makeDeps({
            runAgent: vi.fn(async ({ text }) => {
                order.push(`start:${text}`)
                await new Promise(r => setTimeout(r, 5))
                order.push(`end:${text}`)
                return { reply: text, sessionId: 's' }
            }),
        })
        const chat = fakeChat()

        await dispatch(chat, msg('satu'), deps)
        await dispatch(chat, msg('dua'), deps)
        await new Promise(r => setTimeout(r, 40))

        expect(order).toEqual(['start:satu', 'end:satu', 'start:dua', 'end:dua'])
    })

    it('survives a chat that cannot show presence', async () => {
        const chat = fakeChat({ presence: async () => { throw new Error('no presence') } })
        const deps = makeDeps()

        await dispatch(chat, msg('halo'), deps)
        await flush()
        expect(chat.texts).toEqual(['halo'])
    })
})

describe('buildPrompt', () => {
    it('passes plain text through', () => {
        expect(buildPrompt(msg('halo'))).toBe('halo')
    })

    it('tells the agent where a downloaded image is', () => {
        const p = buildPrompt({ text: 'lucu kan', hasImage: true, imagePath: '/tmp/a.jpg' })
        expect(p).toContain('lucu kan')
        expect(p).toContain('/tmp/a.jpg')
    })

    it('marks a captionless image', () => {
        expect(buildPrompt({ text: '', hasImage: true, imagePath: '/tmp/a.jpg' })).toContain('(tanpa caption)')
    })

    it('admits a failed download instead of pretending', () => {
        expect(buildPrompt({ text: 'nih', hasImage: true, imagePath: null })).toContain('gagal diunduh')
    })
})

describe('deliver', () => {
    it('splits a long reply into chunks', async () => {
        const chat = fakeChat()
        await deliver(chat, 'a'.repeat(8000), makeDeps())
        expect(chat.texts).toHaveLength(3)
    })

    it('sends images named by a marker', async () => {
        const chat = fakeChat()
        await deliver(chat, 'nih [[send:/tmp/a.png]]', makeDeps())
        expect(chat.texts).toEqual(['nih'])
        expect(chat.imagesSent).toEqual(['/tmp/a.png'])
    })

    it('skips an image the agent hallucinated', async () => {
        const chat = fakeChat()
        await deliver(chat, 'nih [[send:/nope.png]]', makeDeps({ fileExists: () => false }))
        expect(chat.imagesSent).toEqual([])
        expect(chat.texts).toEqual(['nih'])
    })

    it('tells the user when an image fails to send', async () => {
        const chat = fakeChat({ sendImage: async () => { throw new Error('too big') } })
        await deliver(chat, '[[send:/tmp/a.png]]', makeDeps())
        expect(chat.texts.at(-1)).toContain('Gagal mengirim gambar a.png')
    })

    it('schedules a reminder marker and confirms it', async () => {
        const deps = makeDeps()
        const chat = fakeChat()

        await deliver(chat, 'okee [[remind:daily 07:00|bangunn]]', deps)

        const saved = deps.reminders.list('628111')
        expect(saved).toHaveLength(1)
        expect(saved[0]!.jid).toBe(chat.jid)
        expect(chat.texts[0]).toBe('okee')
        expect(chat.texts[1]).toContain('Diingetin')
    })

    it('ignores an unparseable reminder spec but still sends the chat text', async () => {
        const logs: string[] = []
        const deps = makeDeps({ log: (_a, m) => logs.push(m) })
        const chat = fakeChat()

        await deliver(chat, 'okee [[remind:besok pagi|bangunn]]', deps)

        expect(deps.reminders.list('628111')).toHaveLength(0)
        expect(chat.texts).toEqual(['okee'])
        expect(logs.join()).toContain('tidak dikenal')
    })

    it('never leaves the user staring at silence', async () => {
        const chat = fakeChat()
        await deliver(chat, '', makeDeps())
        expect(chat.texts).toEqual(['(kosong)'])
    })

    it('says nothing extra when only a reminder was scheduled', async () => {
        const chat = fakeChat()
        await deliver(chat, '[[remind:in 5m|x]]', makeDeps())
        expect(chat.texts).toHaveLength(1)
        expect(chat.texts[0]).toContain('Diingetin')
    })
})
