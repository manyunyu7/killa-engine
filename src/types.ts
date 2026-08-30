/** Shared domain types. Kept free of Baileys and fs so tests can build them. */

export type Rule =
    | { kind: 'once'; at: number }
    | { kind: 'every'; ms: number }
    | { kind: 'daily'; hh: number; mm: number }
    | { kind: 'weekly'; dow: number; hh: number; mm: number }

export interface Reminder {
    id: number
    spec: string
    rule: Rule
    text: string
    /** Owner number, digits only — the authorization key, re-checked on send. */
    number: string
    account: string
    jid: string
    nextAt: number
    sentToday: number
    dayStamp: string
}

export interface NewReminder {
    spec: string
    text: string
    number: string
    account: string
    jid: string
}

export interface ChatSession {
    sessionId: string
    lastAt: number
}

export interface AgentResult {
    reply: string
    sessionId: string | null
}

export interface AgentRun {
    text: string
    sessionId: string | null
    workspace: string
    timeoutMs: number
    model?: string | undefined
}

export interface ProbeResult {
    ok: boolean
    message: string
}

export interface Config {
    root: string
    accounts: string[]
    ownerNumbers: string[]
    /** Default workspace; per-account overrides live in `perAccount`. */
    workspaceDir: string
    /** Root the engine keeps managed workspaces in. */
    workspacesDir: string
    perAccount: Record<string, { workspaceDir?: string; ownerNumbers?: string[] }>
    sessionDir: string
    stateDir: string
    mediaDir: string
    sessionIdleMs: number
    agentTimeoutMs: number
    reminderTickMs: number
    remindersMaxPerDay: number
    timezone: string | null
    telegram: { token: string; chat: string } | null
}

export type Logger = (account: string, message: string) => void
