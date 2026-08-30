/**
 * Per-key serialization: one job at a time per chat, so replies can never
 * arrive out of order. A failing job must not break the chain for the next.
 */

export interface Queue {
    enqueue<T>(key: string, job: () => Promise<T>): Promise<T | undefined>
    /** Live chains, for tests and diagnostics. */
    size(): number
}

export function createQueue(onError: (key: string, err: Error) => void = () => {}): Queue {
    const chains = new Map<string, Promise<unknown>>()

    return {
        enqueue(key, job) {
            const tail = chains.get(key) ?? Promise.resolve()
            const next = tail.then(job).catch((e: unknown) => {
                onError(key, e instanceof Error ? e : new Error(String(e)))
                return undefined
            })
            chains.set(key, next)
            // Drop the chain once it drains, so idle chats don't leak entries.
            void next.then(() => { if (chains.get(key) === next) chains.delete(key) })
            return next as Promise<never>
        },
        size: () => chains.size,
    }
}
