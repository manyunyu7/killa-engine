/**
 * The memory flush: one extra agent turn, on a session that is about to be
 * forgotten, asking it to write down what mattered.
 *
 * Why the engine does this instead of trusting CLAUDE.md: real transcripts
 * show the agent writes memory only when the user is visibly "reporting"
 * something, and never at the end of a chat — because from inside a session
 * there is no such thing as the end. Only the engine knows the session is
 * about to expire.
 *
 * Kept cheap: skipped for short sessions, skipped when memory files already
 * changed during the session, and run on the cheapest model — it only has
 * to write, the thinking already happened.
 */

import { targetFor } from '../config.ts'
import type { Deps } from './ports.ts'
import type { ChatSession } from '../types.ts'

export const FLUSH_PROMPT =
    '[Pesan dari engine, bukan dari user. Sesi ini akan ditutup dan percakapannya tidak bisa '
    + 'dibuka lagi. Simpan sekarang apa yang perlu diingat dari sesi ini ke file memori workspace '
    + 'sesuai aturan CLAUDE.md (catatan harian, hal yang perlu di-follow-up, fakta baru tentang user). '
    + 'Kalau tidak ada yang layak disimpan, jangan tulis apa-apa. Jangan balas ke user; '
    + 'cukup jawab satu baris: apa yang kamu simpan, atau "tidak ada".]'

export type FlushOutcome = 'flushed' | 'skipped-short' | 'skipped-touched' | 'skipped-off'

/**
 * Flush one session. The caller has already dropped it from the store; this
 * only decides whether a run is worth it and, if so, makes it.
 */
export async function flushSession(s: ChatSession, deps: Deps): Promise<FlushOutcome> {
    const { chat } = s
    const outcome = await decide(s, deps)
    deps.log(chat.account, `flush ${chat.number}: ${outcome} (${s.turns} giliran)`)
    return outcome
}

async function decide(s: ChatSession, deps: Deps): Promise<FlushOutcome> {
    const { config } = deps
    if (!config.flushModel) return 'skipped-off'
    if (s.turns < config.flushMinTurns) return 'skipped-short'
    const { workspace, runAs } = targetFor(config, s.chat)
    if (deps.memoryTouchedSince(workspace, s.startedAt)) return 'skipped-touched'

    const { reply } = await deps.runAgent({
        text: FLUSH_PROMPT,
        sessionId: s.sessionId,
        workspace, runAs,
        // No elevated credentials here: a flush writes memory, nothing else.
        timeoutMs: config.agentTimeoutMs,
        model: config.flushModel,
    })
    deps.log(s.chat.account, `flush ${s.chat.number} <- ${reply.slice(0, 120)}`)
    return 'flushed'
}

/** Flush every session past the idle window. Called from a timer. */
export async function flushStale(deps: Deps): Promise<void> {
    for (const [key, s] of deps.sessions.stale()) {
        // Through the chat's queue, so a flush never overlaps a live turn —
        // and re-checked inside, since a turn may have replaced the session
        // while we waited.
        await deps.queue.enqueue(key, async () => {
            if (deps.sessions.peek(key)?.sessionId !== s.sessionId) return
            deps.sessions.forget(key)
            await flushSession(s, deps)
        })
    }
}
