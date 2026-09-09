/**
 * `npm run workspace [list|new <name>|path <name>]`
 *
 * Workspaces are engine-managed: they live under one root, so creating a
 * second one is naming it, not deciding where it goes.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseConfig, forAccountConfig, isWorkspaceName } from '../config.ts'
import { scaffoldWorkspace, type Persona } from './workspace.ts'
import 'dotenv/config'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const ask = (q: string, def: string): Promise<string> => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${q} [${def}] `, a => { rl.close(); resolve(a.trim() || def) })
})

// exists:() => true — we want the configured paths even when they are missing,
// so `list` can show what is broken instead of refusing to run.
const { config } = parseConfig(process.env, ROOT, () => true)

/** Which accounts (or mapped contacts) point at a given directory. */
function usedBy(dir: string): string[] {
    const users: string[] = []
    for (const a of config.accounts) {
        const { workspaceDir, contactWorkspaces } = forAccountConfig(config, a)
        if (workspaceDir === dir) users.push(a)
        for (const [number, d] of Object.entries(contactWorkspaces)) {
            if (d === dir) users.push(`${a}/${number}`)
        }
    }
    return users
}

/** Every directory some account or mapped contact is pointed at. */
function configuredDirs(): string[] {
    return config.accounts.flatMap(a => {
        const { workspaceDir, contactWorkspaces } = forAccountConfig(config, a)
        return [workspaceDir, ...Object.values(contactWorkspaces)]
    }).filter(Boolean)
}

function list(): void {
    const root = config.workspacesDir
    const managed = fs.existsSync(root)
        ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name))
        : []
    // A workspace configured by absolute path lives outside the root but is
    // just as real — show it, or `list` lies about what is running.
    const configured = configuredDirs()
    const all = [...new Set([...managed, ...configured])].sort()

    console.log(`\n📁 workspaces root: ${root}\n`)
    if (!all.length) {
        console.log('   (belum ada — bikin: npm run workspace new <nama>)\n')
        return
    }

    for (const dir of all) {
        const accounts = usedBy(dir)
        const outside = !dir.startsWith(root + path.sep)
        const missing = !fs.existsSync(dir)
        const tags = [
            accounts.length ? `dipakai: ${accounts.join(', ')}` : 'tidak dipakai',
            outside ? 'di luar root' : '',
            missing ? '⚠️ tidak ada' : '',
        ].filter(Boolean)
        console.log(`   ${path.basename(dir).padEnd(20)} ${tags.join(' · ')}`)
        if (outside || missing) console.log(`   ${''.padEnd(20)} ${dir}`)
    }
    console.log()
}

async function create(name: string | undefined): Promise<void> {
    if (!name || !isWorkspaceName(name)) {
        console.error('❌ butuh nama yang valid: huruf, angka, titik, - atau _  (mis. npm run workspace new kerja)')
        process.exit(1)
    }
    const dir = path.join(config.workspacesDir, name)
    if (fs.existsSync(dir)) {
        console.log(`ℹ️  ${dir} sudah ada — file yang ada tidak akan ditimpa.`)
    }

    const persona: Persona = {
        agentName: await ask('Agent name:', name),
        ownerName: await ask('What should the agent call you?', 'Boss'),
        language: await ask('Reply language:', 'the same language the user writes in'),
    }
    console.log()
    scaffoldWorkspace(dir, persona)

    console.log(`\n✅ ${dir}`)
    console.log(`   Pakai sebagai workspace utama:   WORKSPACE=${name}`)
    console.log(`   Atau untuk satu akun saja:       WORKSPACE_<AKUN>=${name}`)
    console.log('   Lalu restart engine-nya.\n')
}

const [cmd, arg] = process.argv.slice(2)

if (!cmd || cmd === 'list') list()
else if (cmd === 'new') await create(arg)
else if (cmd === 'path') {
    if (!arg || !isWorkspaceName(arg)) { console.error('❌ butuh nama workspace'); process.exit(1) }
    console.log(path.join(config.workspacesDir, arg))
} else {
    console.error('usage: npm run workspace [list | new <nama> | path <nama>]')
    process.exit(1)
}
