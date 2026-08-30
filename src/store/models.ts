/**
 * Per-chat model choice. Separate from sessions on purpose: picking a model
 * should survive /new and idle expiry.
 */

import type { JsonFile } from './json-file.ts'

export interface ModelStore {
    get(number: string): string | undefined
    set(number: string, model: string | null): void
}

export function createModelStore(file: JsonFile<Record<string, string>>): ModelStore {
    const models = file.read()
    return {
        get: number => models[number],
        set(number, model) {
            if (model) models[number] = model
            else delete models[number]
            file.write(models)
        },
    }
}
