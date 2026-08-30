# killa-engine

**Your personal AI agent on WhatsApp — powered by Claude Code, not a reinvented agent runtime.**

Message your own WhatsApp number; a full Claude Code agent answers. It reads and writes files in a workspace you choose, remembers the conversation, runs tools, and replies in the same chat.

```
You (WhatsApp) ──► killa-engine (Baileys) ──► claude -p  (your workspace)
                            ▲                     │
                            └──── reply ──────────┘
```

## Why this exists

Projects like OpenClaw and Hermes Agent build their own agent runtime on top of a model API — session handling, tool loops, memory, skills, all reimplemented. killa-engine takes the opposite bet: **Claude Code already is that runtime**, mature and maintained. So this project is only the thinnest possible bridge — ~300 lines of WhatsApp plumbing — and everything else (tools, memory files, skills, sub-agents, MCP) comes for free and stays up to date.

Practical consequences:

- **No API bill.** Runs on your existing Claude subscription via the `claude` CLI.
- **The workspace is the personality.** Point `WORKSPACE_DIR` at a folder; its `CLAUDE.md` becomes the agent's standing instructions, its markdown files its memory. An OpenClaw-style workspace (SOUL.md, MEMORY.md, …) drops in unchanged.
- **Tiny surface to audit.** A few hundred lines of TypeScript, with the decision-making core covered by 172 tests. The WhatsApp layer is forked from a production OTP listener that survived real-world LID migration, 515 reconnect storms, and multi-account operation.

## Design principles

- **Owner-only.** Messages from numbers outside `OWNER_NUMBERS` are ignored silently. This is a personal agent, not a public bot.
- **Reply-only.** The engine only sends into chats the owner just wrote in — no cold outbound. Unsolicited sending is the #1 cause of WhatsApp account bans; don't add it.
- **Serialized per chat.** One agent run at a time per conversation; replies can't arrive out of order.
- **Sessions with amnesia on purpose.** Each chat resumes its Claude session; after 30 idle minutes (configurable) the next message starts fresh. Send `/new` to reset manually.

## Requirements

- Node.js 22.18+ (the source is TypeScript, run directly — no build step)
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on PATH)
- A WhatsApp number you control (a spare number is strongly recommended)

## Quick start

```bash
git clone <this repo> && cd killa-engine
npm install
npm run setup           # interactive wizard: number, workspace, persona
                        # (extra workspace later: npm run setup -- --workspace <path>)
npm start               # scan the QR that appears (or qr-main.png)
```

The wizard checks your `claude` CLI, asks for your number, scaffolds a starter workspace (`CLAUDE.md`, `SOUL.md`, `USER.md`, `MEMORY.md`), and writes `.env`. Prefer doing it by hand? `cp .env.example .env` works too.

Then message that number from your own phone. First reply takes a few seconds — a real agent is thinking, not a canned bot.

## Security model, honestly stated

The agent runs headless with `--dangerously-skip-permissions`: nobody is there to approve tool calls, so nothing asks. Treat `WORKSPACE_DIR` as the blast radius — the agent can do anything your user account can do, started from that directory. Mitigations, in order of effectiveness:

1. Only whitelist numbers you personally control.
2. Run it as a dedicated OS user that owns the workspace and little else.
3. Don't point the workspace at anything you can't afford to lose.

WhatsApp session credentials (`sessions/`) are equivalent to being logged in as that account. They are gitignored; keep them that way.

## Deploy (VPS, pm2)

```bash
pm2 start src/main.ts --name killa-engine --time
pm2 save
```

For headless servers, authenticate the `claude` CLI with a long-lived token created on a machine with a browser (`claude setup-token`).

## Documentation

- [Getting started](docs/getting-started.md) — zero to chatting in ~10 minutes
- [The workspace](docs/workspace.md) — personality, memory, migrating from OpenClaw
- [Architecture](docs/architecture.md) — layout, message lifecycle, why the core has no I/O
- [Configuration](docs/configuration.md) — every env var and in-chat command
- [Deploying to a VPS](docs/deploy-vps.md) — pm2, headless Claude auth, 24/7
- [Security model](docs/security.md) — read before deploying, honestly stated
- [Testing](docs/testing.md) — what's covered, and how the fakes work

## Roadmap

- [ ] Pairing gate for unknown senders (approval codes instead of a static whitelist)
- [x] Media in/out (images) — voice notes still open
- [x] Scheduled reminders (owner-only, capped, see docs/configuration.md)
- [ ] Scheduled/proactive runs (cron → agent; outbound via a non-WhatsApp channel to respect reply-only)
- [ ] Group chat support with explicit mention gating
- [ ] Telegram as a second surface

## License

MIT
