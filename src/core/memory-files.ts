/**
 * Did the agent already write memory during this session? If any markdown
 * in the workspace root or its memory/ folder is newer than the session
 * start, the flush would be paying for a second pass over the same ground.
 */

import fs from 'node:fs'
import path from 'node:path'

const dirs = (workspace: string) => [workspace, path.join(workspace, 'memory')]

export function memoryTouchedSince(workspace: string, since: number): boolean {
    for (const dir of dirs(workspace)) {
        let names: string[]
        try { names = fs.readdirSync(dir) } catch { continue } // runAs workspace, or no memory/
        for (const name of names) {
            if (!name.endsWith('.md')) continue
            try {
                if (fs.statSync(path.join(dir, name)).mtimeMs > since) return true
            } catch { /* vanished mid-walk */ }
        }
    }
    return false
}
