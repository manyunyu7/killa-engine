/**
 * The bridge to Claude Code.
 *
 * One function: give it a message, get a reply. Everything else — tools,
 * memory, file access, skills — is Claude Code's job. That is the whole point
 * of this project: we don't build an agent runtime, we borrow one.
 *
 * `spawn` is injectable so tests can drive timeouts, crashes and malformed
 * output without a real CLI on PATH.
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** Fixed path: the sudoers rule names this exact binary. */
export const SUDO_BRIDGE = '/usr/local/bin/killa-claude'
import type { AgentResult, AgentRun, ProbeResult, TurnUsage } from '../types.ts'

export type Spawn = typeof nodeSpawn

export interface ClaudeOptions {
    bin?: string
    spawn?: Spawn
}

export const TIMEOUT_REPLY = '⏱️ Kelamaan mikir — coba tanya lagi.'
export const EMPTY_REPLY = '🤔 (agent selesai tanpa jawaban)'
export const BROKEN_SESSION_REPLY = '⚠️ Sesi agent bermasalah — pesan berikutnya mulai sesi baru.'

export function createClaude({ bin = process.env.CLAUDE_BIN || 'claude',
                               spawn = nodeSpawn }: ClaudeOptions = {}) {

    function runAgent({ text, sessionId, workspace, timeoutMs, model, runAs, extraEnv }: AgentRun): Promise<AgentResult> {
        return new Promise(resolve => {
            const args = ['-p', text, '--output-format', 'json']
            if (model) args.push('--model', model)
            // Headless run: nobody is there to approve tool calls. The
            // workspace is the blast radius.
            args.push('--dangerously-skip-permissions')
            if (sessionId) args.push('--resume', sessionId)

            // `runAs` hands the run to another OS user through a fixed sudo
            // bridge. The bridge does the chdir itself: this process may not
            // even be able to enter that user's home, so setting cwd here
            // would fail before exec.
            const extra = extraEnv ?? {}
            const names = Object.keys(extra)
            const child = runAs
                ? spawn('sudo', ['-n', '-u', runAs,
                                 ...(names.length ? [`--preserve-env=${names.join(',')}`] : []),
                                 SUDO_BRIDGE, workspace, ...args],
                        { env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
                : spawn(bin, args, { cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })

            let out = ''
            let err = ''
            let done = false
            const finish = (result: AgentResult) => {
                if (done) return
                done = true
                clearTimeout(timer)
                resolve(result)
            }

            const timer = setTimeout(() => {
                child.kill('SIGKILL')
                finish({ reply: TIMEOUT_REPLY, sessionId })
            }, timeoutMs)

            child.stdout?.on('data', (c: Buffer) => { out += c })
            child.stderr?.on('data', (c: Buffer) => { err += c })
            child.on('error', (e: Error) => finish({ reply: `⚠️ Gagal menjalankan agent: ${e.message}`, sessionId }))

            child.on('close', (code: number | null) => {
                try {
                    const parsed = JSON.parse(out) as CliResult
                    const reply = (parsed.result ?? '').trim()
                    const usage = parseUsage(parsed, model)
                    finish({ reply: reply || EMPTY_REPLY, sessionId: parsed.session_id ?? sessionId,
                             ...(typeof parsed.num_turns === 'number' ? { turns: parsed.num_turns } : {}),
                             ...(usage ? { usage } : {}) })
                } catch {
                    // A dead --resume target is the common failure here; null
                    // the session so the next message starts fresh.
                    console.error(`agent exit ${code}: ${err.slice(0, 500)}`)
                    finish({ reply: BROKEN_SESSION_REPLY, sessionId: null })
                }
            })
        })
    }

    /**
     * Cheap validity check for a model name: a bogus model fails in seconds at
     * zero cost with claude's own explanation, which we relay verbatim.
     */
    function probeModel(model: string, workspace: string, timeoutMs = 60_000): Promise<ProbeResult> {
        return new Promise(resolve => {
            const child = spawn(bin, ['-p', 'ok', '--model', model, '--output-format', 'json'],
                { cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            let done = false
            const finish = (r: ProbeResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
            const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, message: 'probe timeout' }) }, timeoutMs)

            child.stdout?.on('data', (c: Buffer) => { out += c })
            child.on('error', (e: Error) => finish({ ok: false, message: e.message }))
            child.on('close', () => {
                try {
                    const parsed = JSON.parse(out) as { is_error?: boolean; result?: string }
                    finish({ ok: !parsed.is_error, message: (parsed.result ?? '').trim() })
                } catch { finish({ ok: false, message: 'probe gagal dibaca' }) }
            })
        })
    }

    return { runAgent, probeModel }
}

export type Claude = ReturnType<typeof createClaude>

/** The parts of `claude -p --output-format json` the engine reads. */
export interface CliResult {
    result?: string
    session_id?: string
    num_turns?: number
    total_cost_usd?: number
    duration_ms?: number
    usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
    modelUsage?: Record<string, {
        inputTokens?: number
        outputTokens?: number
        cacheReadInputTokens?: number
        cacheCreationInputTokens?: number
        costUSD?: number
    }>
}

const n = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0

/**
 * Token and cost accounting from one CLI result, or undefined when it carried
 * none (an old CLI, a crash). `modelUsage` is preferred when present: it
 * covers every model the run touched (sub-agents, the CLI's own haiku calls),
 * where `usage` covers only the main loop.
 */
export function parseUsage(r: CliResult, requested?: string): TurnUsage | undefined {
    const models = Object.entries(r.modelUsage ?? {})
    if (!models.length && !r.usage && r.total_cost_usd === undefined) return undefined
    const tokens = models.length
        ? models.reduce((t, [, m]) => ({
            inputTokens: t.inputTokens + n(m.inputTokens),
            outputTokens: t.outputTokens + n(m.outputTokens),
            cacheReadTokens: t.cacheReadTokens + n(m.cacheReadInputTokens),
            cacheCreationTokens: t.cacheCreationTokens + n(m.cacheCreationInputTokens),
        }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
        : {
            inputTokens: n(r.usage?.input_tokens),
            outputTokens: n(r.usage?.output_tokens),
            cacheReadTokens: n(r.usage?.cache_read_input_tokens),
            cacheCreationTokens: n(r.usage?.cache_creation_input_tokens),
        }
    const main = models.sort(([, a], [, b]) => n(b.costUSD) - n(a.costUSD))[0]?.[0]
    return {
        model: main ?? requested ?? null,
        ...tokens,
        costUsd: n(r.total_cost_usd) || models.reduce((c, [, m]) => c + n(m.costUSD), 0),
        durationMs: n(r.duration_ms),
    }
}
