/**
 * Environment -> typed config, as a pure function so tests can build any
 * scenario without touching process.env or the disk.
 *
 * Validation returns problems rather than calling process.exit: the CLI
 * decides to die, the test decides to assert.
 */

import os from 'node:os'
import path from 'node:path'
import type { Config, GroupRoute } from './types.ts'

/**
 * Workspaces live in one place the engine owns, so "where do I put it" is
 * never a question and a second one is just another folder next to the first.
 * Overridable with WORKSPACES_DIR; an absolute WORKSPACE_DIR still wins, so
 * installs that predate this convention keep working untouched.
 */
export const DEFAULT_WORKSPACES_DIR = path.join('.killa', 'workspaces')

/** A workspace name must be one path segment — it becomes a directory. */
export const isWorkspaceName = (v: string): boolean => /^[a-zA-Z0-9._-]+$/.test(v) && v !== '.' && v !== '..'

/**
 * Resolve a workspace reference: a bare name lands under the workspaces root,
 * anything path-like is used as given (after ~ expansion).
 */
export function resolveWorkspace(ref: string, workspacesDir: string, home: string): string {
    const value = ref.trim()
    if (!value) return ''
    if (value.startsWith('~')) return path.resolve(value.replace(/^~(?=$|\/)/, home))
    if (isWorkspaceName(value)) return path.join(workspacesDir, value)
    return path.resolve(value)
}

export interface ParsedConfig {
    config: Config
    /** Fatal problems, in the order they should be reported. */
    errors: string[]
}

const num = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)

/**
 * "628xxx:mybabygurll, 628yyy:kerja" -> { "628xxx": "/abs/path", ... }.
 *
 * Workspace is otherwise a property of the *account* — the number the bot logs
 * in as. This is the escape hatch for the common case of one bot number and
 * several people DMing it: without it, adding someone to OWNER_NUMBERS hands
 * them your MEMORY.md. Malformed entries are reported, not silently dropped —
 * a typo here would quietly route someone into the wrong persona.
 */
function parseContactMap(raw: string | undefined, workspacesDir: string, home: string,
                         problems: string[], label: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const entry of list(raw)) {
        const cut = entry.lastIndexOf(':')
        const number = (cut < 0 ? '' : entry.slice(0, cut)).replace(/\D/g, '')
        const ref = cut < 0 ? '' : entry.slice(cut + 1).trim()
        if (!number || !ref) {
            problems.push(`${label} tidak valid: "${entry}" — formatnya <nomor>:<workspace>.`)
            continue
        }
        out[number] = resolveWorkspace(ref, workspacesDir, home)
    }
    return out
}

/** Per-account overrides: WORKSPACE_KERJA / OWNER_NUMBERS_KERJA. */
const forAccount = (env: NodeJS.ProcessEnv, key: string, account: string) =>
    env[`${key}_${account.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]

export function parseConfig(env: NodeJS.ProcessEnv, root: string,
                            exists: (p: string) => boolean = () => true,
                            home: string = os.homedir()): ParsedConfig {
    const stateDir = env.STATE_DIR || path.join(root, 'state')
    const ownerNumbers = list(env.OWNER_NUMBERS).map(s => s.replace(/\D/g, '')).filter(Boolean)
    const workspacesDir = env.WORKSPACES_DIR
        ? path.resolve(env.WORKSPACES_DIR.replace(/^~(?=$|\/)/, home))
        : path.join(home, DEFAULT_WORKSPACES_DIR)

    // WORKSPACE_DIR (explicit path) beats WORKSPACE (managed name).
    const workspaceDir = env.WORKSPACE_DIR
        ? resolveWorkspace(env.WORKSPACE_DIR, workspacesDir, home)
        : env.WORKSPACE ? resolveWorkspace(env.WORKSPACE, workspacesDir, home) : ''

    const accounts = list(env.ACCOUNTS).length ? list(env.ACCOUNTS) : ['main']

    const errors: string[] = []
    const contactWorkspaces = parseContactMap(env.CONTACT_WORKSPACES, workspacesDir, home,
                                              errors, 'CONTACT_WORKSPACES')

    // GROUPS names the routes; each one is configured by suffix, the same way
    // accounts are. Adding the next group is three lines of env, no code.
    const groups: GroupRoute[] = []
    for (const name of list(env.GROUPS)) {
        const key = (k: string) => env[`${k}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
        const ws = key('GROUP_WORKSPACE') ?? ''
        groups.push({
            name,
            jid: (key('GROUP_JID') ?? '').trim(),
            workspaceDir: ws ? resolveWorkspace(ws, workspacesDir, home) : '',
            trigger: (key('GROUP_TRIGGER') ?? '').trim().toLowerCase() || null,
            runAs: (key('GROUP_RUNAS') ?? '').trim() || null,
            elevated: list(key('GROUP_ELEVATED')).map(v => v.replace(/\D/g, '')).filter(Boolean),
            elevatedEnv: key('GROUP_ELEVATED_DBUSER')
                ? { KILLA_DB_USER: key('GROUP_ELEVATED_DBUSER')!, KILLA_DB_PASS: key('GROUP_ELEVATED_DBPASS') ?? '' }
                : {},
        })
    }

    // One process can serve several numbers with different personas: each
    // account may name its own workspace and its own owners.
    const perAccount: Config['perAccount'] = {}
    for (const account of accounts) {
        const ws = forAccount(env, 'WORKSPACE', account) ?? forAccount(env, 'WORKSPACE_DIR', account)
        const owners = forAccount(env, 'OWNER_NUMBERS', account)
        const contacts = forAccount(env, 'CONTACT_WORKSPACES', account)
        if (!ws && !owners && !contacts) continue
        perAccount[account] = {
            ...(ws ? { workspaceDir: resolveWorkspace(ws, workspacesDir, home) } : {}),
            ...(owners ? { ownerNumbers: list(owners).map(s => s.replace(/\D/g, '')).filter(Boolean) } : {}),
            ...(contacts ? { contactWorkspaces: parseContactMap(contacts, workspacesDir, home,
                                                                errors, `CONTACT_WORKSPACES_${account}`) } : {}),
        }
    }

    const config: Config = {
        root,
        accounts,
        ownerNumbers,
        workspaceDir,
        workspacesDir,
        groups,
        contactWorkspaces,
        perAccount,
        sessionDir: env.SESSION_DIR || path.join(root, 'sessions'),
        stateDir,
        mediaDir: path.join(stateDir, 'media'),
        sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 180) * 60_000,
        // The flush is the one extra run the engine adds per conversation, so
        // it defaults to the cheapest model: it only has to write down what
        // the session already knows.
        flushModel: (env.MEMORY_FLUSH_MODEL ?? 'haiku').trim().toLowerCase() === 'off'
            ? null : (env.MEMORY_FLUSH_MODEL ?? 'haiku').trim(),
        flushMinTurns: num(env.MEMORY_FLUSH_MIN_TURNS, 4),
        agentTimeoutMs: num(env.AGENT_TIMEOUT_SECONDS, 300) * 1000,
        reminderTickMs: num(env.REMINDER_TICK_SECONDS, 30) * 1000,
        remindersMaxPerDay: num(env.REMINDERS_MAX_PER_DAY, 20),
        timezone: env.TIMEZONE || null,
        telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
            ? { token: env.TELEGRAM_BOT_TOKEN, chat: env.TELEGRAM_CHAT_ID }
            : null,
    }

    if (!workspaceDir) errors.push('WORKSPACE wajib diisi (nama workspace, atau WORKSPACE_DIR untuk path penuh).')
    else if (!exists(workspaceDir)) errors.push(`workspace tidak ditemukan: ${workspaceDir}`)
    for (const [account, over] of Object.entries(perAccount)) {
        if (over.workspaceDir && !exists(over.workspaceDir)) {
            errors.push(`workspace akun ${account} tidak ditemukan: ${over.workspaceDir}`)
        }
    }
    for (const g of groups) {
        if (!g.jid.endsWith('@g.us')) errors.push(`GROUP_JID_${g.name.toUpperCase()} harus berakhiran @g.us: ${g.jid || '(kosong)'}`)
        if (!g.trigger) errors.push(`GROUP_TRIGGER_${g.name.toUpperCase()} wajib — tanpa itu agent nyaut tiap pesan grup.`)
        if (!g.workspaceDir) errors.push(`GROUP_WORKSPACE_${g.name.toUpperCase()} wajib.`)
        if (g.elevated.length && !Object.keys(g.elevatedEnv).length) {
            errors.push(`GROUP_ELEVATED_${g.name.toUpperCase()} diisi tapi GROUP_ELEVATED_DBUSER_${g.name.toUpperCase()} kosong — tidak ada yang bisa dielevasi.`)
        }
        // A runAs workspace lives in the other user's home, which this process
        // deliberately cannot stat — so only check what we can actually see.
        else if (!g.runAs && !exists(g.workspaceDir)) errors.push(`workspace grup ${g.name} tidak ditemukan: ${g.workspaceDir}`)
    }
    const contactMaps: [string, Record<string, string>][] = [['', contactWorkspaces],
        ...Object.entries(perAccount).map(([a, o]) =>
            [a, o.contactWorkspaces ?? {}] as [string, Record<string, string>])]
    for (const [account, map] of contactMaps) {
        for (const [number, dir] of Object.entries(map)) {
            if (!exists(dir)) {
                errors.push(`workspace kontak ${number}${account ? ` (akun ${account})` : ''} tidak ditemukan: ${dir}`)
            }
        }
    }
    if (!ownerNumbers.length && !Object.values(perAccount).some(a => a.ownerNumbers?.length)) {
        errors.push('OWNER_NUMBERS wajib diisi — tanpa ini semua pesan diabaikan.')
    }

    return { config, errors }
}

/** The group route for a chat, or null when the chat is not a routed group. */
export function routeForChat(config: Config, jid: string): GroupRoute | null {
    return config.groups.find(g => g.jid === jid) ?? null
}

/** The workspace, owner list and contact routing that apply to one account. */
export function forAccountConfig(config: Config, account: string):
        { workspaceDir: string; ownerNumbers: string[]; contactWorkspaces: Record<string, string> } {
    const over = config.perAccount[account]
    const contacts = over?.contactWorkspaces
    return {
        workspaceDir: over?.workspaceDir || config.workspaceDir,
        ownerNumbers: over?.ownerNumbers?.length ? over.ownerNumbers : config.ownerNumbers,
        // Per-account map replaces the global one, the way ownerNumbers does.
        contactWorkspaces: contacts && Object.keys(contacts).length ? contacts : config.contactWorkspaces,
    }
}

/**
 * The workspace a DM runs in: the contact's own if mapped, else the account's.
 * Group chats never reach this — `routeForChat` decides those first.
 */
export function workspaceFor(config: Config, account: string, number: string): string {
    const { workspaceDir, contactWorkspaces } = forAccountConfig(config, account)
    return contactWorkspaces[number.replace(/\D/g, '')] || workspaceDir
}

/** Where a chat's agent runs: a routed group brings its own workspace and OS user. */
export function targetFor(config: Config, chat: { account: string; jid: string; number: string }):
        { workspace: string; runAs: string | null } {
    const route = routeForChat(config, chat.jid)
    return {
        workspace: route?.workspaceDir ?? workspaceFor(config, chat.account, chat.number),
        runAs: route?.runAs ?? null,
    }
}
