/**
 * Media over the HTTP channel, in both directions.
 *
 * In: base64 attachments on POST /v1/chat, checked against a mime allowlist
 * and a size cap, then saved to STATE_DIR/media exactly as WhatsApp media is
 * — so the agent is handed a path the same way, whichever door it came in.
 *
 * Out: GET /v1/media streams a file the agent produced, but only from inside
 * an allowed root (the HTTP and owner workspaces, the media dir), fenced the
 * same way workspace reads are: lexically, then through realpath.
 */

import fs from 'node:fs'
import path from 'node:path'
import { forAccountConfig, workspaceFor } from '../config.ts'
import { mimeFor } from '../core/files.ts'
import type { IncomingFile } from '../core/ports.ts'
import type { Config, HttpConfig } from '../types.ts'
import { isHidden, WorkspaceError } from './workspace.ts'

export const MAX_MEDIA_ITEMS = 3
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024
export const MAX_SERVE_BYTES = 15 * 1024 * 1024
/** The chat body must fit MAX_MEDIA_ITEMS base64 payloads plus the message. */
export const MAX_CHAT_BODY_BYTES = MAX_MEDIA_ITEMS * Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 1024 * 1024

/** Allowed inbound types -> how the agent is told about them, and the extension saved with. */
const ALLOWED: Record<string, { kind: IncomingFile['kind']; ext: string }> = {
    'image/png': { kind: 'image', ext: 'png' },
    'image/jpeg': { kind: 'image', ext: 'jpeg' },
    'image/gif': { kind: 'image', ext: 'gif' },
    'image/webp': { kind: 'image', ext: 'webp' },
    'application/pdf': { kind: 'document', ext: 'pdf' },
    'text/plain': { kind: 'document', ext: 'txt' },
    'text/markdown': { kind: 'document', ext: 'md' },
    'text/csv': { kind: 'document', ext: 'csv' },
    'audio/mpeg': { kind: 'audio', ext: 'mp3' },
    'audio/mp4': { kind: 'audio', ext: 'm4a' },
    'audio/x-m4a': { kind: 'audio', ext: 'm4a' },
    'audio/aac': { kind: 'audio', ext: 'aac' },
    'audio/ogg': { kind: 'audio', ext: 'ogg' },
    'audio/opus': { kind: 'audio', ext: 'opus' },
    'audio/wav': { kind: 'audio', ext: 'wav' },
    'audio/x-wav': { kind: 'audio', ext: 'wav' },
    'audio/webm': { kind: 'audio', ext: 'webm' },
}

export const ALLOWED_MIME_TYPES = Object.keys(ALLOWED)

export interface MediaItem {
    name: string
    mimeType: string
    kind: IncomingFile['kind']
    ext: string
    data: Buffer
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Keep the sender's filename but never let it escape the media dir. */
export function safeName(name: string): string {
    const base = path.basename(name.replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').trim()
    return base && base !== '.' && base !== '..' ? base.slice(0, 120) : 'dokumen'
}

/**
 * Validate the `media` field of a chat body. Absent -> []. Throws 400 for a
 * malformed item, 413 over the count or size cap, 415 for a type outside the
 * allowlist. Nothing is written until every item has passed.
 */
export function parseMedia(v: unknown): MediaItem[] {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) throw new WorkspaceError(400, 'media harus array')
    if (v.length > MAX_MEDIA_ITEMS) throw new WorkspaceError(413, `media maksimal ${MAX_MEDIA_ITEMS} item`)
    return v.map((item: unknown, i) => {
        const { name, mimeType, dataBase64 } = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        if (typeof mimeType !== 'string' || typeof dataBase64 !== 'string') {
            throw new WorkspaceError(400, `media[${i}]: mimeType dan dataBase64 wajib`)
        }
        if (name !== undefined && typeof name !== 'string') throw new WorkspaceError(400, `media[${i}]: name harus string`)
        const mime = mimeType.split(';')[0]!.trim().toLowerCase()
        const allowed = ALLOWED[mime]
        if (!allowed) throw new WorkspaceError(415, `media[${i}]: tipe ${mime || '(kosong)'} tidak didukung`)
        const b64 = dataBase64.replace(/\s+/g, '')
        // Check the size before decoding, so an oversized item costs nothing.
        if (Math.floor(b64.length * 3 / 4) - (b64.match(/=+$/)?.[0].length ?? 0) > MAX_MEDIA_BYTES) {
            throw new WorkspaceError(413, `media[${i}]: lebih dari ${MAX_MEDIA_BYTES} byte`)
        }
        if (!b64 || b64.length % 4 !== 0 || !BASE64.test(b64)) {
            throw new WorkspaceError(400, `media[${i}]: dataBase64 tidak valid`)
        }
        return { name: safeName(name || `lampiran.${allowed.ext}`), mimeType: mime, ...allowed,
                 data: Buffer.from(b64, 'base64') }
    })
}

/**
 * Write validated items to the media dir, named the way WhatsApp media is
 * (`in-<ms>…`), with an index so several in one request cannot collide.
 */
export function saveMedia(items: MediaItem[], mediaDir: string, now: () => number = Date.now): IncomingFile[] {
    if (!items.length) return []
    fs.mkdirSync(mediaDir, { recursive: true })
    const stamp = now()
    return items.map((item, i) => {
        const file = path.join(mediaDir, item.kind === 'image'
            ? `in-${stamp}-${i}.${item.ext}`
            : `in-${stamp}-${i}-${item.name}`)
        fs.writeFileSync(file, item.data)
        return { path: file, kind: item.kind, name: item.name }
    })
}

/**
 * Where GET /v1/media may read from: the HTTP workspace, every workspace an
 * owner of HTTP_ACCOUNT chats in (a `wa:` chat runs there), and the media dir.
 */
export function mediaRoots(config: Config, http: HttpConfig): string[] {
    const owners = forAccountConfig(config, http.account).ownerNumbers
    return [...new Set([http.workspaceDir, ...owners.map(n => workspaceFor(config, http.account, n)),
                        config.mediaDir].filter(Boolean))]
}

const realOrNull = (p: string): string | null => {
    try { return fs.realpathSync(p) } catch { return null }
}

/**
 * A caller-supplied path -> the real file to serve. Absolute paths (as
 * `attachments` returns them) must sit inside one of `roots`; a relative one
 * is taken relative to the first root. Hidden segments (.git, .env*,
 * node_modules) are refused wherever they appear, before and after realpath.
 */
export function resolveMedia(roots: string[], p: string): { file: string; size: number } {
    const raw = String(p ?? '').replace(/\\/g, '/')
    const refuse = () => new WorkspaceError(400, 'path di luar folder yang diizinkan')
    if (!raw || raw.includes('\0') || raw.split('/').some(seg => seg === '..' || isHidden(seg.toLowerCase()))) {
        throw refuse()
    }
    const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0] ?? '/', raw)
    const within = (root: string, target: string) => {
        const rel = path.relative(root, target)
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    }
    if (!roots.some(r => within(path.resolve(r), full))) throw refuse()
    const real = realOrNull(full)
    if (!real) throw new WorkspaceError(404, 'tidak ditemukan')
    const inside = roots.some(r => {
        const realRoot = realOrNull(r)
        return !!realRoot && within(realRoot, real)
            && !path.relative(realRoot, real).split(path.sep).some(seg => isHidden(seg.toLowerCase()))
    })
    if (!inside) throw refuse()
    const st = fs.statSync(real)
    if (!st.isFile()) throw new WorkspaceError(400, 'bukan file')
    if (st.size > MAX_SERVE_BYTES) throw new WorkspaceError(413, `file lebih dari ${MAX_SERVE_BYTES} byte`)
    return { file: real, size: st.size }
}

/** Content type for a served file: the known table, else octet-stream. */
export const contentTypeFor = (file: string): string => {
    const t = mimeFor(file)
    return t.startsWith('text/') ? `${t}; charset=utf-8` : t
}
