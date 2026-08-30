/**
 * Message dispatch: slash commands, then the agent run.
 *
 * All I/O arrives through ports, so this file — where every user-visible
 * decision actually lives — is exercised end to end by the tests.
 */

import { forAccountConfig } from '../config.ts'
import { chunk, parseReply } from './markers.ts'
import { describe } from './schedule.ts'
import type { Chat, Deps, Incoming } from './ports.ts'

export const NO_REMINDERS = '⏰ Belum ada reminder. Minta saja: "ingetin aku jam 7 minum obat".'

/** Handle one owner message. Returns true if a slash command consumed it. */
export async function dispatch(chat: Chat, incoming: Incoming, deps: Deps): Promise<boolean> {
    const text = incoming.text.trim()

    if (text === '/reminders') { await cmdReminders(chat, deps); return true }
    if (text.startsWith('/cancel')) { await cmdCancel(chat, text, deps); return true }
    if (text === '/new') {
        deps.sessions.remember(chat.number, null)
        await chat.sendText('🆕 Oke, sesi baru dimulai.')
        return true
    }
    if (text.startsWith('/model')) { await cmdModel(chat, text, deps); return true }

    // Not a command: one agent run at a time per chat.
    void deps.queue.enqueue(chat.number, () => runTurn(chat, incoming, deps))
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
        await chat.sendText(`🧠 Model sekarang: ${deps.models.get(chat.number) ?? 'default'}\n`
            + `Ganti: /model ${deps.modelAliases.join(' | ')}\nBalik ke default: /model default`)
        return
    }
    if (arg === 'default') {
        deps.models.set(chat.number, null)
        await chat.sendText('🧠 Oke, balik ke model default.')
        return
    }

    // Any name is allowed (aliases or full ids) — claude is the validator.
    await chat.sendText(`⏳ Ngecek ${arg} ke Claude...`)
    const probe = await deps.probeModel(arg, forAccountConfig(deps.config, chat.account).workspaceDir)
    if (probe.ok) {
        deps.models.set(chat.number, arg)
        await chat.sendText(`🧠 Oke, pakai ${arg} mulai pesan berikutnya.`)
    } else {
        await chat.sendText(`❌ ${probe.message || 'model ditolak claude'}`)
    }
}

async function runTurn(chat: Chat, incoming: Incoming, deps: Deps): Promise<void> {
    deps.log(chat.account, `agent <- ${chat.number}: ${incoming.hasImage ? '[gambar] ' : ''}${incoming.text.slice(0, 80)}`)
    await chat.presence('composing').catch(() => {}) // cosmetic

    const { reply, sessionId } = await deps.runAgent({
        text: buildPrompt(incoming),
        sessionId: deps.sessions.get(chat.number),
        // Per-account workspace: one process can run several personas.
        workspace: forAccountConfig(deps.config, chat.account).workspaceDir,
        timeoutMs: deps.config.agentTimeoutMs,
        model: deps.models.get(chat.number),
    })
    deps.sessions.remember(chat.number, sessionId)

    await chat.presence('paused').catch(() => {}) // cosmetic
    await deliver(chat, reply, deps)
    deps.log(chat.account, `agent -> ${chat.number}: ${reply.length} char`)
}

export function buildPrompt(incoming: Incoming): string {
    if (!incoming.hasImage) return incoming.text
    return incoming.imagePath
        ? `${incoming.text || '(tanpa caption)'}\n\n[User mengirim sebuah gambar. File-nya ada di ${incoming.imagePath} — baca file itu untuk melihat isinya.]`
        : `${incoming.text}\n\n[User mengirim gambar tapi gagal diunduh — beri tahu user.]`
}

/** Send a reply: text chunks, then images, then reminder confirmations. */
export async function deliver(chat: Chat, reply: string, deps: Deps): Promise<void> {
    const parsed = parseReply(reply)

    const scheduled = parsed.reminders.map(r => {
        const saved = deps.reminders.add({ ...r, number: chat.number, account: chat.account, jid: chat.jid })
        if (!saved) deps.log(chat.account, `spec reminder tidak dikenal: ${r.spec}`)
        return saved
    }).filter(r => r !== null)

    const chunks = chunk(parsed.text)
    for (const part of chunks) await chat.sendText(part)

    const images = parsed.images.filter(f => deps.fileExists(f))
    for (const file of images) {
        try { await chat.sendImage(file) }
        catch (e) {
            deps.log(chat.account, `gagal kirim gambar: ${(e as Error).message}`)
            await chat.sendText(`⚠️ Gagal mengirim gambar ${file.split('/').pop()}`)
        }
    }

    for (const r of scheduled) await chat.sendText(`⏰ Diingetin: ${describe(r)}`)

    if (!chunks.length && !images.length && !scheduled.length) await chat.sendText('(kosong)')
}
