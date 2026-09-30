import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createClaude, parseUsage } from '../src/agent/claude.ts'
import { dispatch } from '../src/core/dispatch.ts'
import { flushSession } from '../src/core/flush.ts'
import { compact, formatUsage, localDate, recordUsage, summarizeUsage, windowStart } from '../src/core/usage.ts'
import { createUsageStore, KEEP_DAYS, type UsageFile } from '../src/store/usage.ts'
import { fakeChat, flush, makeDeps, memFile } from './helpers.ts'
import type { TurnUsage, UsageEntry } from '../src/types.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const DAY = 24 * 60 * 60 * 1000
// Wed 1 Oct 2026, 10:00 WIB
const NOW = new Date('2026-10-01T10:00:00+07:00').getTime()
const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
    at: NOW, chatId: 'c', model: 'claude-sonnet', inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 100, cacheCreationTokens: 20, costUsd: 0.1, durationMs: 1000, ...over,
})
const USAGE: TurnUsage = { model: 'claude-opus', inputTokens: 3, outputTokens: 7, cacheReadTokens: 50,
                           cacheCreationTokens: 9, costUsd: 0.02, durationMs: 2100 }

describe('usage store', () => {
    it('appends, and prunes entries older than the retention window on write', () => {
        const file = memFile<UsageFile>({ entries: [entry({ at: NOW - (KEEP_DAYS + 1) * DAY }), entry({ at: NOW - DAY })] })
        const store = createUsageStore(file, () => NOW)
        store.record(entry({ at: NOW }))
        expect(file.read().entries.map(e => e.at)).toEqual([NOW - DAY, NOW])
        expect(file.writes).toBe(1)
    })

    it('since() filters and sorts oldest first', () => {
        const store = createUsageStore(memFile<UsageFile>({ entries: [entry({ at: 3 }), entry({ at: 1 }), entry({ at: 2 })] }))
        expect(store.since(2).map(e => e.at)).toEqual([2, 3])
    })

    it('survives a file with no entries array', () => {
        const store = createUsageStore(memFile({} as UsageFile), () => NOW)
        expect(store.since(0)).toEqual([])
        store.record(entry())
        expect(store.since(0)).toHaveLength(1)
    })
})

describe('summarizeUsage', () => {
    it('windows on local midnight and fills empty days', () => {
        expect(localDate(windowStart(NOW, 1))).toBe('2026-10-01')
        expect(new Date(windowStart(NOW, 1)).getHours()).toBe(0)
        const s = summarizeUsage([], 3, NOW)
        expect(s.days.map(d => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
        expect(s.total).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
                                  cacheCreationTokens: 0, costUsd: 0 })
    })

    it('aggregates per day, per model and in total, ignoring entries outside the window', () => {
        const s = summarizeUsage([
            entry({ at: NOW }), entry({ at: NOW - 60_000, model: 'claude-haiku', costUsd: 0.2 }),
            entry({ at: NOW - DAY }), entry({ at: NOW - 5 * DAY }), entry({ at: NOW + DAY }),
        ], 2, NOW)
        expect(s.days).toEqual([
            expect.objectContaining({ date: '2026-09-30', turns: 1, inputTokens: 10, costUsd: 0.1 }),
            expect.objectContaining({ date: '2026-10-01', turns: 2, outputTokens: 10, costUsd: 0.3 }),
        ])
        expect(s.byModel).toEqual({
            'claude-sonnet': expect.objectContaining({ turns: 2, costUsd: 0.2 }),
            'claude-haiku': expect.objectContaining({ turns: 1, costUsd: 0.2 }),
        })
        expect(s.total).toMatchObject({ turns: 3, inputTokens: 30, cacheReadTokens: 300, costUsd: 0.4 })
    })

    it.each([[950, '950'], [1000, '1k'], [12_300, '12.3k'], [1_200_000, '1.2M'], [3_000_000, '3M']])(
        'compact(%i) = %s', (n, s) => { expect(compact(n)).toBe(s) })

    it('formats today and the last 7 days', () => {
        const text = formatUsage([entry(), entry({ at: NOW - 3 * DAY, cacheReadTokens: 0, cacheCreationTokens: 0 })], NOW)
        expect(text).toBe('📊 Pemakaian agent (semua chat)\n'
            + 'Hari ini: 1 giliran · 15 token (+120 cache) · ~$0.10\n'
            + '7 hari: 2 giliran · 30 token (+120 cache) · ~$0.20')
        expect(formatUsage([], NOW)).toContain('Hari ini: 0 giliran · 0 token · ~$0.00')
    })
})

describe('recording', () => {
    it('records every agent turn under the chat key, with the reported model', async () => {
        const deps = makeDeps({ now: () => NOW, runAgent: vi.fn(async () => ({ reply: 'ok', sessionId: 's', usage: USAGE })) })
        await dispatch(fakeChat(), { text: 'halo', hasFile: false, file: null }, deps)
        await flush()
        expect(deps.usage.since(0)).toEqual([{ at: NOW, chatId: '628111@s.whatsapp.net#628111', model: 'claude-opus',
            inputTokens: 3, outputTokens: 7, cacheReadTokens: 50, cacheCreationTokens: 9, costUsd: 0.02, durationMs: 2100 }])
    })

    it('falls back to the chosen model, then "default", when the CLI named none', () => {
        const deps = makeDeps()
        recordUsage(deps, 'k', { ...USAGE, model: null }, 'opus')
        recordUsage(deps, 'k', { ...USAGE, model: null })
        expect(deps.usage.since(0).map(e => e.model)).toEqual(['opus', 'default'])
    })

    it('records nothing when the run reported no usage', async () => {
        const deps = makeDeps()
        await dispatch(fakeChat(), { text: 'halo', hasFile: false, file: null }, deps)
        await flush()
        expect(deps.usage.since(0)).toEqual([])
    })

    it('a failing usage store is logged, never costs the reply', async () => {
        const log = vi.fn()
        const deps = makeDeps({ log, runAgent: vi.fn(async () => ({ reply: 'ok', sessionId: 's', usage: USAGE })) })
        deps.usage.record = () => { throw new Error('disk penuh') }
        const chat = fakeChat()
        await dispatch(chat, { text: 'halo', hasFile: false, file: null }, deps)
        await flush()
        expect(chat.texts).toEqual(['ok'])
        expect(log).toHaveBeenCalledWith('usage', expect.stringContaining('disk penuh'))
    })

    it('counts a memory flush run too, on the flush model', async () => {
        const deps = makeDeps({ runAgent: vi.fn(async () => ({ reply: 'disimpan', sessionId: 's', usage: { ...USAGE, model: null } })) })
        await flushSession({ sessionId: 'old', lastAt: 0, startedAt: 0, turns: 5,
                             chat: { account: 'main', jid: '628111@s.whatsapp.net', number: '628111' } }, deps)
        expect(deps.usage.since(0)).toEqual([expect.objectContaining({ model: 'haiku', chatId: '628111@s.whatsapp.net#628111' })])
    })

    it('/usage replies with the summary', async () => {
        const deps = makeDeps({ now: () => NOW })
        deps.usage.record(entry())
        const chat = fakeChat()
        expect(await dispatch(chat, { text: '/usage', hasFile: false, file: null }, deps)).toBe(true)
        expect(chat.texts[0]).toContain('Hari ini: 1 giliran')
        expect(deps.runAgent).not.toHaveBeenCalled()
    })
})

describe('parseUsage', () => {
    it('sums modelUsage across models and names the costliest', () => {
        expect(parseUsage({
            total_cost_usd: 0.05, duration_ms: 3000,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {
                'claude-haiku': { inputTokens: 100, outputTokens: 10, costUSD: 0.001 },
                'claude-sonnet': { inputTokens: 5, outputTokens: 50, cacheReadInputTokens: 1000,
                                   cacheCreationInputTokens: 200, costUSD: 0.049 },
            },
        }, 'sonnet')).toEqual({ model: 'claude-sonnet', inputTokens: 105, outputTokens: 60, cacheReadTokens: 1000,
                                cacheCreationTokens: 200, costUsd: 0.05, durationMs: 3000 })
    })

    it('falls back to the top-level usage block and the requested model', () => {
        expect(parseUsage({ total_cost_usd: 0.01, usage: { input_tokens: 4, output_tokens: 2,
            cache_read_input_tokens: 8, cache_creation_input_tokens: 1 } }, 'opus'))
            .toEqual({ model: 'opus', inputTokens: 4, outputTokens: 2, cacheReadTokens: 8, cacheCreationTokens: 1,
                       costUsd: 0.01, durationMs: 0 })
        expect(parseUsage({ usage: {} })?.model).toBeNull()
    })

    it('sums modelUsage cost when total_cost_usd is missing, and ignores junk numbers', () => {
        expect(parseUsage({ modelUsage: { a: { costUSD: 0.5, inputTokens: -3 }, b: { costUSD: Number.NaN } } }))
            .toMatchObject({ model: 'a', costUsd: 0.5, inputTokens: 0 })
    })

    it('is undefined when the CLI reported nothing', () => {
        expect(parseUsage({ result: 'x' })).toBeUndefined()
    })

    it('runAgent returns it with the reply', async () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
        const claude = createClaude({ bin: 'claude', spawn: vi.fn(() => child) as never })
        const p = claude.runAgent({ text: 'x', sessionId: null, workspace: '/ws', timeoutMs: 1000, model: 'opus' })
        child.stdout.emit('data', JSON.stringify({ result: 'hai', session_id: 's', total_cost_usd: 0.3, duration_ms: 9,
                                                   usage: { input_tokens: 1, output_tokens: 2 } }))
        child.emit('close', 0)
        expect((await p).usage).toEqual({ model: 'opus', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0,
                                          cacheCreationTokens: 0, costUsd: 0.3, durationMs: 9 })
    })
})
