/**
 * Message dispatch: slash commands, then the agent run.
 *
 * All I/O arrives through ports, so this file — where every user-visible
 * decision actually lives — is exercised end to end by the tests.
 */

import { routeForChat, workspaceFor } from '../config.ts'
import { isImageFile } from './files.ts'
import { chunk, parseReply } from './markers.ts'
import { describe } from './schedule.ts'
import type { Chat, Deps, Incoming } from './ports.ts'
import type { Config } from '../types.ts'

export const NO_REMINDERS = '⏰ Belum ada reminder. Minta saja: "ingetin aku jam 7 minum obat".'

/** Handle one owner message. Returns true if a slash command consumed it. */
export async function dispatch(chat: Chat, incoming: Incoming, deps: Deps): Promise<boolean> {
    const text = incoming.text.trim()

    if (text === '/reminders') { await cmdReminders(chat, deps); return true }
    if (text.startsWith('/cancel')) { await cmdCancel(chat, text, deps); return true }
    if (text === '/new') {
        deps.sessions.remember(chatKey(chat), null)
        await chat.sendText('🆕 Oke, sesi baru dimulai.')
        return true
    }
    if (text.startsWith('/model')) { await cmdModel(chat, text, deps); return true }

    // Not a command: one agent run at a time per chat.
    void deps.queue.enqueue(chatKey(chat), () => runTurn(chat, incoming, deps))
    return false
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
    const probe = await deps.probeModel(arg, routeForChat(deps.config, chat.jid)?.workspaceDir
        ?? workspaceFor(deps.config, chat.account, chat.number))
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

    const { reply, sessionId } = await deps.runAgent({
        text: buildPrompt(incoming),
        sessionId: deps.sessions.get(chatKey(chat)),
        // A routed group brings its own workspace (and its own OS user);
        // everything else uses the account's.
        workspace: routeForChat(deps.config, chat.jid)?.workspaceDir
            ?? workspaceFor(deps.config, chat.account, chat.number),
        runAs: routeForChat(deps.config, chat.jid)?.runAs ?? null,
        // The wider credential exists only in this spawn's env, and only for
        // a sender on the list. Nothing the agent is told can conjure it.
        extraEnv: elevatedEnvFor(deps.config, chat),
        timeoutMs: deps.config.agentTimeoutMs,
        model: deps.models.get(chatKey(chat)),
    })
    deps.sessions.remember(chatKey(chat), sessionId)

    await chat.presence('paused').catch(() => {}) // cosmetic
    await deliver(chat, reply, deps)
    deps.log(chat.account, `agent -> ${chat.number}: ${reply.length} char`)
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

export function buildPrompt(incoming: Incoming): string {
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
