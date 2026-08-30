import { describe, expect, it, beforeAll } from 'vitest'
import { DOWS, describe as render, fmt, nextClock, nextRun, parseSpec } from '../src/core/schedule.ts'

// Reminders are meaningless without a pinned zone: "07:00" must mean the
// owner's 07:00, so the whole suite runs in one.
beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const at = (iso: string) => new Date(iso).getTime()

describe('parseSpec', () => {
    it('parses relative offsets in both languages', () => {
        const now = at('2026-08-30T10:00:00+07:00')
        expect(parseSpec('in 45m', now)).toEqual({ kind: 'once', at: now + 45 * 60_000 })
        expect(parseSpec('in 2 jam', now)).toEqual({ kind: 'once', at: now + 2 * 3600_000 })
        expect(parseSpec('in 1 hari', now)).toEqual({ kind: 'once', at: now + 86_400_000 })
    })

    it('parses recurring rules', () => {
        expect(parseSpec('every 3h')).toEqual({ kind: 'every', ms: 3 * 3600_000 })
        expect(parseSpec('daily 07:00')).toEqual({ kind: 'daily', hh: 7, mm: 0 })
        expect(parseSpec('weekly mon 09:30')).toEqual({ kind: 'weekly', dow: 1, hh: 9, mm: 30 })
    })

    it('parses absolute local datetimes', () => {
        expect(parseSpec('2026-09-01T19:00')).toEqual({ kind: 'once', at: at('2026-09-01T19:00:00+07:00') })
        expect(parseSpec('2026-09-01 19:00')).toEqual({ kind: 'once', at: at('2026-09-01T19:00:00+07:00') })
    })

    it('reads a bare clock as today, or tomorrow once it has passed', () => {
        const morning = at('2026-08-30T06:00:00+07:00')
        expect(parseSpec('19:00', morning)).toEqual({ kind: 'once', at: at('2026-08-30T19:00:00+07:00') })
        const evening = at('2026-08-30T20:00:00+07:00')
        expect(parseSpec('19:00', evening)).toEqual({ kind: 'once', at: at('2026-08-31T19:00:00+07:00') })
    })

    it('is case and whitespace tolerant', () => {
        expect(parseSpec('  DAILY 07:00 ')).toEqual({ kind: 'daily', hh: 7, mm: 0 })
    })

    it.each([
        ['every 30s', 'sub-minute repeat'],
        ['every 0m', 'zero interval'],
        ['daily 25:00', 'impossible hour'],
        ['daily 07:99', 'impossible minute'],
        ['weekly xyz 09:00', 'unknown weekday'],
        ['besok pagi', 'natural language'],
        ['', 'empty'],
        ['2026-13-45T99:99', 'nonsense date'],
    ])('rejects %s (%s)', spec => {
        expect(parseSpec(spec)).toBeNull()
    })
})

describe('nextRun', () => {
    const from = at('2026-08-30T10:00:00+07:00') // a Sunday

    it('returns the fixed instant for one-shots', () => {
        expect(nextRun({ kind: 'once', at: 123 }, from)).toBe(123)
    })

    it('counts intervals from now, not from the original schedule', () => {
        expect(nextRun({ kind: 'every', ms: 3600_000 }, from)).toBe(from + 3600_000)
    })

    it('rolls a daily rule to tomorrow once today has passed', () => {
        expect(nextRun({ kind: 'daily', hh: 7, mm: 0 }, from)).toBe(at('2026-08-31T07:00:00+07:00'))
        expect(nextRun({ kind: 'daily', hh: 18, mm: 0 }, from)).toBe(at('2026-08-30T18:00:00+07:00'))
    })

    it('finds the next matching weekday', () => {
        expect(nextRun({ kind: 'weekly', dow: 1, hh: 9, mm: 0 }, from)).toBe(at('2026-08-31T09:00:00+07:00'))
        // Same weekday, hour already gone -> a week later, not today.
        expect(nextRun({ kind: 'weekly', dow: 0, hh: 9, mm: 0 }, from)).toBe(at('2026-09-06T09:00:00+07:00'))
    })

    it('never returns a time in the past', () => {
        for (const dow of DOWS.keys()) {
            expect(nextClock(9, 0, from, dow)).toBeGreaterThan(from)
        }
    })
})

describe('describe', () => {
    const base = { id: 3, nextAt: at('2026-09-01T19:00:00+07:00'), text: 'minum obat' }

    it('shows one-shots as a plain date', () => {
        expect(render({ ...base, rule: { kind: 'once', at: base.nextAt }, spec: '19:00' }))
            .toBe(`#3 ${fmt(base.nextAt)} — minum obat`)
    })

    it('shows the rule and the next fire for recurring ones', () => {
        const line = render({ ...base, rule: { kind: 'daily', hh: 7, mm: 0 }, spec: 'daily 07:00' })
        expect(line).toContain('daily 07:00')
        expect(line).toContain('berikutnya')
    })
})
