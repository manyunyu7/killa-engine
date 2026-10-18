/**
 * Pending notices: what /v1/notify sent the owner with `remember: true`,
 * waiting to be told to the agent on the owner's next turn in that chat.
 *
 * The send itself runs no agent, so without this the agent would not know
 * what "itu" refers to when the owner replies to an alert. Kept small and
 * short-lived on purpose: a note nobody followed up on within a week, or
 * past the twentieth, is not context any more.
 */

import type { JsonFile } from './json-file.ts'

export interface Notice {
    id: number
    at: number
    text: string
    ref?: string
}

export interface NoticeFile {
    seq: number
    chats: Record<string, Notice[]>
}

export interface NoticeStore {
    add(key: string, text: string, ref?: string): Notice
    /** Unexpired notes for a chat, oldest first. Does not remove them. */
    pending(key: string): Notice[]
    /** Remove exactly these notes (by id) — ones added meanwhile stay. */
    drop(key: string, ids: number[]): void
    clear(key: string): void
}

export const MAX_NOTICES = 20
export const NOTICE_TTL_MS = 7 * 24 * 60 * 60_000
export const MAX_NOTICE_CHARS = 1000

export function createNoticeStore(file: JsonFile<NoticeFile>, now: () => number = Date.now): NoticeStore {
    const data = file.read()
    data.chats ??= {}
    data.seq ??= 0
    const fresh = (key: string): Notice[] => (data.chats[key] ?? []).filter(n => n.at > now() - NOTICE_TTL_MS)
    const save = (key: string, list: Notice[]) => {
        if (list.length) data.chats[key] = list
        else delete data.chats[key]
        file.write(data)
    }
    return {
        add(key, text, ref) {
            const clean = text.trim()
            const note: Notice = {
                id: ++data.seq,
                at: now(),
                text: clean.length > MAX_NOTICE_CHARS ? `${clean.slice(0, MAX_NOTICE_CHARS - 1)}…` : clean,
                ...(ref ? { ref } : {}),
            }
            save(key, [...fresh(key), note].slice(-MAX_NOTICES))
            return note
        },
        pending: fresh,
        drop(key, ids) {
            if (!data.chats[key]) return
            save(key, fresh(key).filter(n => !ids.includes(n.id)))
        },
        clear(key) {
            if (data.chats[key]) save(key, [])
        },
    }
}
