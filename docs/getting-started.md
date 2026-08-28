# Getting Started

From zero to chatting with your agent in ~10 minutes.

## What you need

| Thing | Why |
|---|---|
| Node.js 22+ | Baileys 7 requires it |
| [Claude Code](https://claude.com/claude-code) CLI, logged in | The agent brain. Uses your existing Claude subscription — no separate API key or bill |
| A **spare** WhatsApp number | The agent's identity. Don't use your daily number: you can't chat with yourself, and if WhatsApp ever bans the number you don't want it to be yours |
| A phone with that number | Only to scan the QR once |

## 1. Install

```bash
npm install -g @anthropic-ai/claude-code   # skip if you already have it
claude                                      # log in once, then exit

git clone https://github.com/<you>/killa-engine && cd killa-engine
npm install
```

## 2. Run the wizard

```bash
npm run setup
```

It asks five things:

1. **Your WhatsApp number** — digits only, with country code (`62812…`). Only this number can talk to the agent; everyone else is silently ignored. Multiple numbers: comma-separated.
2. **Workspace folder** — the agent's world. Created and scaffolded if it doesn't exist. See [workspace.md](workspace.md).
3. **Agent name** — what it calls itself.
4. **Your name** — what it calls you.
5. **Reply language.**

The wizard writes `.env` and scaffolds the workspace. It never overwrites files that already exist, so it's safe to re-run.

## 3. Start and pair

```bash
npm start
```

A QR code appears in the terminal (also saved as `qr-main.png` if your terminal mangles it). On the phone that owns the **agent's** number: WhatsApp → Linked Devices → Link a Device → scan.

You'll see `TERHUBUNG sebagai <number>` when it's paired. The session persists in `sessions/` — you only scan again if WhatsApp logs the device out.

## 4. Chat

From **your** phone, message the agent's number. The first reply takes a few seconds — a real agent run is happening, not a canned response.

Things to try:

- `what's in your workspace?` — it can read its own files
- `remember that my sister's birthday is June 3` — watch `MEMORY.md` change
- `/new` — reset the conversation (sessions also auto-reset after 30 idle minutes)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FATAL: OWNER_NUMBERS wajib diisi` | `.env` missing or empty — run `npm run setup` |
| Message sent, nothing happens | Sender not in `OWNER_NUMBERS` (check country code, digits only), or a group chat (unsupported) |
| `⚠️ Gagal menjalankan agent` | `claude` not on PATH for the process — set `CLAUDE_BIN` in `.env` to the absolute path |
| `⏱️ Kelamaan mikir` | Run exceeded `AGENT_TIMEOUT_SECONDS` (default 300) — raise it, or ask smaller things |
| QR loops forever after scanning | Normal once (WhatsApp forces a reconnect right after pairing, code 515). If it truly loops, delete `sessions/<account>` and re-scan |
| Replies are markdown-ugly | Tune the style rules in your workspace's `CLAUDE.md` |

Next: [workspace.md](workspace.md) to shape the personality, [deploy-vps.md](deploy-vps.md) to make it 24/7.
