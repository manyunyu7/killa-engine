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
        // A document sent with a caption is wrapped one level deeper; without
        // this the caption — usually the actual instruction — is lost.
        || m.documentMessage?.caption
        || m.documentWithCaptionMessage?.message?.documentMessage?.caption
        || ''
}

export interface Media {
    /** 'image' renders inline for the agent; 'document' needs converting first. */
    kind: 'image' | 'document'
    /** The Baileys node to download — may be nested inside a caption wrapper. */
    msg: WAMessage
    /** Original filename for documents, so the agent can name what it got. */
    name: string
    mimetype: string | null | undefined
}

/**
 * The one attachment a message carries, or null.
 *
 * Documents arrive in two shapes — bare, and wrapped when they have a caption.
 * Treating only the bare one as a document is why a captioned .docx used to
 * vanish without a trace.
 */
export function mediaOf(msg: WAMessage): Media | null {
    const m = msg.message
    if (!m) return null
    if (m.imageMessage) {
        return { kind: 'image', msg, name: '', mimetype: m.imageMessage.mimetype }
    }
    const wrapped = m.documentWithCaptionMessage?.message
    const doc = m.documentMessage ?? wrapped?.documentMessage
    if (!doc) return null
    return {
        kind: 'document',
        // Downloading the wrapper fails; hand back the inner message instead.
        msg: wrapped ? ({ ...msg, message: wrapped } as WAMessage) : msg,
        name: doc.fileName || 'dokumen',
        mimetype: doc.mimetype,
    }
}

export interface LidResolver {
    getPNForLID?(jid: string): Promise<string | null | undefined>
}

/**
 * Resolve @lid JIDs to real numbers: Baileys 7 *Alt fields first, then the
 * signal-repository lookup. Returns null when the number can't be known —
 * callers must treat that as "not an owner".
 */
export const isGroup = (jid: string): boolean => jid.endsWith('@g.us')

export async function resolveSender(
    key: { remoteJid?: string | null; remoteJidAlt?: string | null;
           participant?: string | null; participantAlt?: string | null },
    lookup: LidResolver | undefined,
    onError: (msg: string) => void = () => {},
): Promise<string | null> {
    // In a group `remoteJid` is the group itself; the person who typed is in
    // `participant`. Reading the group id as the sender makes every member
    // look like one caller — no per-person rules, one shared session.
    const jid = isGroup(key.remoteJid || '')
        ? (key.participant || key.participantAlt || '')
        : (key.remoteJid || '')
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

export function imageExtension(mimetype: string | null | undefined): string {
    return (mimetype || 'image/jpeg').split('/')[1]?.split(';')[0] || 'jpeg'
}

/** Keep the sender's filename but never let it escape the media dir. */
export function safeName(name: string): string {
    const base = path.basename(name).replace(/[^\w.\- ]+/g, '_').trim()
    return base && base !== '.' && base !== '..' ? base.slice(0, 120) : 'dokumen'
}

/** Download an incoming image or document to disk; null on failure. */
export async function saveIncomingMedia(
    media: Media,
    mediaDir: string,
    download: (msg: WAMessage) => Promise<Buffer>,
    onError: (msg: string) => void = console.error,
    now: () => number = Date.now,
): Promise<string | null> {
    const what = media.kind === 'image' ? 'gambar' : 'dokumen'
    try {
        const buf = await download(media.msg)
        const name = media.kind === 'image'
            ? `in-${now()}.${imageExtension(media.mimetype)}`
            : `in-${now()}-${safeName(media.name)}`
        const file = path.join(mediaDir, name)
        fs.mkdirSync(mediaDir, { recursive: true })
        fs.writeFileSync(file, buf)
        return file
    } catch (e) {
        onError(`gagal download ${what}: ${(e as Error).message}`)
        return null
    }
}
