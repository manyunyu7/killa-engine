/** Fakes shared across tests: no disk, no sockets, no child processes. */

import { vi } from 'vitest'
import type { JsonFile } from '../src/store/json-file.ts'
import type { Chat, Deps } from '../src/core/ports.ts'
import type { Config } from '../src/types.ts'
import { createQueue } from '../src/core/queue.ts'
import { createSessionStore } from '../src/store/sessions.ts'
import { createModelStore } from '../src/store/models.ts'
import { createReminderStore, type ReminderFile } from '../src/store/reminders.ts'

/** In-memory JsonFile: same contract as the real one, no fs. */
export function memFile<T>(initial: T, name = 'mem.json'): JsonFile<T> & { writes: number } {
    let value = initial
    const f = {
        path: name,
        writes: 0,
        read: () => value,
        write(v: T) { value = structuredClone(v); f.writes++ },
    }
    return f
}

export const testConfig = (over: Partial<Config> = {}): Config => ({
    root: '/root',
    accounts: ['main'],
    ownerNumbers: ['628111'],
    workspaceDir: '/ws',
    workspacesDir: '/home/killa/.killa/workspaces',
    groups: [],
    contactWorkspaces: {},
    perAccount: {},
    sessionDir: '/root/sessions',
    stateDir: '/root/state',
    mediaDir: '/root/state/media',
    sessionIdleMs: 30 * 60_000,
    agentTimeoutMs: 300_000,
    reminderTickMs: 30_000,
    remindersMaxPerDay: 20,
    timezone: 'Asia/Jakarta',
    telegram: null,
    ...over,
})

export interface FakeChat extends Chat {
    texts: string[]
    imagesSent: string[]
    presences: string[]
}

export function fakeChat(over: Partial<Chat> = {}): FakeChat {
    const chat: FakeChat = {
        account: 'main',
        number: '628111',
        jid: '628111@s.whatsapp.net',
        texts: [],
        imagesSent: [],
        presences: [],
        async sendText(t) { chat.texts.push(t) },
        async sendImage(f) { chat.imagesSent.push(f) },
        async presence(s) { chat.presences.push(s) },
        ...over,
    }
    return chat
}

export function makeDeps(over: Partial<Deps> = {}): Deps {
    const config = over.config ?? testConfig()
    return {
        config,
        sessions: createSessionStore(memFile<Record<string, never>>({} as never), config.sessionIdleMs),
        models: createModelStore(memFile<Record<string, string>>({})),
        reminders: createReminderStore({ file: memFile<ReminderFile>({ seq: 0, items: [] }), log: () => {} }),
        queue: createQueue(),
        modelAliases: ['opus', 'sonnet'],
        runAgent: vi.fn(async () => ({ reply: 'halo', sessionId: 'sess-1' })),
        probeModel: vi.fn(async () => ({ ok: true, message: '' })),
        fileExists: () => true,
        log: () => {},
        ...over,
    }
}

/** Wait for the dispatcher's queued turn to drain. */
export const flush = () => new Promise(r => setImmediate(r))
