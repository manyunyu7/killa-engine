/**
 * Environment -> typed config, as a pure function so tests can build any
 * scenario without touching process.env or the disk.
 *
 * Validation returns problems rather than calling process.exit: the CLI
 * decides to die, the test decides to assert.
 */

import os from 'node:os'
import path from 'node:path'
import type { Config } from './types.ts'

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

    // One process can serve several numbers with different personas: each
    // account may name its own workspace and its own owners.
    const perAccount: Config['perAccount'] = {}
    for (const account of accounts) {
        const ws = forAccount(env, 'WORKSPACE', account) ?? forAccount(env, 'WORKSPACE_DIR', account)
        const owners = forAccount(env, 'OWNER_NUMBERS', account)
        if (!ws && !owners) continue
        perAccount[account] = {
            ...(ws ? { workspaceDir: resolveWorkspace(ws, workspacesDir, home) } : {}),
            ...(owners ? { ownerNumbers: list(owners).map(s => s.replace(/\D/g, '')).filter(Boolean) } : {}),
        }
    }

    const config: Config = {
        root,
        accounts,
        ownerNumbers,
        workspaceDir,
        workspacesDir,
        perAccount,
        sessionDir: env.SESSION_DIR || path.join(root, 'sessions'),
        stateDir,
        mediaDir: path.join(stateDir, 'media'),
        sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 30) * 60_000,
        agentTimeoutMs: num(env.AGENT_TIMEOUT_SECONDS, 300) * 1000,
        reminderTickMs: num(env.REMINDER_TICK_SECONDS, 30) * 1000,
        remindersMaxPerDay: num(env.REMINDERS_MAX_PER_DAY, 20),
        timezone: env.TIMEZONE || null,
        telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
            ? { token: env.TELEGRAM_BOT_TOKEN, chat: env.TELEGRAM_CHAT_ID }
            : null,
    }

    const errors: string[] = []
    if (!workspaceDir) errors.push('WORKSPACE wajib diisi (nama workspace, atau WORKSPACE_DIR untuk path penuh).')
    else if (!exists(workspaceDir)) errors.push(`workspace tidak ditemukan: ${workspaceDir}`)
    for (const [account, over] of Object.entries(perAccount)) {
        if (over.workspaceDir && !exists(over.workspaceDir)) {
            errors.push(`workspace akun ${account} tidak ditemukan: ${over.workspaceDir}`)
        }
    }
    if (!ownerNumbers.length && !Object.values(perAccount).some(a => a.ownerNumbers?.length)) {
        errors.push('OWNER_NUMBERS wajib diisi — tanpa ini semua pesan diabaikan.')
    }

    return { config, errors }
}

/** The workspace and owner list that apply to one account. */
export function forAccountConfig(config: Config, account: string): { workspaceDir: string; ownerNumbers: string[] } {
    const over = config.perAccount[account]
    return {
        workspaceDir: over?.workspaceDir || config.workspaceDir,
        ownerNumbers: over?.ownerNumbers?.length ? over.ownerNumbers : config.ownerNumbers,
    }
}
