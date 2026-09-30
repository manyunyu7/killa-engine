/**
 * Read-only views of the workspace for the HTTP channel: directory listing,
 * file content, git log.
 *
 * The workspace root is the fence. Every path is resolved and prefix-checked
 * twice — lexically, then through realpath so a symlink inside the workspace
 * cannot point the caller at /etc.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

/** Never listed, never served. `.env*` holds credentials the agent was handed, not content. */
const HIDDEN = new Set(['.git', 'node_modules'])
export const isHidden = (name: string): boolean => HIDDEN.has(name) || /^\.env(\..*)?$/.test(name)

export const MAX_FILE_BYTES = 256 * 1024

export class WorkspaceError extends Error {
    readonly status: number
    constructor(status: number, message: string) { super(message); this.status = status }
}

/**
 * A caller-supplied relative path -> absolute path inside `root`, or null.
 * Pure: rejects absolute paths, any `..` segment, and anything that still
 * resolves outside the root.
 */
export function resolveInside(root: string, rel: string): string | null {
    const raw = String(rel ?? '').replace(/\\/g, '/')
    if (raw.includes('\0') || path.isAbsolute(raw)) return null
    if (raw.split('/').some(seg => seg === '..')) return null
    // Nothing hidden is reachable by naming it either.
    if (raw.split('/').some(seg => isHidden(seg))) return null
    const base = path.resolve(root)
    const full = path.resolve(base, raw || '.')
    return full === base || full.startsWith(base + path.sep) ? full : null
}

/** resolveInside, then the same check on the real (symlink-free) path. */
function safePath(root: string, rel: string): string {
    const full = resolveInside(root, rel)
    if (!full) throw new WorkspaceError(400, 'path di luar workspace')
    let real: string
    let realRoot: string
    try {
        real = fs.realpathSync(full)
        realRoot = fs.realpathSync(root)
    } catch {
        throw new WorkspaceError(404, 'tidak ditemukan')
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new WorkspaceError(400, 'path di luar workspace')
    }
    return real
}

export interface Entry { name: string; type: 'file' | 'dir'; size: number }

export function listDir(root: string, rel: string): Entry[] {
    const dir = safePath(root, rel)
    if (!fs.statSync(dir).isDirectory()) throw new WorkspaceError(400, 'bukan direktori')
    const entries: Entry[] = []
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isHidden(d.name)) continue
        try {
            // stat follows symlinks: report what the link points at.
            const st = fs.statSync(path.join(dir, d.name))
            if (st.isDirectory()) entries.push({ name: d.name, type: 'dir', size: 0 })
            else if (st.isFile()) entries.push({ name: d.name, type: 'file', size: st.size })
        } catch { /* dangling link or vanished mid-walk */ }
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
}

/** A NUL byte in the first 8KB is the same heuristic git uses for "binary". */
export const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0)

export function readFile(root: string, rel: string): string {
    const file = safePath(root, rel)
    const st = fs.statSync(file)
    if (!st.isFile()) throw new WorkspaceError(400, 'bukan file')
    if (st.size > MAX_FILE_BYTES) throw new WorkspaceError(413, `file lebih dari ${MAX_FILE_BYTES} byte`)
    const buf = fs.readFileSync(file)
    if (looksBinary(buf)) throw new WorkspaceError(415, 'file biner')
    return buf.toString('utf8')
}

export interface Commit { hash: string; date: string; author: string; subject: string }

// Unit/record separators: no author name or subject line contains them.
const FORMAT = '%H%x1f%aI%x1f%an%x1f%s%x1e'

export function parseGitLog(out: string): Commit[] {
    return out.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
        const [hash = '', date = '', author = '', subject = ''] = r.split('\x1f')
        return { hash, date, author, subject }
    })
}

/**
 * `git log` in the workspace. Arguments are an array — nothing the caller
 * sends reaches a shell, and the only caller input is an integer anyway.
 * Not a repo, no git, or a timeout: an empty list, never an error.
 */
export function gitLog(dir: string, limit: number, spawn: typeof nodeSpawn = nodeSpawn,
                       timeoutMs = 10_000): Promise<Commit[]> {
    return new Promise(resolve => {
        const child = spawn('git', ['log', `-n${limit}`, `--format=${FORMAT}`],
            { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        let done = false
        const finish = (c: Commit[]) => { if (!done) { done = true; clearTimeout(timer); resolve(c) } }
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish([]) }, timeoutMs)
        child.stdout?.on('data', (c: Buffer) => { out += c })
        child.on('error', () => finish([]))
        child.on('close', (code: number | null) => finish(code === 0 ? parseGitLog(out) : []))
    })
}
