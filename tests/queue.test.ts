import { describe, expect, it, vi } from 'vitest'
import { createQueue } from '../src/core/queue.ts'

const defer = () => {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    return { promise, resolve }
}

describe('createQueue', () => {
    it('runs jobs for one key strictly in order', async () => {
        const q = createQueue()
        const order: number[] = []
        const gate = defer()

        const first = q.enqueue('a', async () => { await gate.promise; order.push(1) })
        const second = q.enqueue('a', async () => { order.push(2) })

        gate.resolve()
        await Promise.all([first, second])
        expect(order).toEqual([1, 2])
    })

    it('does not make one chat wait for another', async () => {
        const q = createQueue()
        const order: string[] = []
        const gate = defer()

        const slow = q.enqueue('a', async () => { await gate.promise; order.push('a') })
        await q.enqueue('b', async () => { order.push('b') })

        expect(order).toEqual(['b'])
        gate.resolve()
        await slow
        expect(order).toEqual(['b', 'a'])
    })

    it('keeps the chain alive after a job throws, and reports it', async () => {
        const onError = vi.fn()
        const q = createQueue(onError)

        await q.enqueue('a', async () => { throw new Error('boom') })
        const after = await q.enqueue('a', async () => 'ok')

        expect(after).toBe('ok')
        expect(onError).toHaveBeenCalledWith('a', expect.objectContaining({ message: 'boom' }))
    })

    it('wraps a non-Error rejection', async () => {
        const onError = vi.fn()
        const q = createQueue(onError)
        await q.enqueue('a', async () => { throw 'plain string' })
        expect(onError.mock.calls[0]![1].message).toBe('plain string')
    })

    it('forgets drained chats so idle chats do not leak', async () => {
        const q = createQueue()
        await q.enqueue('a', async () => 'done')
        await new Promise(r => setImmediate(r))
        expect(q.size()).toBe(0)
    })
})
