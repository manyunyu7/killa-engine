# The Workspace

**The workspace is the agent.** killa-engine itself has no personality, no memory, no skills — it's plumbing. Everything that makes your agent *yours* lives in one folder of plain markdown files, and the engine just runs `claude -p` with that folder as the working directory.

This is the core design bet, inherited from how Claude Code itself works: when `claude` runs in a directory, that directory's `CLAUDE.md` is loaded as standing instructions, and its files are what the agent naturally reads and writes.

## The starter layout

`npm run setup` scaffolds:

```
workspace/
├── CLAUDE.md    # standing instructions — read on EVERY run (the "system prompt")
├── SOUL.md      # personality: tone, quirks, how it talks
├── USER.md      # facts about you; the agent appends as it learns
└── MEMORY.md    # shared long-term memory; the agent appends dated notes
```

## A second workspace

`npm run setup` only runs its full flow on a fresh checkout — it refuses to touch an existing `.env`. To scaffold an extra workspace (a second persona, a work agent, a sandbox to experiment in):

```bash
npm run setup -- --workspace ~/killa-kerja
```

That asks the persona questions, writes the four starter files into that folder, and stops — `.env` is never read or written. Existing files are kept, so it's safe to re-run over a workspace you've already edited.

To actually run it, point an instance at it with `WORKSPACE_DIR=~/killa-kerja` — or, to give it to one contact on the bot number you already have, `CONTACT_WORKSPACES=628xxx:~/killa-kerja` (see [configuration.md](configuration.md)). If it runs *alongside* your first instance, give it its own `SESSION_DIR` and `STATE_DIR` as well — otherwise the two processes share WhatsApp credentials and per-chat session state and will fight over both.

Only `CLAUDE.md` is special (Claude Code loads it automatically). The others work because `CLAUDE.md` says *"read SOUL.md, USER.md, MEMORY.md before every reply"* — a convention, not a mechanism. Rename them, add `PEOPLE.md`, `HEALTH.md`, `projects/` — whatever structure fits your life. Just keep `CLAUDE.md` pointing at what matters.

## Writing a good CLAUDE.md

Things that earn their place:

- **Style rules for WhatsApp.** Claude's default register is markdown essays. For chat you want the opposite — the starter template's "no bold, no lists, no headers, text like a person" block matters more than anything else.
- **Memory discipline.** Tell it *where* to write what it learns, or it won't. "Append dated notes to MEMORY.md; facts about me go to USER.md."
- **Boundaries.** "This workspace is your world; don't touch files outside it unless asked." (See [security.md](security.md) for why this is a convention, not a sandbox.)

## Memory: how it actually persists

Two layers, different lifetimes:

1. **Claude session** (short-term) — each chat resumes a session, so the agent remembers the conversation. After `SESSION_IDLE_MINUTES` of silence (or `/new`) it starts fresh.
2. **Workspace files** (long-term) — whatever the agent wrote to `MEMORY.md`, `memory/YYYY-MM-DD.md`, `USER.md` survives forever.

The engine bridges the seam three ways ([architecture.md](architecture.md#memory-across-sessions)): every message carries a timestamp, a fresh session is briefed with the last lines of the old one, and an expiring session gets one cheap turn to write memory before it is forgotten. The starter `CLAUDE.md` tells the agent what those engine notes mean — keep that section if you write your own.

What the engine cannot do is decide *what* is worth keeping. So `CLAUDE.md` still has to say where things go, and it pays to keep the split the starter uses:

- `memory/YYYY-MM-DD.md` — what happened today, written as it happens.
- `MEMORY.md` — lasting facts only, read at the start of every session. Keep it small: under ~15 KB. A 150 KB `MEMORY.md` is not memory, it is a file the agent stops reading.
- `USER.md`, `people/`, `health/`… — topic files, read when the topic comes up, not every turn.

Avoid "read these nine files before every reply". The agent will not (it is 60k tokens), and once it has learned to ignore one instruction it ignores the next.

## Migrating from OpenClaw

An OpenClaw workspace (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `HEARTBEAT.md`, …) drops in almost unchanged — the file convention is deliberately compatible:

1. Point `WORKSPACE_DIR` at your existing OpenClaw workspace.
2. Write a `CLAUDE.md` that does what OpenClaw's system-prompt builder did: point to `SOUL.md` and friends, restate the reply-style rules from your `AGENTS.md`.
3. `HEARTBEAT.md` / cron-driven behaviors don't run yet (see roadmap) — everything conversational works.

Don't run the setup wizard against a workspace you care about expecting it to wire things up — it only adds missing starter files (it never overwrites, so it's safe, just not useful there). Write the `CLAUDE.md` by hand.

## Versioning

`git init` your workspace. Memory files written by an agent are exactly the kind of thing you want history for — both to watch it evolve and to undo a bad day. Keep it a **separate** repo from killa-engine: engine code and personal memory have different lifecycles and very different sensitivity.
