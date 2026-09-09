# Configuration Reference

All configuration is environment variables, read from `.env` in the repo root. `npm run setup` writes the required three; the rest have defaults.

## Required

| Variable | Meaning |
|---|---|
| `OWNER_NUMBERS` | Comma-separated numbers allowed to talk to the agent. Digits only, with country code (`6281234567890`). Everyone else is silently ignored. The engine refuses to start without this. |
| `WORKSPACE` | The agent's workspace — the cwd for every `claude` run. A bare name (`main`, `kerja`) resolves under the managed root, `~/.killa/workspaces/<name>`; an absolute path is used as given, for a workspace you keep elsewhere. Must exist: create one with `npm run workspace new <name>`. See [workspace.md](workspace.md). |

## Workspaces

Workspaces are engine-managed so that "where do I put it" is never a question: they live under one root, and a second one is a name, not a decision.

```
~/.killa/workspaces/
├── main/       ← WORKSPACE=main
└── kerja/      ← WORKSPACE_KERJA=kerja
```

| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACES_DIR` | `~/.killa/workspaces` | Root for managed workspaces. Move it if `$HOME` isn't where you keep data. |
| `WORKSPACE_DIR` | — | Legacy escape hatch: an explicit path that wins over `WORKSPACE`. Installs predating the managed root keep working untouched. |

```bash
npm run workspace              # list them, and which account uses which
npm run workspace new kerja    # scaffold a new one under the root
npm run workspace path kerja   # print its full path
```

A workspace you keep outside the root (a git repo, say) is fully supported — point `WORKSPACE` at its path, and `npm run workspace` will still list it, marked `di luar root`.

## Accounts

| Variable | Default | Meaning |
|---|---|---|
| `ACCOUNTS` | `main` | Comma-separated labels; each is one WhatsApp login with its own `sessions/<label>/` dir and QR (`qr-<label>.png`). Add a label + restart to pair a second number. |
| `WORKSPACE_<LABEL>` | `WORKSPACE` | Workspace for one account — a different persona and memory on a different number, in the same process. Label upper-cased, non-alphanumerics become `_` (`kerja-2` → `WORKSPACE_KERJA_2`). |
| `OWNER_NUMBERS_<LABEL>` | `OWNER_NUMBERS` | Owners for one account. With this, a second person gets their own number, workspace and memory without a second instance. |
| `CONTACT_WORKSPACES` | — | `<number>:<workspace>` pairs, comma-separated — DMs from those numbers run in that workspace instead of the account's: `CONTACT_WORKSPACES=6285647281472:mybabygurll, 628222:kerja`. The number is normalized to digits, so `+62 856-4728-1472` is fine; the workspace is a managed name or an absolute path. This is how a second person shares one bot number without sharing your memory. A `CONTACT_WORKSPACES_<LABEL>` scopes the map to one account and replaces the global one there. |
| `SESSION_DIR` | `./sessions` | Where WhatsApp credentials live. **Equivalent to being logged in** — protect and back up accordingly. |

## Agent behavior

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_IDLE_MINUTES` | `30` | Silence longer than this starts a fresh Claude session (long-term memory in workspace files is unaffected). Raise for slow-burn conversations; lower for a more goldfish agent. `/new` in chat resets on demand. |
| `AGENT_TIMEOUT_SECONDS` | `300` | Hard cap per agent run; on expiry the child is killed and the chat gets a "took too long" reply. Big multi-step tasks may need more. |
| `CLAUDE_BIN` | `claude` | Path to the CLI if not on the service user's PATH (typical under pm2 + nvm: `/home/killa/.nvm/versions/node/v22.x.x/bin/claude`). |
| `STATE_DIR` | `./state` | Holds `chat-sessions.json` (chat ↔ Claude-session map). Deleting it forgets which session each chat was in — harmless beyond that. |

## Reminders

The agent can schedule a message to you by writing `[[remind:<spec>|<text>]]` in its reply; the engine strips the marker, stores the reminder in `state/reminders.json`, and delivers it when due. Specs: `2026-09-01T19:00`, `19:00`, `in 45m`, `daily 07:00`, `weekly mon 09:00`, `every 3h` — all in `TIMEZONE` (see below). Tell the agent about the convention in your `CLAUDE.md`, the same way `[[send:]]` is documented.

This is the one place the engine sends without being spoken to first, so it is fenced in: owner numbers only, into a chat that already exists, and a per-day cap. A reminder missed while the process was down fires late only if it is less than 6 hours stale; recurring ones roll forward instead of firing a backlog. Reminders survive restarts but need the process running — on a laptop that sleeps, they simply don't arrive.

| Variable | Default | Meaning |
|---|---|---|
| `TIMEZONE` | server's | IANA name (`Asia/Jakarta`) used for every reminder time. Set it: a VPS is usually UTC, and `daily 07:00` means 7am *where the phone is*. It is applied as `TZ` before the first `Date` is built and inherited by the `claude` child, so the agent's own clock agrees with the scheduler's. The startup log prints the resolved zone and current time — check it after deploying. |
| `REMINDERS_MAX_PER_DAY` | `20` | Cap on reminders delivered per chat per day. A safety valve against a runaway recurring rule, not a feature. |

## Alerts (optional)

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | If both set, you get a Telegram ping when a WhatsApp session is logged out and needs a re-scan. Telegram (not WhatsApp) on purpose: if WA is down, WA can't tell you, and the engine never initiates WhatsApp messages anyway. |

## In-chat commands

| Command | Effect |
|---|---|
| `/new` | Forget the current conversation and start a fresh Claude session. |
| `/model` | Show the active model for this chat. |
| `/model fable\|opus\|sonnet\|haiku` | Switch model for this chat (sticks across session resets). |
| `/model default` | Back to the CLI default. |
| `/reminders` | List this chat's scheduled reminders with their ids. |
| `/cancel <id>` | Cancel one reminder. |
