/**
 * Schedule parsing — pure, timezone-aware through the process TZ.
 *
 * Every time here is *local* time, which is the user's phone time as long as
 * TIMEZONE is set (see config.ts). "daily 07:00" means 7am where the owner
 * is, never 7am UTC.
 */

import type { Rule } from '../types.ts'

export const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/**
 * Unit table rather than first-letter matching: "hari" and "jam" both start
 * with a letter that means something else, and guessing there once turned
 * "in 1 hari" into an hour.
 */
const UNIT_MS: Record<string, number> = {
    m: 60e3, min: 60e3, menit: 60e3,
    h: 3600e3, jam: 3600e3,
    d: 86400e3, hari: 86400e3,
}

/** Repeats faster than this are always a mistake, never a request. */
export const MIN_INTERVAL_MS = 60_000

/**
 * Parse a user-facing spec into a rule, or null if unrecognised. Callers must
 * treat null as "ask the user", never as "guess a time".
 */
export function parseSpec(raw: string, now: number = Date.now()): Rule | null {
    const spec = String(raw).trim().toLowerCase()
    let m: RegExpMatchArray | null

    if ((m = spec.match(/^in\s+(\d+)\s*(menit|min|jam|hari|m|h|d)$/))) {
        const ms = UNIT_MS[m[2]!]!
        return { kind: 'once', at: now + Number(m[1]) * ms }
    }
    if ((m = spec.match(/^every\s+(\d+)\s*(menit|min|jam|m|h)$/))) {
        const ms = Number(m[1]) * UNIT_MS[m[2]!]!
        return ms < MIN_INTERVAL_MS ? null : { kind: 'every', ms }
    }
    if ((m = spec.match(/^daily\s+(\d{1,2}):(\d{2})$/))) {
        return validClock(Number(m[1]), Number(m[2])) ? { kind: 'daily', hh: Number(m[1]), mm: Number(m[2]) } : null
    }
    if ((m = spec.match(/^weekly\s+([a-z]{3})\s+(\d{1,2}):(\d{2})$/))) {
        const dow = DOWS.indexOf(m[1] as (typeof DOWS)[number])
        if (dow === -1 || !validClock(Number(m[2]), Number(m[3]))) return null
        return { kind: 'weekly', dow, hh: Number(m[2]), mm: Number(m[3]) }
    }
    if ((m = spec.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})$/))) {
        if (!validClock(Number(m[4]), Number(m[5]))) return null
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
        return isNaN(d.getTime()) ? null : { kind: 'once', at: d.getTime() }
    }
    if ((m = spec.match(/^(\d{1,2}):(\d{2})$/))) {
        if (!validClock(Number(m[1]), Number(m[2]))) return null
        return { kind: 'once', at: nextClock(Number(m[1]), Number(m[2]), now) }
    }
    return null
}

const validClock = (hh: number, mm: number) => hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59

/** Next hh:mm strictly after `from`; with `dow`, the next such weekday. */
export function nextClock(hh: number, mm: number, from: number, dow: number | null = null): number {
    const d = new Date(from)
    d.setHours(hh, mm, 0, 0)
    if (dow !== null) d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7))
    if (d.getTime() <= from) d.setDate(d.getDate() + (dow === null ? 1 : 7))
    return d.getTime()
}

export function nextRun(rule: Rule, from: number): number {
    switch (rule.kind) {
        case 'once': return rule.at
        case 'every': return from + rule.ms
        case 'daily': return nextClock(rule.hh, rule.mm, from)
        case 'weekly': return nextClock(rule.hh, rule.mm, from, rule.dow)
    }
}

export const fmt = (ts: number): string =>
    new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })

export function describe(r: { id: number; rule: Rule; spec: string; nextAt: number; text: string }): string {
    const when = r.rule.kind === 'once' ? fmt(r.nextAt) : `${r.spec} (berikutnya ${fmt(r.nextAt)})`
    return `#${r.id} ${when} — ${r.text}`
}
