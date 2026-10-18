/**
 * The block that tells the agent about remembered notices on the owner's next
 * turn. Filing them is http/notify.ts; the store is store/notices.ts.
 */

import { stampShort } from './time.ts'
import type { Notice } from '../store/notices.ts'

/** The context block in front of the owner's message; empty when nothing is pending. */
export function noticeBlock(notes: Notice[]): string {
    if (!notes.length) return ''
    const lines = notes.map(n => `- ${stampShort(n.at)} · ${n.text}${n.ref ? ` (ref ${n.ref})` : ''}`)
    return '[Konteks — notifikasi yang Killa kirim sejak obrolan terakhir (bukan pesan dari pengguna):\n'
        + `${lines.join('\n')}]`
}
