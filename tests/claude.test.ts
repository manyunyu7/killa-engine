import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { BROKEN_SESSION_REPLY, createClaude, EMPTY_REPLY, SUDO_BRIDGE, TIMEOUT_REPLY } from '../src/agent/claude.ts'
import { discoverAliases, FALLBACK_ALIASES, parseAliases } from '../src/agent/aliases.ts'

/** A child process stand-in: no CLI, no processes, full control of timing. */
function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
}

function harness() {
    const child = fakeChild()
    const spawn = vi.fn((_bin: string, _args: string[], _opts: { cwd: string }) => child)
    const claude = createClaude({ bin: 'claude', spawn: spawn as never })
    return { child, spawn, claude }
}

const run = { text: 'halo', sessionId: null, workspace: '/ws', timeoutMs: 1000 }

describe('runAgent', () => {
    it('hands a runAs run to the sudo bridge, and sets no cwd', async () => {
        // The bridge chdirs itself: this process may not be able to enter the
        // other user's home at all, so a cwd here would fail before exec.
        const { child, spawn, claude } = harness()
        const p = claude.runAgent({ ...run, workspace: '/home/other/ws', runAs: 'killa-rw' })

        child.stdout.emit('data', JSON.stringify({ result: 'hai', session_id: 's' }))
        child.emit('close', 0)
        await p

        const [bin, args, opts] = spawn.mock.calls[0]!
        expect(bin).toBe('sudo')
        expect(args.slice(0, 5)).toEqual(['-n', '-u', 'killa-rw', SUDO_BRIDGE, '/home/other/ws'])
        expect(args).toContain('--dangerously-skip-permissions')
        expect((opts as { cwd?: string }).cwd).toBeUndefined()
    })

    it('spawns claude directly when there is no runAs', async () => {
        const { child, spawn, claude } = harness()
        const p = claude.runAgent({ ...run })
        child.stdout.emit('data', JSON.stringify({ result: 'hai', session_id: 's' }))
        child.emit('close', 0)
        await p
        expect(spawn.mock.calls[0]![0]).toBe('claude')
        expect(spawn.mock.calls[0]![2].cwd).toBe('/ws')
    })

    it('builds the CLI arguments the engine depends on', async () => {
        const { child, spawn, claude } = harness()
        const p = claude.runAgent({ ...run, sessionId: 'sess-1', model: 'opus' })

        child.stdout.emit('data', JSON.stringify({ result: 'hai', session_id: 'sess-2' }))
        child.emit('close', 0)
        await p

        const args = spawn.mock.calls[0]![1]
        expect(args).toEqual(['-p', 'halo', '--output-format', 'json', '--model', 'opus',
            '--dangerously-skip-permissions', '--resume', 'sess-1'])
        expect(spawn.mock.calls[0]![2].cwd).toBe('/ws')
    })

    it('omits --model and --resume when there is nothing to pass', async () => {
        const { child, spawn, claude } = harness()
        const p = claude.runAgent(run)
        child.stdout.emit('data', '{"result":"hai"}')
        child.emit('close', 0)
        await p

        const args = spawn.mock.calls[0]![1]
        expect(args).not.toContain('--model')
        expect(args).not.toContain('--resume')
    })

    it('returns the reply and the new session id', async () => {
        const { child, claude } = harness()
        const p = claude.runAgent(run)
        child.stdout.emit('data', '{"result":"  hai  ","session_id":"sess-9"}')
        child.emit('close', 0)
        expect(await p).toEqual({ reply: 'hai', sessionId: 'sess-9' })
    })

    it('reassembles output that arrives in several chunks', async () => {
        const { child, claude } = harness()
        const p = claude.runAgent(run)
        child.stdout.emit('data', '{"result":"ha')
        child.stdout.emit('data', 'i","session_id":"s"}')
        child.emit('close', 0)
        expect((await p).reply).toBe('hai')
    })

    it('keeps the old session id when claude returns none', async () => {
        const { child, claude } = harness()
        const p = claude.runAgent({ ...run, sessionId: 'sess-1' })
        child.stdout.emit('data', '{"result":"hai"}')
        child.emit('close', 0)
        expect((await p).sessionId).toBe('sess-1')
    })

    it('says something rather than nothing on an empty result', async () => {
        const { child, claude } = harness()
        const p = claude.runAgent(run)
        child.stdout.emit('data', '{"result":"","session_id":"s"}')
        child.emit('close', 0)
        expect((await p).reply).toBe(EMPTY_REPLY)
    })

    it('clears the session when the output cannot be parsed — a dead --resume', async () => {
        const { child, claude } = harness()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const p = claude.runAgent({ ...run, sessionId: 'sess-1' })
        child.stderr.emit('data', 'session not found')
        child.emit('close', 1)
        expect(await p).toEqual({ reply: BROKEN_SESSION_REPLY, sessionId: null })
    })

    it('kills the child and answers on timeout, keeping the session', async () => {
        vi.useFakeTimers()
        const { child, claude } = harness()
        const p = claude.runAgent({ ...run, sessionId: 'sess-1', timeoutMs: 50 })
        vi.advanceTimersByTime(51)
        expect(await p).toEqual({ reply: TIMEOUT_REPLY, sessionId: 'sess-1' })
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
        vi.useRealTimers()
    })

    it('reports a CLI that will not start', async () => {
        const { child, claude } = harness()
        const p = claude.runAgent(run)
        child.emit('error', new Error('ENOENT'))
        expect((await p).reply).toContain('ENOENT')
    })

    it('answers exactly once even if close follows a timeout', async () => {
        vi.useFakeTimers()
        const { child, claude } = harness()
        const p = claude.runAgent({ ...run, timeoutMs: 10 })
        vi.advanceTimersByTime(11)
        child.stdout.emit('data', '{"result":"terlambat"}')
        child.emit('close', 0)
        expect((await p).reply).toBe(TIMEOUT_REPLY)
        vi.useRealTimers()
    })
})

describe('probeModel', () => {
    it('accepts a model claude is happy with', async () => {
        const { child, claude } = harness()
        const p = claude.probeModel('opus', '/ws')
        child.stdout.emit('data', '{"result":"ok"}')
        child.emit('close', 0)
        expect(await p).toEqual({ ok: true, message: 'ok' })
    })

    it('relays claude’s own rejection verbatim', async () => {
        const { child, claude } = harness()
        const p = claude.probeModel('bogus', '/ws')
        child.stdout.emit('data', '{"is_error":true,"result":"unknown model"}')
        child.emit('close', 1)
        expect(await p).toEqual({ ok: false, message: 'unknown model' })
    })

    it('fails closed on unreadable output, a spawn error, or a timeout', async () => {
        const a = harness()
        const pa = a.claude.probeModel('x', '/ws')
        a.child.stdout.emit('data', 'not json')
        a.child.emit('close', 0)
        expect(await pa).toEqual({ ok: false, message: 'probe gagal dibaca' })

        const b = harness()
        const pb = b.claude.probeModel('x', '/ws')
        b.child.emit('error', new Error('ENOENT'))
        expect((await pb).ok).toBe(false)

        vi.useFakeTimers()
        const c = harness()
        const pc = c.claude.probeModel('x', '/ws', 10)
        vi.advanceTimersByTime(11)
        expect(await pc).toEqual({ ok: false, message: 'probe timeout' })
        expect(c.child.kill).toHaveBeenCalled()
        vi.useRealTimers()
    })
})

describe('model aliases', () => {
    it('reads the aliases out of the CLI help', () => {
        const help = `  --model <model>  Model for the session. Aliases: 'sonnet', 'opus', 'haiku'\n  --verbose`
        expect(parseAliases(help)).toEqual(['sonnet', 'opus', 'haiku'])
    })

    it('de-duplicates repeats', () => {
        expect(parseAliases(`--model 'opus', 'opus', 'sonnet' --x`)).toEqual(['opus', 'sonnet'])
    })

    it('falls back when help has no --model section or cannot be read', () => {
        expect(parseAliases('nothing here')).toEqual(FALLBACK_ALIASES)
        expect(discoverAliases(() => { throw new Error('claude not found') })).toEqual(FALLBACK_ALIASES)
    })
})
