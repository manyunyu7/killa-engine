/**
 * setup.js — interactive onboarding wizard.
 *
 * `npm run setup` walks a new user from zero to a working .env and a
 * scaffolded workspace, checking the claude CLI along the way. Safe to
 * re-run: existing .env and workspace files are never overwritten.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ENV_PATH = path.join(ROOT, '.env')

// Own line queue instead of rl.question(): readline discards lines that
// arrive while no question is pending, which breaks piped/scripted input
// (printf 'a\nb\n' | npm run setup).
const rl = readline.createInterface({ input: process.stdin })
const lineQueue = []
let waiter = null
let stdinClosed = false
rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l) } else lineQueue.push(l) })
rl.on('close', () => { stdinClosed = true; if (waiter) { const w = waiter; waiter = null; w('') } })

const ask = (q, def) => {
    process.stdout.write(def ? `${q} [${def}] ` : `${q} `)
    return new Promise(resolve => {
        const give = a => resolve((a || def || '').trim())
        if (lineQueue.length) give(lineQueue.shift())
        else if (stdinClosed) give('')
        else waiter = give
    })
}

function checkClaude() {
    try {
        const v = execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        console.log(`✅ Claude Code found: ${v}`)
        return true
    } catch (e) {
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

function workspaceTemplate({ agentName, ownerName, language }) {
    return {
        'CLAUDE.md': `# ${agentName} — Standing Instructions

You are ${agentName}, ${ownerName}'s personal agent, talking over WhatsApp.

## Before every reply
- Read \`SOUL.md\` (who you are), \`USER.md\` (who you talk to), \`MEMORY.md\` (what you both know).

## WhatsApp style — IMPORTANT
- Reply in ${language}.
- Chat like a person texting: short, natural, warm.
- NO markdown: no **bold**, no bullet lists, no headers. Plain sentences only.
- One thought per message-length reply; don't write essays unless asked.

## Memory
- When you learn something worth keeping (facts about ${ownerName}, decisions,
  things to follow up), append it to \`MEMORY.md\` yourself with a date.
- Facts about ${ownerName} as a person go to \`USER.md\`.

## Images
- When the user sends an image, the message tells you its file path — read
  that file to see it.
- To send an image back, put \`[[send:/absolute/path.png]]\` on its own in
  your reply; the engine sends that file as an image and strips the marker.

## Boundaries
- This workspace is your entire world. Do not touch files outside it
  unless ${ownerName} explicitly asks.
`,
        'SOUL.md': `# SOUL.md — Who ${agentName} is

_Describe your agent's personality here: tone, quirks, how it talks,
what it cares about. This file IS the personality — edit freely._

${agentName} is helpful, direct, and has a sense of humor.
`,
        'USER.md': `# USER.md — About ${ownerName}

_Facts about the owner. The agent reads this before every reply and
appends new facts as it learns them._

- Name: ${ownerName}
`,
        'MEMORY.md': `# MEMORY.md — Shared memory

_The agent appends dated notes here. Prune it yourself when it gets long._
`,
    }
}

async function main() {
    console.log('\n🦞 killa-engine setup\n─────────────────────\n')

    const hasClaude = checkClaude()

    if (fs.existsSync(ENV_PATH)) {
        console.log('\nℹ️  .env already exists — this wizard will NOT overwrite it.')
        console.log('   Edit it by hand, or delete it and re-run setup.\n')
        rl.close()
        return
    }

    // 1. Owner number(s)
    let owner = ''
    while (!/^\d{8,15}(,\d{8,15})*$/.test(owner)) {
        owner = (await ask('Your WhatsApp number (digits only, with country code, e.g. 6281234567890):'))
            .replace(/[^\d,]/g, '')
        if (!owner) {
            if (stdinClosed) { console.error('\n❌ Nomor owner wajib — setup dibatalkan.'); process.exit(1) }
            console.log('   Required — only this number can talk to the agent.')
        }
    }

    // 2. Workspace
    const wsDefault = path.join(os.homedir(), 'killa-workspace')
    const workspace = path.resolve(await ask('Workspace folder (the agent\'s world):', wsDefault))

    // 3. Persona
    const agentName = await ask('Agent name:', 'Killa')
    const ownerName = await ask('What should the agent call you?', 'Boss')
    const language = await ask('Reply language:', 'the same language the user writes in')

    // Scaffold workspace (never overwrite)
    fs.mkdirSync(workspace, { recursive: true })
    const files = workspaceTemplate({ agentName, ownerName, language })
    for (const [name, content] of Object.entries(files)) {
        const p = path.join(workspace, name)
        if (fs.existsSync(p)) {
            console.log(`   ⏭️  ${name} exists, keeping yours`)
        } else {
            fs.writeFileSync(p, content)
            console.log(`   📄 ${name} created`)
        }
    }

    // Write .env
    fs.writeFileSync(ENV_PATH, `ACCOUNTS=main
OWNER_NUMBERS=${owner}
WORKSPACE_DIR=${workspace}
`)
    console.log(`\n✅ .env written`)
    console.log(`✅ Workspace ready: ${workspace}`)
    console.log(`   → Personality lives in ${path.join(workspace, 'SOUL.md')} — make it yours.`)

    if (!hasClaude) {
        console.log('\n⚠️  Install & log in to Claude Code before starting (see above).')
    }
    console.log(`\nNext:  npm start   — then scan the QR with the agent's WhatsApp number.`)
    console.log(`       (use a spare number, not your daily one)\n`)
    rl.close()
}

main()
