/**
 * The persistence primitive: a small JSON file that must never take the
 * process down. A corrupt or missing file means "start empty", and a failed
 * write is logged, not thrown — losing a reminder is bad, crashing the
 * gateway mid-conversation is worse.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface JsonFile<T> {
    read(): T
    write(value: T): void
    path: string
}

export function jsonFile<T>(file: string, fallback: () => T,
                            onError: (msg: string) => void = console.error): JsonFile<T> {
    return {
        path: file,
        read() {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
            catch { return fallback() }
        },
        write(value) {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true })
                // Write-then-rename: a crash mid-write leaves the old file
                // intact instead of a truncated one.
                const tmp = `${file}.tmp`
                fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
                fs.renameSync(tmp, file)
            } catch (e) {
                onError(`gagal simpan ${path.basename(file)}: ${(e as Error).message}`)
            }
        },
    }
}
