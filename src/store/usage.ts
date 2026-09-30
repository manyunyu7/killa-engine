/**
 * Per-turn token and cost log — what each agent run cost, as the CLI
 * reported it. A bounded ledger, not an archive: entries older than
 * KEEP_DAYS are pruned on every write, so the file stays small forever.
 */

import type { UsageEntry } from '../types.ts'
import type { JsonFile } from './json-file.ts'

export interface UsageFile { entries: UsageEntry[] }

export const KEEP_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export interface UsageStore {
    record(entry: UsageEntry): void
    /** Entries at or after `since` (epoch ms), oldest first. */
    since(since: number): UsageEntry[]
}

export function createUsageStore(file: JsonFile<UsageFile>, now: () => number = Date.now,
                                 keepDays: number = KEEP_DAYS): UsageStore {
    const data = file.read()
    data.entries = Array.isArray(data.entries) ? data.entries : []
    return {
        record(entry) {
            const cutoff = now() - keepDays * DAY_MS
            data.entries = data.entries.filter(e => e.at >= cutoff)
            data.entries.push(entry)
            file.write(data)
        },
        since: since => data.entries.filter(e => e.at >= since).sort((a, b) => a.at - b.at),
    }
}
