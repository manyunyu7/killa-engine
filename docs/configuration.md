# Configuration Reference

All configuration is environment variables, read from `.env` in the repo root. `npm run setup` writes the required three; the rest have defaults.

## Required

| Variable | Meaning |
|---|---|
| `OWNER_NUMBERS` | Comma-separated numbers allowed to talk to the agent. Digits only, with country code (`6281234567890`). Everyone else is silently ignored. The engine refuses to start without this. |
| `WORKSPACE_DIR` | Absolute path to the agent's workspace — the cwd for every `claude` run. Must exist. See [workspace.md](workspace.md). |

## Accounts

| Variable | Default | Meaning |
|---|---|---|
| `ACCOUNTS` | `main` | Comma-separated labels; each is one WhatsApp login with its own `sessions/<label>/` dir and QR (`qr-<label>.png`). Add a label + restart to pair a second number. All accounts share the same owner list and workspace. |
| `SESSION_DIR` | `./sessions` | Where WhatsApp credentials live. **Equivalent to being logged in** — protect and back up accordingly. |

## Agent behavior

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_IDLE_MINUTES` | `30` | Silence longer than this starts a fresh Claude session (long-term memory in workspace files is unaffected). Raise for slow-burn conversations; lower for a more goldfish agent. `/new` in chat resets on demand. |
| `AGENT_TIMEOUT_SECONDS` | `300` | Hard cap per agent run; on expiry the child is killed and the chat gets a "took too long" reply. Big multi-step tasks may need more. |
| `CLAUDE_BIN` | `claude` | Path to the CLI if not on the service user's PATH (typical under pm2 + nvm: `/home/killa/.nvm/versions/node/v22.x.x/bin/claude`). |
| `STATE_DIR` | `./state` | Holds `chat-sessions.json` (chat ↔ Claude-session map). Deleting it forgets which session each chat was in — harmless beyond that. |

## Alerts (optional)

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | If both set, you get a Telegram ping when a WhatsApp session is logged out and needs a re-scan. Telegram (not WhatsApp) on purpose: if WA is down, WA can't tell you, and the engine never initiates WhatsApp messages anyway. |

## In-chat commands

| Command | Effect |
|---|---|
| `/new` | Forget the current conversation and start a fresh Claude session. |
