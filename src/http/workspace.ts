/**
 * The workspace as seen by the HTTP channel: directory listing, file read,
 * write and delete, git log and commit.
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

// ---------------------------------------------------------------- writes

export const MAX_WRITE_BYTES = 512 * 1024

/**
 * Hidden check for writes, case-folded: on a case-insensitive filesystem
 * (macOS default) `.GIT/config` *is* `.git/config`.
 */
const hiddenSegment = (rel: string): boolean =>
    rel.split(/[\\/]/).some(seg => isHidden(seg.toLowerCase()))

/** A real path must sit strictly inside the real root and name nothing hidden on the way. */
function assertRealInside(realRoot: string, real: string): void {
    const rel = path.relative(realRoot, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || hiddenSegment(rel)) {
        throw new WorkspaceError(400, 'path di luar workspace')
    }
}

const lstatOrNull = (p: string): fs.Stats | null => {
    try { return fs.lstatSync(p) } catch { return null }
}

/**
 * The real parent directory for a write/delete target plus its basename.
 * The parent may not exist yet: the deepest existing ancestor is realpath'd
 * and fenced, and the missing tail is returned for the caller to create.
 */
function safeParent(root: string, rel: string): { realRoot: string; parent: string; name: string } {
    const full = resolveInside(root, rel)
    if (!full || full === path.resolve(root) || hiddenSegment(String(rel))) {
        throw new WorkspaceError(400, 'path di luar workspace')
    }
    let realRoot: string
    try { realRoot = fs.realpathSync(root) } catch { throw new WorkspaceError(404, 'workspace tidak ditemukan') }
    let dir = path.dirname(full)
    const missing: string[] = []
    while (!lstatOrNull(dir)) { missing.unshift(path.basename(dir)); dir = path.dirname(dir) }
    let realDir: string
    // A dangling symlink as an ancestor: we cannot know where it leads.
    try { realDir = fs.realpathSync(dir) } catch { throw new WorkspaceError(400, 'path di luar workspace') }
    if (realDir !== realRoot) assertRealInside(realRoot, realDir)
    return { realRoot, parent: path.join(realDir, ...missing), name: path.basename(full) }
}

/**
 * Write a UTF-8 text file inside the workspace, creating parent dirs. An
 * existing symlink is written through only if its target is inside too; a
 * dangling one is refused (writing would create a file wherever it points).
 */
export function writeFile(root: string, rel: string, content: string): string {
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new WorkspaceError(413, `content lebih dari ${MAX_WRITE_BYTES} byte`)
    }
    const { realRoot, parent, name } = safeParent(root, rel)
    let target = path.join(parent, name)
    const st = lstatOrNull(target)
    if (st?.isSymbolicLink()) {
        try { target = fs.realpathSync(target) } catch { throw new WorkspaceError(400, 'path di luar workspace') }
        assertRealInside(realRoot, target)
    }
    if (st && fs.statSync(target).isDirectory()) throw new WorkspaceError(400, 'bukan file')
    fs.mkdirSync(parent, { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
    return rel
}

/** Delete one file (a symlink is removed itself, never its target). Directories refused. */
export function deleteFile(root: string, rel: string): void {
    const { parent, name } = safeParent(root, rel)
    const st = lstatOrNull(path.join(parent, name))
    if (!st) throw new WorkspaceError(404, 'tidak ditemukan')
    if (st.isDirectory()) throw new WorkspaceError(400, 'bukan file')
    fs.unlinkSync(path.join(parent, name))
}

// ---------------------------------------------------------------- git

export interface GitResult { code: number | null; stdout: string; stderr: string }

/** One git invocation, argument array, no shell. Rejects on spawn error or timeout. */
export function runGit(dir: string, args: string[], spawn: typeof nodeSpawn = nodeSpawn,
                       timeoutMs = 30_000): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let done = false
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            if (!done) { done = true; reject(new Error(`git ${args[0]} timeout`)) }
        }, timeoutMs)
        child.stdout?.on('data', (c: Buffer) => { stdout += c })
        child.stderr?.on('data', (c: Buffer) => { stderr += c })
        child.on('error', (e: Error) => { if (!done) { done = true; clearTimeout(timer); reject(e) } })
        child.on('close', (code: number | null) => {
            if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }) }
        })
    })
}

export const DEFAULT_COMMIT_MESSAGE = 'update via ghina'

export type CommitResult = { ok: true; hash: string } | { ok: true; hash: null; clean: true }

/**
 * `git add -A` + `git commit` in the workspace. The workspace must be the
 * repo's top level — otherwise `add -A` would stage a parent repo's files.
 */
export async function gitCommit(dir: string, message: string, spawn: typeof nodeSpawn = nodeSpawn): Promise<CommitResult> {
    const git = (args: string[]): Promise<GitResult> => runGit(dir, args, spawn)
    const must = async (args: string[]): Promise<GitResult> => {
        const r = await git(args)
        if (r.code !== 0) throw new Error(`git ${args[0]} gagal (${r.code}): ${r.stderr.trim()}`)
        return r
    }
    const top = await git(['rev-parse', '--show-toplevel'])
    let realDir: string
    try { realDir = fs.realpathSync(dir) } catch { throw new WorkspaceError(400, 'workspace bukan repo git') }
    if (top.code !== 0 || safeRealpath(top.stdout.trim()) !== realDir) {
        throw new WorkspaceError(400, 'workspace bukan repo git')
    }
    await must(['add', '-A'])
    // Exit 0 = index matches HEAD (or an empty index on an unborn branch).
    const diff = await git(['diff', '--cached', '--quiet'])
    if (diff.code === 0) return { ok: true, hash: null, clean: true }
    if (diff.code !== 1) throw new Error(`git diff gagal (${diff.code}): ${diff.stderr.trim()}`)
    await must(['commit', '-q', '-m', message])
    return { ok: true, hash: (await must(['rev-parse', 'HEAD'])).stdout.trim() }
}

const safeRealpath = (p: string): string | null => {
    try { return fs.realpathSync(p) } catch { return null }
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
