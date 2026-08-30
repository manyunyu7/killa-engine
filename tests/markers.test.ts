import { describe, expect, it } from 'vitest'
import { chunk, parseReply } from '../src/core/markers.ts'

describe('parseReply', () => {
    it('leaves an ordinary reply untouched', () => {
        expect(parseReply('halo sayanggg')).toEqual({ text: 'halo sayanggg', images: [], reminders: [] })
    })

    it('extracts image markers and strips them from the text', () => {
        const r = parseReply('nih fotonya [[send:/tmp/a.png]] lucu kan')
        expect(r.images).toEqual(['/tmp/a.png'])
        expect(r.text).toBe('nih fotonya  lucu kan')
    })

    it('extracts reminder markers with their spec and body', () => {
        const r = parseReply('okee aku ingetin yaa [[remind:daily 07:00|bangunn]]')
        expect(r.reminders).toEqual([{ spec: 'daily 07:00', text: 'bangunn' }])
        expect(r.text).toBe('okee aku ingetin yaa')
    })

    it('handles several markers of both kinds in one reply', () => {
        const r = parseReply('[[send:/a.png]] x [[remind:in 5m|a]] y [[send:/b.png]] [[remind:in 6m|b]]')
        expect(r.images).toEqual(['/a.png', '/b.png'])
        expect(r.reminders.map(x => x.text)).toEqual(['a', 'b'])
        expect(r.text).toBe('x  y')
    })

    it('collapses the blank lines a stripped marker leaves behind', () => {
        expect(parseReply('atas\n\n\n[[send:/a.png]]\n\n\nbawah').text).toBe('atas\n\nbawah')
    })

    it('keeps an empty reminder body rather than dropping the reminder', () => {
        expect(parseReply('[[remind:in 5m|]]').reminders).toEqual([{ spec: 'in 5m', text: '' }])
    })

    it('ignores malformed markers instead of mangling the reply', () => {
        for (const bad of ['[[send:]]x', '[[remind:no-pipe]]', '[[ send:/a.png ]]', '[[unknown:x]]']) {
            const r = parseReply(bad)
            expect(r.images.filter(Boolean)).toEqual([])
            expect(r.reminders).toEqual([])
            expect(r.text.length).toBeGreaterThan(0)
        }
    })

    it('survives empty and non-string input', () => {
        expect(parseReply('')).toEqual({ text: '', images: [], reminders: [] })
        expect(parseReply(undefined as unknown as string).text).toBe('')
    })
})

describe('chunk', () => {
    it('returns nothing for empty text', () => {
        expect(chunk('')).toEqual([])
    })

    it('keeps a short message in one piece', () => {
        expect(chunk('halo')).toEqual(['halo'])
    })

    it('splits at the limit and loses nothing', () => {
        const text = 'a'.repeat(8000)
        const parts = chunk(text)
        expect(parts).toHaveLength(3)
        expect(parts.join('')).toBe(text)
        expect(parts.every(p => p.length <= 3500)).toBe(true)
    })

    it('splits across newlines too', () => {
        const parts = chunk('ab\ncd', 2)
        expect(parts.join('')).toBe('ab\ncd')
    })
})
