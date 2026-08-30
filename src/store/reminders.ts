/**
 * Reminder store — the only outbound the engine ever initiates.
 *
 * Fenced in deliberately (see docs/configuration.md): owner numbers only,
 * into a chat that already exists, capped per day. Delivery is injected as
 * `send`, so this file never touches WhatsApp and stays fully testable.
 */

import type { NewReminder, Reminder } from '../types.ts'
import type { JsonFile } from './json-file.ts'
import { nextRun, parseSpec } from '../core/schedule.ts'

export interface ReminderFile { seq: number; items: Reminder[] }

/**
 * A reminder missed while the process was down still fires, but only if it is
 * less than this stale — waking someone at 3am for a 9am reminder is worse
 * than dropping it.
 */
export const GRACE_MS = 6 * 60 * 60 * 1000

export type SendReminder = (r: Reminder, text: string) => Promise<void>

export interface ReminderStore {
    add(input: NewReminder): Reminder | null
    cancel(number: string, id: number): Reminder | null
    list(number: string): Reminder[]
    tick(send: SendReminder): Promise<void>
    all(): Reminder[]
}

export interface ReminderStoreOptions {
    file: JsonFile<ReminderFile>
    maxPerDay?: number
    log?: (msg: string) => void
    now?: () => number
}

export function createReminderStore({ file, maxPerDay = 20, log = console.log,
                                      now = Date.now }: ReminderStoreOptions): ReminderStore {
    const data = file.read()
    data.seq ??= 0
    // Rules are derived, not trusted: re-parse from the spec on load so a
    // schema change or a hand-edited file can't resurrect a bad rule.
    data.items = (data.items ?? [])
        .map(r => ({ ...r, rule: parseSpec(r.spec, now())! }))
        .filter(r => r.rule)

    const save = () => file.write(data)

    return {
        add({ spec, text, number, account, jid }) {
            const rule = parseSpec(spec, now())
            if (!rule) return null
            const r: Reminder = {
                id: ++data.seq, spec: String(spec).trim(), rule, text: text.trim(),
                number, account, jid, nextAt: nextRun(rule, now()), sentToday: 0, dayStamp: '',
            }
            data.items.push(r)
            save()
            return r
        },

        cancel(number, id) {
            const i = data.items.findIndex(r => r.number === number && r.id === id)
            if (i === -1) return null
            const [gone] = data.items.splice(i, 1)
            save()
            return gone ?? null
        },

        list: number => data.items.filter(r => r.number === number).sort((a, b) => a.nextAt - b.nextAt),

        async tick(send) {
            const ts = now()
            const due = data.items.filter(r => r.nextAt <= ts)
            if (!due.length) return
            const today = new Date(ts).toDateString()

            for (const r of due) {
                if (r.dayStamp !== today) { r.dayStamp = today; r.sentToday = 0 }

                if (ts - r.nextAt > GRACE_MS) {
                    log(`reminder #${r.id} dilewati (telat ${Math.round((ts - r.nextAt) / 6e4)} menit)`)
                } else if (r.sentToday >= maxPerDay) {
                    log(`reminder #${r.id} ditahan — sudah ${maxPerDay} kali hari ini`)
                } else {
                    try {
                        await send(r, `⏰ ${r.text}`)
                        r.sentToday++
                        log(`reminder #${r.id} terkirim ke ${r.number}`)
                    } catch (e) {
                        // Keep the schedule moving; a socket that is down now
                        // must not wedge every future fire.
                        log(`reminder #${r.id} gagal: ${(e as Error).message}`)
                    }
                }

                if (r.rule.kind === 'once') data.items = data.items.filter(x => x !== r)
                else r.nextAt = nextRun(r.rule, ts)
            }
            save()
        },

        all: () => data.items,
    }
}
