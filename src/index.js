/**
 * killa-engine — WhatsApp gateway for a Claude Code agent.
 *
 * Forked from 168Railway's wa-listener (battle-tested Baileys handling:
 * LID resolution, per-account generation guard, reconnect logic) with the
 * OTP forwarding replaced by an agent bridge.
 *
 * Flow: owner sends a message -> queued per chat -> `claude -p` runs in the
 * workspace -> reply goes back on the same socket.
 *
 * Deliberate properties:
 *  - OWNER-ONLY. Messages from anyone not in OWNER_NUMBERS are ignored
 *    silently. This is a personal agent, not a public bot.
 *  - REPLY-ONLY. The engine only ever sends into a chat the owner just
 *    wrote in. No cold outbound — that's what gets WhatsApp accounts banned.
 *  - SERIALIZED per chat. One agent run at a time per conversation, so
 *    replies can't arrive out of order.
 */

const path = require('path')
const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const QRImage = require('qrcode')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
} = require('baileys')
const { runAgent } = require('./agent')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

// ── Config ──────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..')
const ACCOUNTS = (process.env.ACCOUNTS || 'main').split(',').map(s => s.trim()).filter(Boolean)
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)
const WORKSPACE_DIR = process.env.WORKSPACE_DIR
const SESSION_DIR = process.env.SESSION_DIR || path.join(ROOT, 'sessions')
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state')
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MINUTES || '30', 10) * 60 * 1000
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_SECONDS || '300', 10) * 1000
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TG_CHAT = process.env.TELEGRAM_CHAT_ID

if (!WORKSPACE_DIR || !fs.existsSync(WORKSPACE_DIR)) {
    console.error('FATAL: WORKSPACE_DIR wajib diisi dan harus ada.')
    process.exit(1)
}
if (OWNER_NUMBERS.length === 0) {
    console.error('FATAL: OWNER_NUMBERS wajib diisi — tanpa ini semua pesan diabaikan.')
    process.exit(1)
}

fs.mkdirSync(STATE_DIR, { recursive: true })

const logger = pino({ level: 'warn' })

function log(account, msg) {
    console.log(`[${new Date().toISOString()}] [${account}] ${msg}`)
}

async function notifyTelegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text }),
        })
    } catch (e) {
        console.error('Telegram gagal:', e.message)
    }
}

// ── Per-chat agent sessions ─────────────────────────────────────────────
//
// { [number]: { sessionId, lastAt } } persisted to disk so a pm2 restart
// doesn't amnesia every conversation.

const SESSIONS_FILE = path.join(STATE_DIR, 'chat-sessions.json')
let chatSessions = {}
try { chatSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch (e) { /* first run */ }

function saveSessions() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(chatSessions, null, 2)) }
    catch (e) { console.error('gagal simpan sessions:', e.message) }
}

function sessionFor(number) {
    const s = chatSessions[number]
    if (!s) return null
    if (Date.now() - s.lastAt > SESSION_IDLE_MS) return null // stale → fresh session
    return s.sessionId
}

function rememberSession(number, sessionId) {
    if (sessionId) chatSessions[number] = { sessionId, lastAt: Date.now() }
    else delete chatSessions[number]
    saveSessions()
}

// ── Per-chat model choice ───────────────────────────────────────────────
//
// Separate from chatSessions on purpose: a model choice should survive
// session resets (/new, idle expiry). Values are passed to `claude --model`.

const MODELS_FILE = path.join(STATE_DIR, 'chat-models.json')

// Aliases shown in /model help come from the claude CLI itself, so the list
// tracks whatever this installation actually offers. Validation is claude's
// job too: /model probes the CLI and relays its verdict.
let MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] // fallback if --help parse fails
try {
    const help = require('child_process').execSync(`${process.env.CLAUDE_BIN || 'claude'} --help`,
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const section = help.split('--model')[1]?.split('--')[0] || ''
    const found = [...section.matchAll(/'([a-z][a-z0-9.-]*)'/g)].map(m => m[1])
    if (found.length) MODEL_ALIASES = [...new Set(found)]
} catch (e) { /* keep fallback */ }
let chatModels = {}
try { chatModels = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) } catch (e) { /* first run */ }

function setModel(number, model) {
    if (model) chatModels[number] = model
    else delete chatModels[number]
    try { fs.writeFileSync(MODELS_FILE, JSON.stringify(chatModels, null, 2)) }
    catch (e) { console.error('gagal simpan models:', e.message) }
}

// ── Per-chat queue ──────────────────────────────────────────────────────

const queues = new Map() // number -> Promise chain

function enqueue(number, job) {
    const tail = queues.get(number) || Promise.resolve()
    const next = tail.then(job).catch(e => console.error(`[queue ${number}]`, e.message))
    queues.set(number, next)
    return next
}

// ── WhatsApp plumbing (inherited from wa-listener) ──────────────────────

const state = {}
const sockets = {}
const generation = {}

function extractText(msg) {
    const m = msg.message
    if (!m) return ''
    return m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || ''
}

/** Resolve @lid JIDs to real numbers (Baileys 7 *Alt fields, then lookup). */
async function resolveSender(sock, account, key) {
    const jid = key.remoteJid || ''
    if (!jid.endsWith('@lid')) return jid.split('@')[0]

    const alt = key.remoteJidAlt || key.participantAlt
    if (alt && alt.endsWith('@s.whatsapp.net')) return alt.split('@')[0]

    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
        if (pn) return String(pn).split('@')[0]
    } catch (e) {
        console.error(`[${account}] gagal resolve LID:`, e.message)
    }
    return null
}

// ── Media ───────────────────────────────────────────────────────────────

const MEDIA_DIR = path.join(STATE_DIR, 'media')
fs.mkdirSync(MEDIA_DIR, { recursive: true })

/** Download an incoming image to disk; returns the path or null. */
async function saveIncomingImage(msg, account) {
    if (!msg.message?.imageMessage) return null
    try {
        const buf = await downloadMediaMessage(msg, 'buffer', {})
        const ext = (msg.message.imageMessage.mimetype || 'image/jpeg').split('/')[1].split(';')[0]
        const file = path.join(MEDIA_DIR, `in-${Date.now()}.${ext}`)
        fs.writeFileSync(file, buf)
        return file
    } catch (e) {
        console.error(`[${account}] gagal download gambar:`, e.message)
        return null
    }
}

/**
 * Outbound images use a marker convention: any [[send:/abs/path]] in the
 * agent's reply is stripped from the text and sent as an image message.
 * The workspace CLAUDE.md should mention this convention to the agent.
 */
const SEND_MARKER = /\[\[send:([^\]]+)\]\]/g

async function deliverReply(sock, replyJid, reply) {
    const images = []
    const text = reply.replace(SEND_MARKER, (_, p) => {
        const file = p.trim()
        if (fs.existsSync(file)) images.push(file)
        return ''
    }).replace(/\n{3,}/g, '\n\n').trim()

    const chunks = text ? (text.match(/[\s\S]{1,3500}/g) || []) : []
    for (const chunk of chunks) {
        await sock.sendMessage(replyJid, { text: chunk })
    }
    for (const file of images) {
        try {
            await sock.sendMessage(replyJid, { image: fs.readFileSync(file) })
        } catch (e) {
            console.error('gagal kirim gambar:', e.message)
            await sock.sendMessage(replyJid, { text: `⚠️ Gagal mengirim gambar ${path.basename(file)}` })
        }
    }
    if (!chunks.length && !images.length) {
        await sock.sendMessage(replyJid, { text: '(kosong)' })
    }
}

async function handleMessage(sock, account, msg) {
    const jid = msg.key.remoteJid || ''
    if (jid.endsWith('@g.us')) return // groups: not yet

    const text = extractText(msg)
    const hasImage = !!msg.message?.imageMessage
    if (!text && !hasImage) return

    const sender = await resolveSender(sock, account, msg.key)
    if (!sender) return
    if (!OWNER_NUMBERS.includes(sender)) {
        log(account, `pesan dari ${sender} diabaikan (bukan owner)`)
        return
    }

    // Reply to the JID the message came in on (works for both @lid and PN).
    const replyJid = jid

    if (text.trim() === '/new') {
        rememberSession(sender, null)
        await sock.sendMessage(replyJid, { text: '🆕 Oke, sesi baru dimulai.' })
        return
    }

    if (text.trim().startsWith('/model')) {
        const arg = text.trim().split(/\s+/)[1]?.toLowerCase()
        if (!arg) {
            await sock.sendMessage(replyJid, {
                text: `🧠 Model sekarang: ${chatModels[sender] || 'default'}\nGanti: /model ${MODEL_ALIASES.join(' | ')}\nBalik ke default: /model default`,
            })
        } else if (arg === 'default') {
            setModel(sender, null)
            await sock.sendMessage(replyJid, { text: '🧠 Oke, balik ke model default.' })
        } else {
            // Any name is allowed (aliases or full model ids) — claude is the
            // validator. Probe it; on rejection, relay claude's own message.
            const { probeModel } = require('./agent')
            await sock.sendMessage(replyJid, { text: `⏳ Ngecek ${arg} ke Claude...` })
            const probe = await probeModel(arg, WORKSPACE_DIR)
            if (probe.ok) {
                setModel(sender, arg)
                await sock.sendMessage(replyJid, { text: `🧠 Oke, pakai ${arg} mulai pesan berikutnya.` })
            } else {
                await sock.sendMessage(replyJid, { text: `❌ ${probe.message || 'model ditolak claude'}` })
            }
        }
        return
    }

    enqueue(sender, async () => {
        log(account, `agent <- ${sender}: ${hasImage ? '[gambar] ' : ''}${text.slice(0, 80)}`)
        try { await sock.sendPresenceUpdate('composing', replyJid) } catch (e) { /* cosmetic */ }

        let prompt = text
        if (hasImage) {
            const file = await saveIncomingImage(msg, account)
            prompt = file
                ? `${text || '(tanpa caption)'}\n\n[User mengirim sebuah gambar. File-nya ada di ${file} — baca file itu untuk melihat isinya.]`
                : `${text || ''}\n\n[User mengirim gambar tapi gagal diunduh — beri tahu user.]`
        }

        const { reply, sessionId } = await runAgent({
            text: prompt,
            sessionId: sessionFor(sender),
            workspace: WORKSPACE_DIR,
            timeoutMs: AGENT_TIMEOUT_MS,
            model: chatModels[sender],
        })
        rememberSession(sender, sessionId)

        try { await sock.sendPresenceUpdate('paused', replyJid) } catch (e) { /* cosmetic */ }

        await deliverReply(sock, replyJid, reply)
        log(account, `agent -> ${sender}: ${reply.length} char`)
    })
}

async function start(account) {
    try { sockets[account]?.end?.() } catch (e) { /* mungkin sudah mati */ }

    // Generation guard: stale sockets keep emitting events after a 515
    // reconnect; without this they'd clobber the new socket's state.
    const myGen = generation[account] = (generation[account] || 0) + 1
    const isStale = () => generation[account] !== myGen

    const dir = path.join(SESSION_DIR, account)
    fs.mkdirSync(dir, { recursive: true })

    const { state: authState, saveCreds } = await useMultiFileAuthState(dir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: authState,
        logger,
        printQRInTerminal: false,
        syncFullHistory: false,
    })

    state[account] = { connected: false, qr: null, number: null, since: null }
    sockets[account] = sock

    sock.ev.on('creds.update', () => { if (!isStale()) saveCreds() })

    sock.ev.on('connection.update', (update) => {
        if (isStale()) return
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            state[account].qr = qr
            const png = path.join(ROOT, `qr-${account}.png`)
            QRImage.toFile(png, qr, { width: 512, margin: 2 })
                .then(() => log(account, `Perlu scan QR — gambar: ${png}`))
                .catch(e => console.error('gagal tulis QR png:', e.message))
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'open') {
            const number = sock.user?.id?.split(':')[0] || null
            fs.rmSync(path.join(ROOT, `qr-${account}.png`), { force: true })
            Object.assign(state[account], { connected: true, qr: null, number, since: new Date().toISOString() })
            log(account, `TERHUBUNG sebagai ${number}`)
        }

        if (connection === 'close') {
            state[account].connected = false
            const code = lastDisconnect?.error?.output?.statusCode
            const loggedOut = code === DisconnectReason.loggedOut
            log(account, `terputus (code ${code}), loggedOut=${loggedOut}`)

            if (loggedOut) {
                notifyTelegram(`🚨 killa-engine [${account}] LOGOUT — perlu scan QR ulang.`)
                fs.rmSync(dir, { recursive: true, force: true })
            }
            setTimeout(() => start(account), 5000)
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (isStale()) return
        if (type !== 'notify') return

        for (const msg of messages) {
            if (msg.key.fromMe) continue
            handleMessage(sock, account, msg).catch(e =>
                console.error(`[${account}] handleMessage:`, e.message))
        }
    })
}

// ── Main ────────────────────────────────────────────────────────────────

console.log(`killa-engine start — akun: ${ACCOUNTS.join(', ')}`)
console.log(`workspace: ${WORKSPACE_DIR}`)
console.log(`owner: ${OWNER_NUMBERS.join(', ')}`)

for (const account of ACCOUNTS) {
    start(account).catch(e => {
        console.error(`[${account}] gagal start:`, e.message)
        setTimeout(() => start(account), 10000)
    })
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e))
