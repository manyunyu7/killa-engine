/**
 * The starter workspace: four markdown files that ARE the agent.
 * Pure template plus a never-overwrite writer, shared by the first-run wizard
 * and `setup --workspace <path>`.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface Persona {
    agentName: string
    ownerName: string
    language: string
}

export function workspaceTemplate({ agentName, ownerName, language }: Persona): Record<string, string> {
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

## Reminders
- If ${ownerName} asks to be reminded, write a marker — a note in a file wakes
  nobody. The engine schedules it and strips the marker from your reply:
  \`[[remind:2026-09-01T19:00|take your meds]]\`, \`[[remind:in 45m|check oven]]\`,
  \`[[remind:daily 07:00|wake up]]\`, \`[[remind:weekly mon 09:00|standup]]\`,
  \`[[remind:every 3h|drink water]]\`.
- Times are ${ownerName}'s local time. If the time is vague ("later", "tomorrow"),
  ask for the hour instead of guessing.

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

/** Scaffold into `dir`. An existing file is always the user's, never ours. */
export function scaffoldWorkspace(dir: string, persona: Persona,
                                  report: (line: string) => void = console.log): string[] {
    fs.mkdirSync(dir, { recursive: true })
    const written: string[] = []

    for (const [name, content] of Object.entries(workspaceTemplate(persona))) {
        const target = path.join(dir, name)
        if (fs.existsSync(target)) {
            report(`   ⏭️  ${name} exists, keeping yours`)
            continue
        }
        fs.writeFileSync(target, content)
        written.push(name)
        report(`   📄 ${name} created`)
    }
    return written
}

/** `--workspace <path>` / `--workspace=<path>`; null when the flag is absent. */
export function workspaceFlag(argv: string[]): string | null {
    const i = argv.indexOf('--workspace')
    if (i !== -1) return argv[i + 1] ?? ''
    const eq = argv.find(a => a.startsWith('--workspace='))
    return eq ? eq.slice('--workspace='.length) : null
}

export const expandHome = (p: string, home: string): string =>
    p.replace(/^~(?=$|\/)/, home)
