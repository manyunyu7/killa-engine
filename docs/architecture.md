# Architecture

One bet: **don't build an agent runtime — borrow Claude Code's.**

```
┌─────────┐   Baileys    ┌──────────────────────┐   spawn    ┌─────────────────┐
│WhatsApp │◄────────────►│  killa-engine        │───────────►│ claude -p       │
│ (owner) │              │  gateway + queue     │            │ --resume <id>   │
└─────────┘              │  + session registry  │◄───────────│ cwd = workspace │
                         └──────────────────────┘  json out  └─────────────────┘
```

## Layout

TypeScript, run directly by Node 22.18+ — no build step, no `dist/`, the file you read is the file that runs.

```
src/
├── main.ts            wiring only: config → stores → ports → socket
├── config.ts          env → typed Config (pure)
├── types.ts           shared domain types
├── core/              no I/O, no clock of its own — where the tests live
│   ├── dispatch.ts    slash commands + the agent turn
│   ├── markers.ts     [[send:]] / [[remind:]] parsing
│   ├── schedule.ts    reminder specs → fire times
│   ├── queue.ts       per-chat serialization
│   └── ports.ts       the interfaces the outside world enters through
├── store/             JSON persistence (sessions, models, reminders)
├── agent/             the claude CLI bridge (spawn injected)
├── whatsapp/          Baileys: connection lifecycle + inbound parsing
└── cli/               setup wizard, relink/owner, workspace template
```

The rule that keeps it testable: **decisions live in `core/`, effects live at the edges.** `dispatch.ts` never imports `fs`, `baileys` or `child_process` — it takes a `Chat` (send text, send image, set presence) and `Deps` (stores, agent, clock, logger) and returns. That is why the whole message flow can be exercised with fakes, and why `main.ts` and `connection.ts` are the only files with nothing to test: they contain no decisions.

Where OpenClaw and Hermes reimplement sessions, tool loops, memory, and skills on top of a raw model API, killa-engine delegates all of it to the `claude` CLI. The engine's whole job is: get text out of WhatsApp reliably, keep replies in order, and remember which Claude session belongs to which chat.

## Message lifecycle

1. **`messages.upsert`** fires. Drop: own messages, groups, non-text, non-`notify` types.
2. **Sender resolution.** WhatsApp increasingly hides real numbers behind LIDs (`…@lid`). Baileys 7's `remoteJidAlt`/`participantAlt` gives the real number; `getPNForLID()` is the fallback. Unresolvable senders are dropped — identity is the security boundary, so no identity means no processing.
3. **Owner check.** Not in `OWNER_NUMBERS` → logged and ignored. No reply, no error — an unknown sender learns nothing, not even that the bot exists.
4. **Queue.** Jobs chain on a per-chat promise (`core/queue.ts`). One agent run at a time per chat, so replies can't interleave or arrive out of order. Different chats run concurrently.
5. **Agent run** (`src/agent/claude.ts`). Spawns `claude -p <text> --output-format json`, cwd = workspace, `--resume <sessionId>` if the chat has a live session. The JSON result carries the reply and a `session_id` for next time.
6. **Reply** goes out on the same socket, chunked at 3500 chars, with a typing indicator during the run.

## Session registry

`state/chat-sessions.json` maps `number → { sessionId, lastAt }`, persisted so a restart doesn't forget conversations.

- Resume if the last message was under `SESSION_IDLE_MINUTES` ago; otherwise start fresh.
- `/new` clears the entry explicitly.
- A failed `--resume` (session pruned, Claude Code updated, …) clears the entry and tells the user the next message starts fresh — degrade to amnesia, never to silence.

Long-term memory does **not** live here — it lives in the workspace files the agent itself writes. See [workspace.md](workspace.md).

## WhatsApp layer: inherited scar tissue

The Baileys handling is forked from a production OTP listener (168Railway's wa-listener) and keeps its hard-won invariants:

- **Generation guard.** WhatsApp forces reconnects (code 515 right after pairing is routine), so one account spawns several short-lived sockets. Dead sockets keep emitting events; every handler checks `isStale()` so a zombie can't clobber the live socket's state. Without this, the classic symptom is a QR loop on an already-paired session.
- **Logout vs disconnect.** `loggedOut` means the credentials are dead: wipe `sessions/<account>` and demand a re-scan (optionally alerting via Telegram). Anything else is a plain reconnect after 5s.
- **QR as PNG** (`qr-<account>.png`) alongside terminal ASCII, because pm2 log prefixes mangle ASCII QRs.

## Failure containment

Every layer fails toward "the WhatsApp connection stays up":

- Agent spawn failure, crash, or timeout → an apologetic reply, never an unhandled throw.
- `handleMessage` errors are caught per-message; one bad message can't kill the upsert handler.
- Timeout (`AGENT_TIMEOUT_SECONDS`) kills the child with SIGKILL; the session id is kept so context isn't lost.

## What's deliberately absent

- **No HTTP server.** wa-listener's control API exists for a Laravel admin panel; a personal engine doesn't need an attack surface. (A control port may return for multi-account management — roadmap.)
- **No message DB.** WhatsApp is the transcript UI; Claude Code stores its own transcripts; the workspace holds distilled memory. A fourth copy adds nothing.
- **No cold outbound.** There is no code path that messages a chat the owner didn't just write in. This is the #1 account-ban vector; proactive features will go through a non-WhatsApp channel instead.
