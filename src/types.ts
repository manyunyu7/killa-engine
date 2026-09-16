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
    /** When this session id was first seen, so a flush can tell "how much happened here". */
    startedAt: number
    /** User turns run against this session id. */
    turns: number
    /** Enough to rebuild the workspace and OS user for a flush after the chat went quiet. */
    chat: { account: string; jid: string; number: string }
}

export interface AgentResult {
    reply: string
    sessionId: string | null
    /** Agent loop iterations reported by the CLI — 1 means it answered without a single tool call. */
    turns?: number
}

export interface AgentRun {
    /** OS user to run the agent as, via the sudo bridge. Null = this user. */
    runAs?: string | null
    /** Extra env for this run only — how an elevated credential reaches the agent. */
    extraEnv?: Record<string, string>
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

/**
 * One group the engine is allowed to answer in. Groups are opt-in by JID and
 * silent unless called by name; `runAs` hands the agent to another OS user so
 * a group cannot reach the owner's private workspace.
 */
export interface GroupRoute {
    name: string
    jid: string
    workspaceDir: string
    trigger: string | null
    runAs: string | null
    /** Numbers in this group allowed to reach the wider credential. */
    elevated: string[]
    /** Credential handed to the agent only for an elevated sender. Never on disk. */
    elevatedEnv: Record<string, string>
}

export interface Config {
    root: string
    accounts: string[]
    ownerNumbers: string[]
    /** Default workspace; per-account overrides live in `perAccount`. */
    workspaceDir: string
    /** Root the engine keeps managed workspaces in. */
    workspacesDir: string
    /** Group routes, by JID. Empty = the engine ignores every group. */
    groups: GroupRoute[]
    /** Number (digits only) -> workspace, overriding the account's, for DMs. */
    contactWorkspaces: Record<string, string>
    perAccount: Record<string, {
        workspaceDir?: string
        ownerNumbers?: string[]
        contactWorkspaces?: Record<string, string>
    }>
    sessionDir: string
    stateDir: string
    mediaDir: string
    sessionIdleMs: number
    /** Model for the end-of-session memory flush; null disables the flush. */
    flushModel: string | null
    /** A session with fewer user turns than this is not worth a flush run. */
    flushMinTurns: number
    agentTimeoutMs: number
    reminderTickMs: number
    remindersMaxPerDay: number
    timezone: string | null
    telegram: { token: string; chat: string } | null
}

export type Logger = (account: string, message: string) => void
