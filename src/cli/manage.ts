/**
 * The two things you actually do after setup.
 *
 *   npm run relink            drop WhatsApp credentials so the next start
 *                             asks for a fresh QR (i.e. change the agent's number)
 *   npm run owner -- 628xxx   rewrite OWNER_NUMBERS in .env (who may chat)
 *
 * Both are deliberately boring: no daemon control, no magic. Stop the process
 * yourself, run one of these, start it again.
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { envValue, normalizeNumbers, setEnvValue } from './env-file.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_PATH = path.join(ROOT, '.env')

function readEnv(): string {
    if (!fs.existsSync(ENV_PATH)) {
        console.error('❌ .env belum ada — jalankan `npm run setup` dulu.')
        process.exit(1)
    }
    return fs.readFileSync(ENV_PATH, 'utf8')
}

const confirm = (q: string) => new Promise<boolean>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${q} [y/N] `, (a: string) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())) })
})

// Deleting sessions/<account> is exactly what the engine does on a
// WhatsApp-side logout, so the next start falls through to the QR flow.
async function relink(args: string[]): Promise<void> {
    const src = readEnv()
    const accounts = (envValue(src, 'ACCOUNTS') || 'main').split(',').map(s => s.trim()).filter(Boolean)
    const sessionDir = envValue(src, 'SESSION_DIR') || path.join(ROOT, 'sessions')

    const yes = args.includes('--yes') || args.includes('-y')
    const named = args.filter(a => !a.startsWith('-'))
    const targets = named.length ? named : accounts

    for (const account of targets) {
        if (!accounts.includes(account)) {
            console.error(`❌ akun "${account}" tidak ada di ACCOUNTS (${accounts.join(', ')})`)
            process.exit(1)
        }
    }

    const dirs = targets.map(a => path.join(sessionDir, a))
    console.log('\n🔗 relink — akun yang akan di-reset:')
    targets.forEach((a, i) => {
        console.log(`   ${a}  ${fs.existsSync(dirs[i]!) ? `(${dirs[i]})` : '(belum pernah login)'}`)
    })
    console.log('\nSetelah ini nomor lama TIDAK lagi terhubung; `npm start` akan minta scan QR baru.')
    console.log('Hentikan dulu prosesnya (Ctrl-C / pm2 stop killa-engine) sebelum lanjut.\n')

    if (!yes && !await confirm('Hapus credential dan minta QR baru?')) {
        console.log('Dibatalkan — tidak ada yang dihapus.')
        return
    }

    targets.forEach((a, i) => {
        fs.rmSync(dirs[i]!, { recursive: true, force: true })
        console.log(`   🗑️  ${a} credential dihapus`)
        fs.rmSync(path.join(ROOT, `qr-${a}.png`), { force: true })
    })
    console.log('\n✅ Selesai. Jalankan `npm start`, lalu scan QR dengan nomor yang baru.')
    console.log('   Jangan lupa logout perangkat lama di WhatsApp → Perangkat Tertaut.\n')
}

async function owner(args: string[]): Promise<void> {
    const src = readEnv()
    const current = envValue(src, 'OWNER_NUMBERS')

    if (!args.length) {
        console.log(`\nOWNER_NUMBERS saat ini: ${current || '(kosong)'}`)
        console.log('Ganti dengan:  npm run owner -- 628xxxxxxxxxx[,628yyy]\n')
        return
    }

    const { numbers, invalid } = normalizeNumbers(args)
    if (!numbers.length || invalid.length) {
        console.error(`❌ nomor tidak valid: ${invalid.join(', ') || '(kosong)'} — pakai digit saja dengan kode negara, mis. 6281234567890`)
        process.exit(1)
    }

    fs.writeFileSync(ENV_PATH, setEnvValue(src, 'OWNER_NUMBERS', numbers.join(',')))
    console.log(`\n✅ OWNER_NUMBERS: ${current || '(kosong)'} → ${numbers.join(', ')}`)
    console.log('   Restart engine-nya supaya berlaku (pm2 restart killa-engine).')
    console.log('   Catatan: sesi chat di-key per nomor, jadi nomor baru mulai dari percakapan kosong.\n')
}

const [cmd, ...args] = process.argv.slice(2)
const commands: Record<string, (args: string[]) => Promise<void>> = { relink, owner }

if (!cmd || !commands[cmd]) {
    console.error('usage: node src/cli/manage.ts <relink|owner> [args]')
    process.exit(1)
}
void commands[cmd]!(args).catch((e: Error) => { console.error(`❌ ${e.message}`); process.exit(1) })
