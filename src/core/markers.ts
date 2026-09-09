/**
 * Marker parsing — the agent's only structured channel back to the engine.
 *
 * The agent writes plain chat text; anything in [[...]] is an instruction to
 * the engine, stripped before the text reaches the user. Pure by design: no
 * fs, no clock, no sending — just text in, intent out.
 */

export const SEND_MARKER = /\[\[send:([^\]]+)\]\]/g
export const REMIND_MARKER = /\[\[remind:([^\]|]+)\|([^\]]*)\]\]/g

/** WhatsApp rejects very long bodies; split well under the limit. */
export const CHUNK_SIZE = 3500

export interface ParsedReply {
    text: string
    /** Paths from [[send:]] — images and documents alike; the sender sorts them out. */
    files: string[]
    reminders: { spec: string; text: string }[]
}

export function parseReply(reply: string): ParsedReply {
    const files: string[] = []
    const reminders: { spec: string; text: string }[] = []

    const text = String(reply ?? '')
        .replace(SEND_MARKER, (_m, p: string) => { files.push(p.trim()); return '' })
        .replace(REMIND_MARKER, (_m, spec: string, body: string) => {
            reminders.push({ spec: spec.trim(), text: body.trim() })
            return ''
        })
        .replace(/\n{3,}/g, '\n\n')
        .trim()

    return { text, files, reminders }
}

export function chunk(text: string, size: number = CHUNK_SIZE): string[] {
    if (!text) return []
    return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []
}
