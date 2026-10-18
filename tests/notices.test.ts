import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { noticeBlock } from '../src/core/notices.ts'
import { briefingOf, buildPrompt } from '../src/core/dispatch.ts'
import { jsonFile } from '../src/store/json-file.ts'
import { createNoticeStore, MAX_NOTICE_CHARS, MAX_NOTICES, NOTICE_TTL_MS, type NoticeFile } from '../src/store/notices.ts'
import { memFile } from './helpers.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const empty = (): NoticeFile => ({ seq: 0, chats: {} })

describe('notice store', () => {
    it('keeps notes per chat, oldest first, with ref only when given', () => {
        let t = 1000
        const s = createNoticeStore(memFile(empty()), () => t)
        s.add('a', 'satu', 'email:1'); t++
        s.add('a', 'dua')
        s.add('b', 'lain')
        expect(s.pending('a')).toEqual([{ id: 1, at: 1000, text: 'satu', ref: 'email:1' }, { id: 2, at: 1001, text: 'dua' }])
        expect(s.pending('b')).toHaveLength(1)
        expect(s.pending('c')).toEqual([])
    })

    it(`caps at ${MAX_NOTICES} per chat, dropping the oldest`, () => {
        const s = createNoticeStore(memFile(empty()))
        for (let i = 1; i <= MAX_NOTICES + 3; i++) s.add('a', `n${i}`)
        const left = s.pending('a').map(n => n.text)
        expect(left).toHaveLength(MAX_NOTICES)
        expect(left[0]).toBe('n4')
        expect(left.at(-1)).toBe(`n${MAX_NOTICES + 3}`)
    })

    it('expires notes after 7 days', () => {
        let t = 0
        const s = createNoticeStore(memFile(empty()), () => t)
        s.add('a', 'lama')
        t = NOTICE_TTL_MS - 1
        s.add('a', 'baru')
        expect(s.pending('a').map(n => n.text)).toEqual(['lama', 'baru'])
        t = NOTICE_TTL_MS + 1
        expect(s.pending('a').map(n => n.text)).toEqual(['baru'])
    })

    it(`truncates text to ${MAX_NOTICE_CHARS} chars`, () => {
        const s = createNoticeStore(memFile(empty()))
        const n = s.add('a', 'x'.repeat(MAX_NOTICE_CHARS + 50))
        expect(n.text).toHaveLength(MAX_NOTICE_CHARS)
        expect(n.text.endsWith('…')).toBe(true)
    })

    it('drop removes only the given ids; clear removes the chat', () => {
        const s = createNoticeStore(memFile(empty()))
        const a = s.add('k', 'a')
        s.add('k', 'b')
        s.drop('k', [a.id])
        expect(s.pending('k').map(n => n.text)).toEqual(['b'])
        s.clear('k')
        expect(s.pending('k')).toEqual([])
        s.drop('nope', [1])
        s.clear('nope')
    })

    it('survives a restart (real file on disk)', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'killa-notices-')), 'pending-notices.json')
        const mk = () => createNoticeStore(jsonFile<NoticeFile>(file, empty, () => {}))
        mk().add('628111@s.whatsapp.net#628111', 'Paket sampai', 'email:9')
        const again = mk()
        expect(again.pending('628111@s.whatsapp.net#628111')).toEqual([expect.objectContaining({ text: 'Paket sampai', ref: 'email:9' })])
        // ids keep counting after a restart, so a drop never hits a newer note.
        expect(again.add('628111@s.whatsapp.net#628111', 'lagi').id).toBe(2)
    })

    it('starts empty from a file missing its fields', () => {
        const s = createNoticeStore(memFile({} as NoticeFile))
        expect(s.add('a', 'x').id).toBe(1)
    })
})

describe('notice block in the prompt', () => {
    const at = Date.UTC(2026, 9, 18, 14, 5)

    it('is empty with nothing pending', () => {
        expect(noticeBlock([])).toBe('')
        expect(buildPrompt({ text: 'hai', hasFile: false, file: null }, { now: at, briefing: [], notices: [] }))
            .toBe('[Min 18 Okt 2026, 21:05 WIB] hai')
    })

    it('lists each note with its time and ref, marked as not from the user, before the message', () => {
        const p = buildPrompt({ text: 'itu apa?', hasFile: false, file: null }, {
            now: at, briefing: [{ at, who: 'user', text: 'tadi' }],
            notices: [{ id: 1, at, text: 'Denda ETLE', ref: 'email:abc' }, { id: 2, at, text: 'Paket' }],
        })
        expect(p).toContain('[Konteks — notifikasi yang Killa kirim sejak obrolan terakhir (bukan pesan dari pengguna):\n'
            + '- Min 18 Okt, 21:05 · Denda ETLE (ref email:abc)\n- Min 18 Okt, 21:05 · Paket]\n\n[Min 18 Okt 2026, 21:05 WIB] itu apa?')
        expect(p.indexOf('sesi baru')).toBeLessThan(p.indexOf('Konteks'))
    })

    it('labels a notice line in a fresh-session briefing', () => {
        expect(briefingOf([{ at, who: 'agent', text: 'Paket', kind: 'notice' }])).toContain('Kamu (notifikasi): Paket')
    })
})
