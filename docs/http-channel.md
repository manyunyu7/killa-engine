# HTTP Channel

A small local JSON API so an app on the same machine — the Ghina web app — can talk to the same agent WhatsApp talks to. It is not a second agent: every chat request becomes a `Chat` handed to the same `dispatch`, per-chat queue, session registry and transcript store as a WhatsApp message.

Off by default. Enable with `HTTP_PORT` + `HTTP_TOKEN` (see [configuration.md](configuration.md#http-channel-optional)).

```
Ghina (Next.js) ──HTTP──► killa-engine :8787 ──► dispatch ──► claude -p  (HTTP_WORKSPACE)
     same VPS, loopback        bearer token         queue / sessions / transcripts
```

## Conventions

- **Base URL:** `http://127.0.0.1:<HTTP_PORT>` (or `HTTP_BIND`).
- **Auth:** every request, every path: `Authorization: Bearer <HTTP_TOKEN>`. Missing or wrong → `401 {"error":"unauthorized"}` before anything else is looked at (unknown paths included). Compared in constant time.
- **Bodies:** JSON, max 1 MB. Responses are always JSON.
- **Errors:** `{"error": "<message>"}` with status `400` (bad input / path outside workspace), `404` (unknown path, or file not found), `405` (known path, wrong method), `413`, `415`, `502` (agent turn failed outright), `500` (internal; message hidden, logged server-side).
- **`chatKey`:** 1–128 chars of `[A-Za-z0-9._:@-]`. Pick one per Ghina user (e.g. their user id). The engine maps it to a synthetic chat `http:<chatKey>`, so each key has its own Claude session, transcript and reminders, while all keys share one workspace — and therefore one memory. A digits-only key never collides with a WhatsApp chat or owner number.

## Endpoints

### `POST /v1/chat`

Run one agent turn and wait for the reply.

```json
{ "chatKey": "user-42", "text": "ringkas catatan hari ini", "model": "sonnet" }
```

| Field | | |
|---|---|---|
| `chatKey` | required | see above |
| `text` | required | non-empty. Slash commands work as on WhatsApp: `/model`, `/reminders`, `/cancel <id>`, `/new`. |
| `model` | optional | model for **this turn only** (alias or full id, `[A-Za-z0-9._[]-]`). Not stored, not probed — an invalid name surfaces as an agent error reply. Without it the chat's `/model` choice (or the CLI default) applies. |

`200`:

```json
{ "reply": "Ini ringkasannya…", "attachments": ["/home/killa/.killa/workspaces/main/out/ringkasan.pdf"] }
```

- `reply` — the agent's text with `[[send:]]` / `[[remind:]]` markers stripped, **not** split into WhatsApp-sized chunks. Engine notices (reminder confirmations `⏰ Diingetin: …`, a failed attachment) follow, separated by a blank line.
- `attachments` — present only when non-empty: paths the agent asked to send with `[[send:<path>]]` that exist on disk. Paths as the agent wrote them (usually absolute, inside the workspace). The file is **not** inlined; read it from disk (same machine).
- The call blocks for the whole agent run — up to `AGENT_TIMEOUT_SECONDS` (default 300 s), plus any turn already running for the same `chatKey` (turns are serialized per chat, exactly like WhatsApp). Set the client timeout to at least `AGENT_TIMEOUT_SECONDS + 60 s`. On agent timeout the reply is the engine's usual "kelamaan mikir" text with status `200`.
- `502 {"error":"agent gagal menjawab"}` only if the turn threw before producing anything.

**Reminders.** `[[remind:<spec>|<text>]]` is parsed and scheduled exactly as on WhatsApp, filed under `http:<chatKey>`, and listed by `/reminders` over HTTP. The HTTP channel is request/response only, so when a reminder fires the engine logs it and sends nothing. If Ghina wants to surface reminders, poll `/reminders` for now.

### `POST /v1/chat/new`

Same as `/new`: flush memory for the current session if it is worth it, forget the session, clear the transcript. Waits for any running turn of that `chatKey` first.

```json
{ "chatKey": "user-42" }
```

`200 {"ok": true}`

### `GET /v1/chat/history?chatKey=<key>&limit=<n>`

The last `n` lines of the engine's rolling transcript for that chat (default 20).

```json
{ "messages": [
  { "at": 1790000000000, "who": "user",  "text": "halo" },
  { "at": 1790000004000, "who": "agent", "text": "Halo! Ada yang bisa dibantu?" }
] }
```

This is the engine's session-briefing log, not a message archive: at most **20 lines** per chat, each **truncated to 240 chars** with whitespace collapsed, cleared by `/new`. `at` is epoch milliseconds. Ghina should keep its own full history if it needs one.

### `GET /v1/workspace/files?path=<rel>`

Directory listing inside the HTTP workspace. `path` is relative to the workspace root; omit it for the root.

```json
{ "entries": [
  { "name": "memory", "type": "dir",  "size": 0 },
  { "name": "MEMORY.md", "type": "file", "size": 1834 }
] }
```

Directories first, then files, alphabetical. `.git`, `node_modules` and `.env` / `.env.*` are never listed. Symlinks are reported as what they point to.

### `GET /v1/workspace/file?path=<rel>`

```json
{ "path": "memory/2026-09-30.md", "content": "…" }
```

`path` is required. Text only, UTF-8. `413` over 256 KB, `415` for binary (NUL byte in the first 8 KB), `400` for a directory, `404` if missing.

**Path rules (both endpoints):** absolute paths, any `..` segment, NUL bytes, and any segment naming a hidden entry (`.git`, `node_modules`, `.env*`) → `400`. The resolved path — and its realpath, so a symlink cannot escape — must stay inside the workspace, else `400`.

### `GET /v1/git/log?limit=<n>`

`git log` in the workspace (default 20, max 200).

```json
{ "commits": [
  { "hash": "3f2a…", "date": "2026-09-30T10:12:00+07:00", "author": "Killa", "subject": "memory: catatan harian" }
] }
```

`date` is ISO 8601 author date. Not a git repo, no `git` binary, or git taking over 10 s → `{"commits": []}`. Run via `spawn` with an argument array; no shell.

## Security notes

- Bind stays on `127.0.0.1` unless you have a reason; if Ghina runs on another host, put a TLS reverse proxy in front rather than binding publicly.
- The token is the whole boundary. Whoever holds it can make the agent — which runs with `--dangerously-skip-permissions` in the workspace — do anything the engine's OS user can. Keep it server-side in Ghina (never in client JS), and treat every Ghina user who can reach `/v1/chat` as someone you'd hand the workspace to. Point `HTTP_WORKSPACE` at a dedicated workspace if they shouldn't see your personal memory.
- The WhatsApp owner check does not apply here; the token replaces it.
