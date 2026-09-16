/**
 * Message dispatch: slash commands, then the agent run.
 *
 * All I/O arrives through ports, so this file — where every user-visible
 * decision actually lives — is exercised end to end by the tests.
 */

import { routeForChat, targetFor } from '../config.ts'
import { isImageFile } from './files.ts'
import { chunk, parseReply } from './markers.ts'
import { describe } from './schedule.ts'
import { flushSession } from './flush.ts'
import { stamp, stampShort } from './time.ts'
import type { Chat, Deps, Incoming } from './ports.ts'
import type { Config } from '../types.ts'
import type { Line } from '../store/transcript.ts'

export const NO_REMINDERS = '⏰ Belum ada reminder. Minta saja: "ingetin aku jam 7 minum obat".'

/** Handle one owner message. Returns true if a slash command consumed it. */
export async function dispatch(chat: Chat, incoming: Incoming, deps: Deps): Promise<boolean> {
    const text = incoming.text.trim()

    if (text === '/reminders') { await cmdReminders(chat, deps); return true }
    if (text.startsWith('/cancel')) { await cmdCancel(chat, text, deps); return true }
    if (text === '/new') {
        // Queued, not immediate: a /new that lands mid-run must wait for the
        // run to finish, or the run's remember() would resurrect the session.
        void deps.queue.enqueue(chatKey(chat), () => cmdNew(chat, deps))
        return true
    }
    if (text.startsWith('/model')) { await cmdModel(chat, text, deps); return true }

    // Not a command: one agent run at a time per chat.
    void deps.queue.enqueue(chatKey(chat), () => runTurn(chat, incoming, deps))
    return false
}

async function cmdNew(chat: Chat, deps: Deps): Promise<void> {
    const key = chatKey(chat)
    const old = deps.sessions.peek(key)
    deps.sessions.forget(key)
    if (old) await flushSession(old, deps)
    deps.transcripts.clear(key)
    await chat.sendText('🆕 Oke, sesi baru dimulai.')
}

async function cmdReminders(chat: Chat, deps: Deps): Promise<void> {
    const mine = deps.reminders.list(chat.number)
    await chat.sendText(mine.length
        ? `⏰ Reminder aktif:\n${mine.map(describe).join('\n')}\n\nBatalkan: /cancel <id>`
        : NO_REMINDERS)
}

async function cmdCancel(chat: Chat, text: string, deps: Deps): Promise<void> {
    const id = parseInt(text.split(/\s+/)[1] ?? '', 10)
    const gone = Number.isInteger(id) ? deps.reminders.cancel(chat.number, id) : null
    await chat.sendText(gone
        ? `🗑️ Dibatalkan: ${gone.text}`
        : `❌ Reminder #${Number.isInteger(id) ? id : '?'} tidak ketemu. Lihat /reminders.`)
}

async function cmdModel(chat: Chat, text: string, deps: Deps): Promise<void> {
    const arg = text.split(/\s+/)[1]?.toLowerCase()

    if (!arg) {
        await chat.sendText(`🧠 Model sekarang: ${deps.models.get(chatKey(chat)) ?? 'default'}\n`
            + `Ganti: /model ${deps.modelAliases.join(' | ')}\nBalik ke default: /model default`)
        return
    }
    if (arg === 'default') {
        deps.models.set(chatKey(chat), null)
        await chat.sendText('🧠 Oke, balik ke model default.')
        return
    }

    // Any name is allowed (aliases or full ids) — claude is the validator.
    await chat.sendText(`⏳ Ngecek ${arg} ke Claude...`)
    const probe = await deps.probeModel(arg, targetFor(deps.config, chat).workspace)
    if (probe.ok) {
        deps.models.set(chatKey(chat), arg)
        await chat.sendText(`🧠 Oke, pakai ${arg} mulai pesan berikutnya.`)
    } else {
        await chat.sendText(`❌ ${probe.message || 'model ditolak claude'}`)
    }
}

async function runTurn(chat: Chat, incoming: Incoming, deps: Deps): Promise<void> {
    const tag = incoming.file ? `[${incoming.file.kind === 'image' ? 'gambar' : incoming.file.name}] ` : ''
    deps.log(chat.account, `agent <- ${chat.number}: ${tag}${incoming.text.slice(0, 80)}`)
    await chat.presence('composing').catch(() => {}) // cosmetic

    const key = chatKey(chat)
    const resume = deps.sessions.get(key)
    // Coming back after the idle window with the old session still unflushed
    // (the timer hasn't got to it yet): flush it now, alongside this turn.
    // Different session id, so the two runs don't interfere.
    const leftover = resume ? null : deps.sessions.peek(key)
    if (leftover) {
        deps.sessions.forget(key)
        void flushSession(leftover, deps).catch((e: Error) => deps.log(chat.account, `flush gagal: ${e.message}`))
    }
    const { workspace, runAs } = targetFor(deps.config, chat)
    const now = deps.now()
    const text = buildPrompt(incoming, {
        now,
        briefing: resume ? [] : deps.transcripts.recent(key),
    })
    deps.transcripts.append(key, 'user', incoming.text || (incoming.file ? `[${tag.trim()}]` : ''))

    const { reply, sessionId, turns } = await deps.runAgent({
        text,
        sessionId: resume,
        workspace, runAs,
        // The wider credential exists only in this spawn's env, and only for
        // a sender on the list. Nothing the agent is told can conjure it.
        extraEnv: elevatedEnvFor(deps.config, chat),
        timeoutMs: deps.config.agentTimeoutMs,
        model: deps.models.get(chatKey(chat)),
    })
    deps.sessions.remember(key, sessionId, { account: chat.account, jid: chat.jid, number: chat.number })
    deps.transcripts.append(key, 'agent', parseReply(reply).text)

    await chat.presence('paused').catch(() => {}) // cosmetic
    await deliver(chat, reply, deps)
    deps.log(chat.account, `agent -> ${chat.number}: ${reply.length} char`
        + (turns !== undefined ? `, ${turns} turn${turns === 1 ? ' (tanpa tool)' : ''}` : ''))
}

/**
 * The key for per-conversation state.
 *
 * A session belongs to a conversation, not to a person: the same number can be
 * talking to two different workspaces (a DM and a routed group), and those runs
 * may not even share an OS user — so a session id from one is meaningless, and
 * resuming it fails. Including the jid keeps them apart; including the number
 * keeps two people in one group from sharing a thread.
 */
export const chatKey = (chat: { jid: string; number: string }): string => `${chat.jid}#${chat.number}`

/**
 * The elevated credential for this chat's sender, or nothing.
 *
 * The wider database account never sits in the workspace `.env`; it reaches
 * the agent only through this run's environment, and only when the person who
 * typed is on the route's list. No prompt can talk its way into it.
 */
export function elevatedEnvFor(config: Config, chat: { jid: string; number: string }): Record<string, string> {
    const route = routeForChat(config, chat.jid)
    if (!route || !route.elevated.includes(chat.number)) return {}
    return route.elevatedEnv
}

export interface PromptContext {
    now: number
    /** Recent lines to brief a fresh session with; empty when resuming. */
    briefing: Line[]
}

/**
 * The prompt the agent sees: a timestamp, the message, and — on a fresh
 * session only — what was said just before, so the seam between sessions
 * is invisible to the user.
 */
export function buildPrompt(incoming: Incoming, ctx: PromptContext): string {
    const head = ctx.briefing.length ? `${briefingOf(ctx.briefing)}\n\n` : ''
    return `${head}[${stamp(ctx.now)}] ${messageOf(incoming)}`
}

function messageOf(incoming: Incoming): string {
    if (!incoming.hasFile) return incoming.text
    if (!incoming.file) {
        return `${incoming.text}\n\n[User mengirim file tapi gagal diunduh — beri tahu user.]`
    }
    const caption = incoming.text || '(tanpa caption)'
    if (incoming.file.kind === 'image') {
        return `${caption}\n\n[User mengirim sebuah gambar. File-nya ada di ${incoming.file.path}`
            + ' — baca file itu untuk melihat isinya.]'
    }
    // The agent can't open a .docx directly; naming the tool here is the
    // difference between it reading the file and it asking the user to retype.
    return `${caption}\n\n[User mengirim dokumen "${incoming.file.name}". File-nya ada di `
        + `${incoming.file.path} — BACA ISINYA dulu sebelum menjawab. PDF dan teks bisa dibaca `
        + 'langsung; untuk .docx/.pptx/.xlsx jalankan: pandoc "<path>" -t plain]'
}

export function briefingOf(lines: Line[]): string {
    const body = lines.map(l => `${stampShort(l.at)} ${l.who === 'user' ? 'User' : 'Kamu'}: ${l.text}`).join('\n')
    return '[Catatan dari engine: ini sesi baru, sesi sebelumnya sudah ditutup. Sebelum menjawab, '
        + 'baca file memori workspace sesuai CLAUDE.md. Potongan percakapan terakhir, supaya nyambung '
        + '(jangan diulang ke user):\n' + body + ']'
}

/** Send a reply: text chunks, then attachments, then reminder confirmations. */
export async function deliver(chat: Chat, reply: string, deps: Deps): Promise<void> {
    const parsed = parseReply(reply)

    const scheduled = parsed.reminders.map(r => {
        const saved = deps.reminders.add({ ...r, number: chat.number, account: chat.account, jid: chat.jid })
        if (!saved) deps.log(chat.account, `spec reminder tidak dikenal: ${r.spec}`)
        return saved
    }).filter(r => r !== null)

    const chunks = chunk(parsed.text)
    for (const part of chunks) await chat.sendText(part)

    const files = parsed.files.filter(f => deps.fileExists(f))
    for (const file of files) {
        const image = isImageFile(file)
        try { await (image ? chat.sendImage(file) : chat.sendDocument(file)) }
        catch (e) {
            const what = image ? 'gambar' : 'file'
            deps.log(chat.account, `gagal kirim ${what}: ${(e as Error).message}`)
            await chat.sendText(`⚠️ Gagal mengirim ${what} ${file.split('/').pop()}`)
        }
    }

    for (const r of scheduled) await chat.sendText(`⏰ Diingetin: ${describe(r)}`)

    if (!chunks.length && !files.length && !scheduled.length) await chat.sendText('(kosong)')
}
