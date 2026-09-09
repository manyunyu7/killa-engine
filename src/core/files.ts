/**
 * What kind of attachment a path is.
 *
 * WhatsApp treats images and documents as different message types: a .docx
 * sent as an image arrives broken, and a photo sent as a document loses its
 * preview. The agent only ever writes [[send:<path>]], so the engine decides —
 * from the extension, the one thing a path reliably tells us.
 */

import path from 'node:path'

const IMAGE: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
}

const DOCUMENT: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.zip': 'application/zip', '.json': 'application/json',
}

const ext = (file: string) => path.extname(file).toLowerCase()

export const isImageFile = (file: string): boolean => ext(file) in IMAGE

/**
 * A mimetype WhatsApp recognizes. Unknown extensions fall back to
 * octet-stream: the file still arrives, named, and the phone offers to open
 * it — better than refusing to send what the agent just spent a minute making.
 */
export const mimeFor = (file: string): string =>
    IMAGE[ext(file)] ?? DOCUMENT[ext(file)] ?? 'application/octet-stream'
