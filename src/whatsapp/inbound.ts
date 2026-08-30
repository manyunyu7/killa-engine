/**
 * Turning a Baileys message into something the dispatcher understands.
 * The pure parts (text extraction, sender resolution) live here and are
 * tested with plain object fixtures — no socket required.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { WAMessage } from 'baileys'

export function extractText(msg: Pick<WAMessage, 'message'>): string {
    const m = msg.message
    if (!m) return ''
    return m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || ''
}

export interface LidResolver {
    getPNForLID?(jid: string): Promise<string | null | undefined>
}

/**
 * Resolve @lid JIDs to real numbers: Baileys 7 *Alt fields first, then the
 * signal-repository lookup. Returns null when the number can't be known —
 * callers must treat that as "not an owner".
 */
export async function resolveSender(
    key: { remoteJid?: string | null; remoteJidAlt?: string | null; participantAlt?: string | null },
    lookup: LidResolver | undefined,
    onError: (msg: string) => void = () => {},
): Promise<string | null> {
    const jid = key.remoteJid || ''
    if (!jid.endsWith('@lid')) return jid.split('@')[0] || null

    const alt = key.remoteJidAlt || key.participantAlt
    if (alt && alt.endsWith('@s.whatsapp.net')) return alt.split('@')[0] || null

    try {
        const pn = await lookup?.getPNForLID?.(jid)
        if (pn) return String(pn).split('@')[0] || null
    } catch (e) {
        onError(`gagal resolve LID: ${(e as Error).message}`)
    }
    return null
}

export const isGroup = (jid: string): boolean => jid.endsWith('@g.us')

export function imageExtension(mimetype: string | null | undefined): string {
    return (mimetype || 'image/jpeg').split('/')[1]?.split(';')[0] || 'jpeg'
}

/** Download an incoming image to disk; returns the path, or null on failure. */
export async function saveIncomingImage(
    msg: WAMessage,
    mediaDir: string,
    download: (msg: WAMessage) => Promise<Buffer>,
    onError: (msg: string) => void = console.error,
    now: () => number = Date.now,
): Promise<string | null> {
    if (!msg.message?.imageMessage) return null
    try {
        const buf = await download(msg)
        const file = path.join(mediaDir, `in-${now()}.${imageExtension(msg.message.imageMessage.mimetype)}`)
        fs.mkdirSync(mediaDir, { recursive: true })
        fs.writeFileSync(file, buf)
        return file
    } catch (e) {
        onError(`gagal download gambar: ${(e as Error).message}`)
        return null
    }
}
