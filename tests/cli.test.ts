import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envValue, normalizeNumbers, setEnvValue } from '../src/cli/env-file.ts'
import { expandHome, scaffoldWorkspace, workspaceFlag, workspaceTemplate } from '../src/cli/workspace.ts'

const ENV = `ACCOUNTS=main
# a comment
OWNER_NUMBERS=628111
WORKSPACE_DIR=/ws
`

describe('env-file', () => {
    it('reads a key', () => {
        expect(envValue(ENV, 'OWNER_NUMBERS')).toBe('628111')
        expect(envValue(ENV, 'MISSING')).toBe('')
    })

    it('replaces a key in place, touching nothing else', () => {
        const next = setEnvValue(ENV, 'OWNER_NUMBERS', '628999')
        expect(envValue(next, 'OWNER_NUMBERS')).toBe('628999')
        expect(next).toContain('# a comment')
        expect(next).toContain('WORKSPACE_DIR=/ws')
        expect(next.split('\n')).toHaveLength(ENV.split('\n').length)
    })

    it('appends a key that is not there yet, without doubling newlines', () => {
        const next = setEnvValue(ENV, 'TIMEZONE', 'Asia/Jakarta')
        expect(next.endsWith('TIMEZONE=Asia/Jakarta\n')).toBe(true)
        expect(next).not.toContain('\n\n')
    })

    it('normalizes numbers and flags the impossible ones', () => {
        expect(normalizeNumbers(['+62 811-1234-5678'])).toEqual({ numbers: ['6281112345678'], invalid: [] })
        expect(normalizeNumbers(['628111222333,628444555666']))
            .toEqual({ numbers: ['628111222333', '628444555666'], invalid: [] })
        expect(normalizeNumbers(['123'])).toEqual({ numbers: [], invalid: ['123'] })
        expect(normalizeNumbers(['1'.repeat(16)]).invalid).toHaveLength(1)
        expect(normalizeNumbers(['abc'])).toEqual({ numbers: [], invalid: [] })
    })
})

describe('workspaceFlag', () => {
    it.each([
        [['--workspace', '/a'], '/a'],
        [['--workspace=/a'], '/a'],
        [['--workspace'], ''],
        [[], null],
        [['--yes'], null],
    ])('%o -> %o', (argv, expected) => {
        expect(workspaceFlag(argv)).toBe(expected)
    })
})

describe('expandHome', () => {
    it('expands a leading ~ only', () => {
        expect(expandHome('~/ws', '/home/h')).toBe('/home/h/ws')
        expect(expandHome('~', '/home/h')).toBe('/home/h')
        expect(expandHome('/a/~/b', '/home/h')).toBe('/a/~/b')
        expect(expandHome('~ws', '/home/h')).toBe('~ws')
    })
})

describe('workspaceTemplate', () => {
    const persona = { agentName: 'Killa', ownerName: 'Henry', language: 'Indonesian' }

    it('writes the four files the engine expects', () => {
        expect(Object.keys(workspaceTemplate(persona)))
            .toEqual(['CLAUDE.md', 'SOUL.md', 'USER.md', 'MEMORY.md'])
    })

    it('weaves the persona into the instructions', () => {
        const files = workspaceTemplate(persona)
        expect(files['CLAUDE.md']).toContain('You are Killa, Henry\'s personal agent')
        expect(files['CLAUDE.md']).toContain('Reply in Indonesian')
    })

    it('teaches the agent both marker conventions', () => {
        const claude = workspaceTemplate(persona)['CLAUDE.md']!
        expect(claude).toContain('[[send:')
        expect(claude).toContain('[[remind:')
        expect(claude).toContain('ask for the hour instead of guessing')
    })
})

describe('scaffoldWorkspace', () => {
    const persona = { agentName: 'Killa', ownerName: 'Henry', language: 'Indonesian' }
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'killa-ws-'))

    it('creates the starter files', () => {
        const dir = path.join(tmp(), 'new')
        expect(scaffoldWorkspace(dir, persona, () => {})).toHaveLength(4)
        expect(fs.readdirSync(dir).sort()).toEqual(['CLAUDE.md', 'MEMORY.md', 'SOUL.md', 'USER.md'])
    })

    it('never overwrites a file the user has edited', () => {
        const dir = tmp()
        fs.writeFileSync(path.join(dir, 'SOUL.md'), 'punyaku')
        const written = scaffoldWorkspace(dir, persona, () => {})

        expect(written).not.toContain('SOUL.md')
        expect(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('punyaku')
    })

    it('is safe to re-run', () => {
        const dir = tmp()
        scaffoldWorkspace(dir, persona, () => {})
        expect(scaffoldWorkspace(dir, persona, () => {})).toEqual([])
    })

    it('reports what it did, for the wizard to print', () => {
        const lines: string[] = []
        scaffoldWorkspace(tmp(), persona, l => lines.push(l))
        expect(lines).toHaveLength(4)
        expect(lines[0]).toContain('created')
    })
})
