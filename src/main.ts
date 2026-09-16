/**
 * killa-engine — WhatsApp gateway for a Claude Code agent.
 *
 * This file is wiring only: read config, build stores, connect the ports,
 * start the socket. Every decision worth testing lives in src/core.
 *
 * Deliberate properties:
 *  - OWNER-ONLY. Messages from anyone outside OWNER_NUMBERS are ignored.
 *  - REPLY-ONLY, with reminders as the single, fenced-in exception.
 *  - SERIALIZED per chat, so replies can't arrive out of order.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

import { forAccountConfig, parseConfig } from './config.ts'
import { createClaude } from './agent/claude.ts'
import { discoverAliases } from './agent/aliases.ts'
import { createQueue } from './core/queue.ts'
import { dispatch } from './core/dispatch.ts'
import { jsonFile } from './store/json-file.ts'
import { createSessionStore } from './store/sessions.ts'
import { createTranscriptStore, type Line } from './store/transcript.ts'
import { flushStale } from './core/flush.ts'
import { memoryTouchedSince } from './core/memory-files.ts'
import { createModelStore } from './store/models.ts'
import { createReminderStore, type ReminderFile } from './store/reminders.ts'
import { createGateway, downloadMedia, mediaOf, saveIncomingMedia } from './whatsapp/connection.ts'
import { extractText } from './whatsapp/inbound.ts'
import type { ChatSession } from './types.ts'
import type { Deps } from './core/ports.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Timezone is the user's, not the server's: "ingetin jam 7" means 7am where
// the phone is, and a VPS is usually UTC. Set before anything builds a Date —
// Node reads process.env.TZ lazily — and inherited by the claude child, so
// the agent's clock agrees with the scheduler's.
if (process.env.TIMEZONE) process.env.TZ = process.env.TIMEZONE

const { config, errors } = parseConfig(process.env, ROOT, fs.existsSync)
if (errors.length) {
    for (const e of errors) console.error(`FATAL: ${e}`)
    process.exit(1)
}

fs.mkdirSync(config.stateDir, { recursive: true })
fs.mkdirSync(config.mediaDir, { recursive: true })

const log = (account: string, msg: string) =>
    console.log(`[${new Date().toISOString()}] [${account}] ${msg}`)

async function notifyTelegram(text: string): Promise<void> {
    if (!config.telegram) return
    try {
        await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.telegram.chat, text }),
        })
    } catch (e) {
        console.error('Telegram gagal:', (e as Error).message)
    }
}

const claude = createClaude()
const sessions = createSessionStore(
    jsonFile<Record<string, ChatSession>>(path.join(config.stateDir, 'chat-sessions.json'), () => ({})),
    config.sessionIdleMs)
const transcripts = createTranscriptStore(
    jsonFile<Record<string, Line[]>>(path.join(config.stateDir, 'chat-transcripts.json'), () => ({})))
const models = createModelStore(
    jsonFile<Record<string, string>>(path.join(config.stateDir, 'chat-models.json'), () => ({})))
const reminders = createReminderStore({
    file: jsonFile<ReminderFile>(path.join(config.stateDir, 'reminders.json'), () => ({ seq: 0, items: [] })),
    maxPerDay: config.remindersMaxPerDay,
    log: msg => log('reminder', msg),
})

const deps: Deps = {
    config, sessions, transcripts, models, reminders,
    queue: createQueue((key, e) => console.error(`[queue ${key}]`, e.message)),
    modelAliases: discoverAliases(() =>
        execSync(`${process.env.CLAUDE_BIN || 'claude'} --help`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()),
    runAgent: claude.runAgent,
    probeModel: claude.probeModel,
    fileExists: fs.existsSync,
    memoryTouchedSince,
    now: Date.now,
    log,
}

// Sessions past the idle window get one last turn to write memory, then are
// forgotten. Checked on the reminder cadence: a flush a minute late is fine.
setInterval(() => {
    flushStale(deps).catch((e: Error) => console.error('flush:', e.message))
}, config.reminderTickMs)

const gateway = createGateway({
    config, log,
    notify: notifyTelegram,
    onMessage: async (chat, msg) => {
        const text = extractText(msg)
        const media = mediaOf(msg)
        const saved = media
            ? await saveIncomingMedia(media, config.mediaDir, downloadMedia,
                m => console.error(`[${chat.account}] ${m}`))
            : null
        const file = media && saved
            ? { path: saved, kind: media.kind, name: media.name || 'gambar' }
            : null
        await dispatch(chat, { text, hasFile: !!media, file }, deps)
    },
})

// The one outbound the engine initiates. Owner check repeated here on
// purpose: a number removed from OWNER_NUMBERS must stop receiving.
setInterval(() => {
    void reminders.tick(async (r, text) => {
        if (!forAccountConfig(config, r.account).ownerNumbers.includes(r.number)) {
            throw new Error(`${r.number} bukan owner lagi`)
        }
        const chat = gateway.chatFor(r.account, r.jid, r.number)
        if (!chat) throw new Error(`akun ${r.account} belum terhubung`)
        await chat.sendText(text)
    }).catch((e: Error) => console.error('reminder tick:', e.message))
}, config.reminderTickMs)

console.log(`killa-engine start — akun: ${config.accounts.join(', ')}`)
for (const account of config.accounts) {
    const { workspaceDir, ownerNumbers, contactWorkspaces } = forAccountConfig(config, account)
    console.log(`  ${account} → ${workspaceDir}  (owner: ${ownerNumbers.join(', ')})`)
    for (const [number, dir] of Object.entries(contactWorkspaces)) {
        console.log(`    ${number} → ${dir}`)
    }
}
console.log(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} — sekarang `
    + new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }))

for (const account of config.accounts) {
    gateway.start(account).catch((e: Error) => {
        console.error(`[${account}] gagal start:`, e.message)
        setTimeout(() => void gateway.start(account), 10_000)
    })
}

process.on('unhandledRejection', e =>
    console.error('unhandledRejection:', (e as Error)?.message ?? e))
