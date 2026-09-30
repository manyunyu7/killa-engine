/**
 * Usage accounting: per-turn records -> per-day and per-model totals, and the
 * short /usage summary. Pure: entries and the clock come in, numbers go out.
 * Days are local days (TIMEZONE), the same calendar the reminders use.
 */

import type { TurnUsage, UsageEntry } from '../types.ts'
import type { Deps } from './ports.ts'

export interface UsageTotals {
    turns: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number
}

export interface UsageSummary {
    /** Local midnight the window starts at, epoch ms. */
    since: number
    /** One row per local day in the window, oldest first, zero rows included. */
    days: (UsageTotals & { date: string })[]
    byModel: Record<string, UsageTotals>
    total: UsageTotals
}

const zero = (): UsageTotals =>
    ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 })

function add(t: UsageTotals, e: UsageEntry): void {
    t.turns++
    t.inputTokens += e.inputTokens
    t.outputTokens += e.outputTokens
    t.cacheReadTokens += e.cacheReadTokens
    t.cacheCreationTokens += e.cacheCreationTokens
    t.costUsd += e.costUsd
}

/** Float sums drift (0.1 + 0.2); a cost is shown to the micro-dollar at most. */
const tidy = <T extends UsageTotals>(t: T): T => ({ ...t, costUsd: Math.round(t.costUsd * 1e6) / 1e6 })

/** YYYY-MM-DD in local time. */
export function localDate(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local midnight `days - 1` days before `now`: the start of a `days`-day window ending today. */
export function windowStart(now: number, days: number): number {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - (days - 1))
    return d.getTime()
}

export function summarizeUsage(entries: UsageEntry[], days: number, now: number): UsageSummary {
    const since = windowStart(now, days)
    const rows = new Map<string, UsageTotals>()
    // setDate, not +24h: a DST day is 23 or 25 hours long.
    for (let d = new Date(since); d.getTime() <= now; d.setDate(d.getDate() + 1)) rows.set(localDate(d.getTime()), zero())
    const byModel: Record<string, UsageTotals> = {}
    const total = zero()
    for (const e of entries) {
        if (e.at < since || e.at > now) continue
        const row = rows.get(localDate(e.at))
        if (row) add(row, e)
        add(byModel[e.model] ??= zero(), e)
        add(total, e)
    }
    return {
        since,
        days: [...rows].map(([date, t]) => ({ date, ...tidy(t) })),
        byModel: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, tidy(t)])),
        total: tidy(total),
    }
}

/** 950 -> "950", 12_300 -> "12.3k", 1_200_000 -> "1.2M". */
export function compact(n: number): string {
    if (n < 1000) return String(n)
    if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

const line = (label: string, t: UsageTotals): string =>
    `${label}: ${t.turns} giliran · ${compact(t.inputTokens + t.outputTokens)} token`
    + (t.cacheReadTokens + t.cacheCreationTokens ? ` (+${compact(t.cacheReadTokens + t.cacheCreationTokens)} cache)` : '')
    + ` · ~$${t.costUsd.toFixed(2)}`

/** The /usage reply: today and the last 7 days, across every chat. */
export function formatUsage(entries: UsageEntry[], now: number): string {
    const today = summarizeUsage(entries, 1, now).total
    const week = summarizeUsage(entries, 7, now).total
    return `📊 Pemakaian agent (semua chat)\n${line('Hari ini', today)}\n${line('7 hari', week)}`
}

/** One usage record per agent run. Accounting must never cost the user a reply. */
export function recordUsage(deps: Deps, chatId: string, usage: TurnUsage, requested?: string | null): void {
    try {
        const { model, ...rest } = usage
        deps.usage.record({ at: deps.now(), chatId, model: model ?? requested ?? 'default', ...rest })
    } catch (e) {
        deps.log('usage', `gagal catat pemakaian: ${(e as Error).message}`)
    }
}
