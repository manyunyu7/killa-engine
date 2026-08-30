/**
 * Interactive onboarding wizard.
 *
 * `npm run setup` walks a new user from zero to a working .env and a
 * scaffolded workspace, checking the claude CLI along the way. Safe to
 * re-run: an existing .env and existing workspace files are never overwritten.
 *
 * `npm run setup -- --workspace <path>` only scaffolds an extra workspace and
 * never touches .env — for a second persona, or a second instance.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WORKSPACES_DIR, isWorkspaceName } from '../config.ts'
import { expandHome, scaffoldWorkspace, workspaceFlag, type Persona } from './workspace.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_PATH = path.join(ROOT, '.env')

// Own line queue instead of rl.question(): readline discards lines that arrive
// while no question is pending, which breaks piped input (printf | npm run setup).
const rl = readline.createInterface({ input: process.stdin })
const lineQueue: string[] = []
let waiter: ((line: string) => void) | null = null
let stdinClosed = false

rl.on('line', (l: string) => {
    if (waiter) { const w = waiter; waiter = null; w(l) } else lineQueue.push(l)
})
rl.on('close', () => {
    stdinClosed = true
    if (waiter) { const w = waiter; waiter = null; w('') }
})

function ask(q: string, def = ''): Promise<string> {
    process.stdout.write(def ? `${q} [${def}] ` : `${q} `)
    return new Promise<string>(resolve => {
        const give = (a: string) => resolve((a || def).trim())
        if (lineQueue.length) give(lineQueue.shift()!)
        else if (stdinClosed) give('')
        else waiter = give
    })
}

function checkClaude(): boolean {
    try {
        const v = execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        console.log(`✅ Claude Code found: ${v}`)
        return true
    } catch {
        console.log(`
❌ Claude Code CLI not found on PATH.

   Install it first:  npm install -g @anthropic-ai/claude-code
   Then log in:       claude          (interactive)
   Headless server?   Run \`claude setup-token\` on a machine WITH a browser,
                      then paste the token here via \`claude\` login flow.
`)
        return false
    }
}

const askPersona = async (): Promise<Persona> => ({
    agentName: await ask('Agent name:', 'Killa'),
    ownerName: await ask('What should the agent call you?', 'Boss'),
    language: await ask('Reply language:', 'the same language the user writes in'),
})

async function scaffoldOnly(raw: string | null): Promise<void> {
    if (!raw) {
        console.error('❌ --workspace needs a path, e.g. npm run setup -- --workspace ~/killa-kerja')
        process.exit(1)
    }
    // A bare name goes in the managed root; a path is honoured as given.
    const workspace = isWorkspaceName(raw)
        ? path.join(os.homedir(), DEFAULT_WORKSPACES_DIR, raw)
        : path.resolve(expandHome(raw, os.homedir()))
    console.log(`\n🧱 scaffolding workspace: ${workspace}\n`)

    scaffoldWorkspace(workspace, await askPersona())

    console.log(`\n✅ Workspace ready: ${workspace}`)
    console.log(`   → Personality lives in ${path.join(workspace, 'SOUL.md')} — make it yours.`)
    console.log(`\nUse it as the main workspace:  WORKSPACE=${path.basename(workspace)}`)
    console.log(`Or for one account only:       WORKSPACE_<ACCOUNT>=${path.basename(workspace)}`)
    console.log('Then restart the engine.\n')
    rl.close()
}

async function main(): Promise<void> {
    const flag = workspaceFlag(process.argv.slice(2))
    if (flag !== null) return scaffoldOnly(flag)

    console.log('\n🦞 killa-engine setup\n─────────────────────\n')

    const hasClaude = checkClaude()

    if (fs.existsSync(ENV_PATH)) {
        console.log('\nℹ️  .env already exists — this wizard will NOT overwrite it.')
        console.log('   Edit it by hand, or delete it and re-run setup.')
        console.log('   Extra workspace: npm run setup -- --workspace <path>\n')
        rl.close()
        return
    }

    let owner = ''
    while (!/^\d{8,15}(,\d{8,15})*$/.test(owner)) {
        owner = (await ask('Your WhatsApp number (digits only, with country code, e.g. 6281234567890):'))
            .replace(/[^\d,]/g, '')
        if (!owner) {
            if (stdinClosed) { console.error('\n❌ Nomor owner wajib — setup dibatalkan.'); process.exit(1) }
            console.log('   Required — only this number can talk to the agent.')
        }
    }

    const name = await ask("Workspace name (the agent's world):", 'main')
    const workspace = isWorkspaceName(name)
        ? path.join(os.homedir(), DEFAULT_WORKSPACES_DIR, name)
        : path.resolve(expandHome(name, os.homedir()))
    const timezone = await ask('Your timezone (IANA name, matters for reminders):',
        Intl.DateTimeFormat().resolvedOptions().timeZone)

    scaffoldWorkspace(workspace, await askPersona())

    fs.writeFileSync(ENV_PATH, `ACCOUNTS=main
OWNER_NUMBERS=${owner}
WORKSPACE=${path.basename(workspace)}
TIMEZONE=${timezone}
`)
    console.log('\n✅ .env written')
    console.log(`✅ Workspace ready: ${workspace}`)
    console.log(`   → Personality lives in ${path.join(workspace, 'SOUL.md')} — make it yours.`)

    if (!hasClaude) console.log('\n⚠️  Install & log in to Claude Code before starting (see above).')
    console.log('\nNext:  npm start   — then scan the QR with the agent\'s WhatsApp number.')
    console.log('       (use a spare number, not your daily one)\n')
    rl.close()
}

void main()
