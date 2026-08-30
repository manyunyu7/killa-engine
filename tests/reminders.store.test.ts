import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createReminderStore, GRACE_MS, type ReminderFile } from '../src/store/reminders.ts'
import { memFile } from './helpers.ts'

beforeAll(() => { process.env.TZ = 'Asia/Jakarta' })

const NOW = new Date('2026-08-30T10:00:00+07:00').getTime()

function setup(over: { maxPerDay?: number; items?: ReminderFile } = {}) {
    let clock = NOW
    const file = memFile<ReminderFile>(over.items ?? { seq: 0, items: [] })
    const logs: string[] = []
    const store = createReminderStore({
        file, maxPerDay: over.maxPerDay ?? 20,
        log: m => logs.push(m),
        now: () => clock,
    })
    const sent: { id: number; text: string }[] = []
    const send = vi.fn(async (r: { id: number }, text: string) => { sent.push({ id: r.id, text }) })
    return { store, file, logs, sent, send, at: (t: number) => { clock = t }, now: () => clock }
}

const input = { text: 'minum obat', number: '628111', account: 'main', jid: '628111@s.whatsapp.net' }

describe('add', () => {
    it('stores a parsed reminder and hands back the scheduled time', () => {
        const { store } = setup()
        const r = store.add({ ...input, spec: 'in 45m' })!
        expect(r.id).toBe(1)
        expect(r.nextAt).toBe(NOW + 45 * 60_000)
        expect(r.text).toBe('minum obat')
    })

    it('refuses an unparseable spec rather than guessing a time', () => {
        const { store, file } = setup()
        expect(store.add({ ...input, spec: 'besok pagi' })).toBeNull()
        expect(file.read().items).toHaveLength(0)
    })

    it('gives every reminder its own id, even after cancels', () => {
        const { store } = setup()
        const a = store.add({ ...input, spec: 'in 1 jam' })!
        store.cancel(input.number, a.id)
        const b = store.add({ ...input, spec: 'in 2 jam' })!
        expect(b.id).toBe(2)
    })

    it('persists on every mutation', () => {
        const { store, file } = setup()
        store.add({ ...input, spec: 'in 1 jam' })
        expect(file.writes).toBe(1)
        expect(file.read().items).toHaveLength(1)
    })
})

describe('list and cancel', () => {
    it('shows only this owner’s reminders, soonest first', () => {
        const { store } = setup()
        store.add({ ...input, spec: 'in 2 jam' })
        store.add({ ...input, spec: 'in 1 jam' })
        store.add({ ...input, spec: 'in 1 jam', number: '628999' })

        const mine = store.list('628111')
        expect(mine).toHaveLength(2)
        expect(mine[0]!.nextAt).toBeLessThan(mine[1]!.nextAt)
    })

    it('will not cancel another number’s reminder', () => {
        const { store } = setup()
        const r = store.add({ ...input, spec: 'in 1 jam' })!
        expect(store.cancel('628999', r.id)).toBeNull()
        expect(store.all()).toHaveLength(1)
        expect(store.cancel('628111', r.id)?.id).toBe(r.id)
        expect(store.all()).toHaveLength(0)
    })

    it('returns null for an unknown id', () => {
        const { store } = setup()
        expect(store.cancel('628111', 999)).toBeNull()
    })
})

describe('tick', () => {
    it('sends nothing before the due time', async () => {
        const { store, send } = setup()
        store.add({ ...input, spec: 'in 45m' })
        await store.tick(send)
        expect(send).not.toHaveBeenCalled()
    })

    it('sends a due one-shot once, then forgets it', async () => {
        const { store, send, sent, at } = setup()
        store.add({ ...input, spec: 'in 45m' })

        at(NOW + 46 * 60_000)
        await store.tick(send)
        expect(sent).toEqual([{ id: 1, text: '⏰ minum obat' }])
        expect(store.all()).toHaveLength(0)

        await store.tick(send)
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('reschedules a recurring reminder instead of dropping it', async () => {
        const { store, send, at } = setup()
        store.add({ ...input, spec: 'every 1h' })

        at(NOW + 61 * 60_000)
        await store.tick(send)
        expect(store.all()).toHaveLength(1)
        expect(store.all()[0]!.nextAt).toBe(NOW + 61 * 60_000 + 3600_000)
    })

    it('skips a fire that went stale while the process was down', async () => {
        const { store, send, logs, at } = setup()
        store.add({ ...input, spec: 'in 45m' })

        at(NOW + GRACE_MS + 60 * 60_000)
        await store.tick(send)
        expect(send).not.toHaveBeenCalled()
        expect(logs.join()).toContain('dilewati')
    })

    it('rolls a long outage forward once rather than firing a backlog', async () => {
        const { store, send, at } = setup()
        store.add({ ...input, spec: 'every 1h' })

        at(NOW + 24 * 3600_000) // a day offline
        await store.tick(send)
        expect(send).not.toHaveBeenCalled() // stale, skipped
        expect(store.all()[0]!.nextAt).toBe(NOW + 24 * 3600_000 + 3600_000)
    })

    it('honours the daily cap, then resets on the next day', async () => {
        const { store, send, logs, at } = setup({ maxPerDay: 2 })
        store.add({ ...input, spec: 'every 1m' })

        for (let i = 1; i <= 4; i++) {
            at(NOW + i * 61_000)
            await store.tick(send)
        }
        expect(send).toHaveBeenCalledTimes(2)
        expect(logs.join()).toContain('ditahan')

        at(NOW + 25 * 3600_000 + 61_000) // next day, but within grace of its new nextAt
        store.all()[0]!.nextAt = NOW + 25 * 3600_000
        await store.tick(send)
        expect(send).toHaveBeenCalledTimes(3)
    })

    it('keeps the schedule moving when a send fails', async () => {
        const { store, logs, at } = setup()
        store.add({ ...input, spec: 'every 1h' })
        at(NOW + 61 * 60_000)

        await store.tick(async () => { throw new Error('socket mati') })

        expect(logs.join()).toContain('gagal')
        expect(store.all()[0]!.nextAt).toBeGreaterThan(NOW + 61 * 60_000)
    })

    it('delivers several due reminders in one pass', async () => {
        const { store, send, at } = setup()
        store.add({ ...input, spec: 'in 10m' })
        store.add({ ...input, spec: 'in 20m', text: 'lainnya' })
        at(NOW + 21 * 60_000)
        await store.tick(send)
        expect(send).toHaveBeenCalledTimes(2)
    })
})

describe('loading from disk', () => {
    it('re-derives rules from the spec instead of trusting the file', () => {
        const stored: ReminderFile = {
            seq: 5,
            items: [{
                id: 5, spec: 'daily 07:00', rule: { kind: 'every', ms: 1 }, text: 'x',
                number: '628111', account: 'main', jid: 'j', nextAt: NOW, sentToday: 0, dayStamp: '',
            }],
        }
        const { store } = setup({ items: stored })
        expect(store.all()[0]!.rule).toEqual({ kind: 'daily', hh: 7, mm: 0 })
    })

    it('drops entries whose spec no longer parses', () => {
        const stored: ReminderFile = {
            seq: 2,
            items: [{
                id: 1, spec: 'every 1s', rule: { kind: 'every', ms: 1000 }, text: 'x',
                number: '628111', account: 'main', jid: 'j', nextAt: NOW, sentToday: 0, dayStamp: '',
            }],
        }
        const { store } = setup({ items: stored })
        expect(store.all()).toHaveLength(0)
    })

    it('starts clean on a missing or empty file', () => {
        const { store } = setup({ items: {} as ReminderFile })
        expect(store.all()).toEqual([])
        expect(store.add({ ...input, spec: 'in 1 jam' })!.id).toBe(1)
    })
})
