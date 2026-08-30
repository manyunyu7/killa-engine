/**
 * Baileys socket lifecycle — inherited from 168Railway's wa-listener, which
 * survived real LID migration, 515 reconnect storms and multi-account
 * operation. Deliberately the only untested file: it is nothing but wiring
 * around a live socket, and everything it calls is covered elsewhere.
 */

import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import QRImage from 'qrcode'
import {
    default as makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
    type WAMessage,
    type WASocket,
} from 'baileys'

import { forAccountConfig } from '../config.ts'
import type { Config, Logger } from '../types.ts'
import { extractText, isGroup, resolveSender, saveIncomingImage } from './inbound.ts'
import type { Chat } from '../core/ports.ts'

export interface AccountState {
    connected: boolean
    qr: string | null
    number: string | null
    since: string | null
}

export interface Gateway {
    start(account: string): Promise<void>
    /** Chat handle for an already-known conversation, or null if offline. */
    chatFor(account: string, jid: string, number: string): Chat | null
    state(account: string): AccountState | undefined
}

export interface GatewayOptions {
    config: Config
    log: Logger
    notify(text: string): Promise<void>
    onMessage(chat: Chat, msg: WAMessage): Promise<void>
}

const logger = pino({ level: 'warn' })

export function createGateway({ config, log, notify, onMessage }: GatewayOptions): Gateway {
    const sockets: Record<string, WASocket> = {}
    const states: Record<string, AccountState> = {}
    const generation: Record<string, number> = {}

    function makeChat(account: string, jid: string, number: string): Chat {
        const sock = sockets[account]!
        return {
            account, jid, number,
            sendText: async text => { await sock.sendMessage(jid, { text }) },
            sendImage: async file => { await sock.sendMessage(jid, { image: fs.readFileSync(file) }) },
            presence: async state => { await sock.sendPresenceUpdate(state, jid) },
        }
    }

    async function start(account: string): Promise<void> {
        try { sockets[account]?.end?.(undefined) } catch { /* mungkin sudah mati */ }

        // Generation guard: stale sockets keep emitting events after a 515
        // reconnect; without this they'd clobber the new socket's state.
        const myGen = generation[account] = (generation[account] ?? 0) + 1
        const isStale = () => generation[account] !== myGen

        const dir = path.join(config.sessionDir, account)
        fs.mkdirSync(dir, { recursive: true })

        const { state: authState, saveCreds } = await useMultiFileAuthState(dir)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({ version, auth: authState, logger, syncFullHistory: false })
        states[account] = { connected: false, qr: null, number: null, since: null }
        sockets[account] = sock

        sock.ev.on('creds.update', () => { if (!isStale()) void saveCreds() })

        sock.ev.on('connection.update', update => {
            if (isStale()) return
            const { connection, lastDisconnect, qr } = update
            const st = states[account]!

            if (qr) {
                st.qr = qr
                const png = path.join(config.root, `qr-${account}.png`)
                QRImage.toFile(png, qr, { width: 512, margin: 2 })
                    .then(() => log(account, `Perlu scan QR — gambar: ${png}`))
                    .catch((e: Error) => console.error('gagal tulis QR png:', e.message))
                qrcode.generate(qr, { small: true })
            }

            if (connection === 'open') {
                const number = sock.user?.id?.split(':')[0] ?? null
                fs.rmSync(path.join(config.root, `qr-${account}.png`), { force: true })
                Object.assign(st, { connected: true, qr: null, number, since: new Date().toISOString() })
                log(account, `TERHUBUNG sebagai ${number}`)
            }

            if (connection === 'close') {
                st.connected = false
                const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
                const loggedOut = code === DisconnectReason.loggedOut
                log(account, `terputus (code ${code}), loggedOut=${loggedOut}`)

                if (loggedOut) {
                    void notify(`🚨 killa-engine [${account}] LOGOUT — perlu scan QR ulang.`)
                    fs.rmSync(dir, { recursive: true, force: true })
                }
                setTimeout(() => void start(account), 5000)
            }
        })

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (isStale() || type !== 'notify') return

            for (const msg of messages) {
                if (msg.key.fromMe) continue
                const jid = msg.key.remoteJid || ''
                if (isGroup(jid)) continue // groups: not yet
                if (!extractText(msg) && !msg.message?.imageMessage) continue

                const sender = await resolveSender(msg.key, sock.signalRepository?.lidMapping,
                    m => console.error(`[${account}] ${m}`))
                if (!sender) continue
                if (!forAccountConfig(config, account).ownerNumbers.includes(sender)) {
                    log(account, `pesan dari ${sender} diabaikan (bukan owner)`)
                    continue
                }

                // Reply on the JID it came in on (works for @lid and PN alike).
                onMessage(makeChat(account, jid, sender), msg)
                    .catch((e: Error) => console.error(`[${account}] onMessage:`, e.message))
            }
        })
    }

    return {
        start,
        chatFor: (account, jid, number) =>
            sockets[account] && states[account]?.connected ? makeChat(account, jid, number) : null,
        state: account => states[account],
    }
}

export const downloadImage = (msg: WAMessage): Promise<Buffer> =>
    downloadMediaMessage(msg, 'buffer', {}) as Promise<Buffer>

export { saveIncomingImage }
