/**
 * Ports: everything the dispatcher needs from the outside world, as plain
 * interfaces. The Baileys socket, the claude CLI and the filesystem all enter
 * through here — which is what lets the whole message flow be tested with
 * fakes and no network, no child process, no disk.
 */

import type { AgentResult, AgentRun, Config, ProbeResult, Reminder } from '../types.ts'
import type { ModelStore } from '../store/models.ts'
import type { ReminderStore } from '../store/reminders.ts'
import type { SessionStore } from '../store/sessions.ts'
import type { TranscriptStore } from '../store/transcript.ts'
import type { Queue } from './queue.ts'

/** One conversation, already resolved to an owner. */
export interface Chat {
    account: string
    /** Owner number, digits only. */
    number: string
    jid: string
    sendText(text: string): Promise<void>
    sendImage(file: string): Promise<void>
    /** Send a file as a document (docx, pdf, xlsx, …), keeping its filename. */
    sendDocument(file: string): Promise<void>
    presence(state: 'composing' | 'paused'): Promise<void>
}

export interface Incoming {
    text: string
    /** True when the message carried a file, even if the download failed. */
    hasFile: boolean
    /** The downloaded attachment, or null when there was none (or it failed). */
    file: { path: string; kind: 'image' | 'document'; name: string } | null
}

export interface Deps {
    config: Config
    sessions: SessionStore
    transcripts: TranscriptStore
    models: ModelStore
    reminders: ReminderStore
    queue: Queue
    modelAliases: string[]
    runAgent(run: AgentRun): Promise<AgentResult>
    probeModel(model: string, workspace: string): Promise<ProbeResult>
    fileExists(file: string): boolean
    /** True if any markdown under the workspace changed after `since` — the agent already wrote memory. */
    memoryTouchedSince(workspace: string, since: number): boolean
    now(): number
    log(account: string, message: string): void
}

export type { Reminder }
