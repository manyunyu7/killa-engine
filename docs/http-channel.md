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
- **Bodies:** JSON, max 1 MB — except `POST /v1/chat`, which allows ~33 MB so it can carry media. Responses are JSON, except `GET /v1/media` (the file itself).
- **Errors:** `{"error": "<message>"}` with status `400` (bad input / path outside workspace), `403` (a `wa:` chatKey for a number that is not an owner), `404` (unknown path, file not found, or workspace dir missing), `405` (known path, wrong method), `413`, `415`, `429` (`/v1/notify` rate limit), `502` (agent turn failed outright, or a WhatsApp send failed), `503` (`/v1/notify` while WhatsApp is not connected), `500` (internal; message hidden, logged server-side).
- **`chatKey`:** 1–128 chars of `[A-Za-z0-9._:@-]`. Pick one per Ghina user (e.g. their user id). The engine maps it to a synthetic chat `http:<chatKey>`, so each key has its own Claude session, transcript and reminders, while all keys share one workspace — and therefore one memory. A digits-only key never collides with a WhatsApp chat or owner number.
- **`wa:<number>` chatKey — the shared conversation.** A key of the form `wa:6281234567890` is *not* a separate HTTP chat: it is the owner's own WhatsApp DM. It is allowed only when `<number>` (digits only) is in the `OWNER_NUMBERS` of `HTTP_ACCOUNT`; anything else is `403 {"error":"chatKey wa: hanya untuk nomor owner"}` on every endpoint that takes a chatKey. The key maps to the same chat id the WhatsApp DM uses (`<number>@s.whatsapp.net#<number>`), so:
  - session, transcript (`/v1/chat/history`), `/model` choice and reminders are **one** conversation across WhatsApp and Ghina — a `/new` on either side resets both;
  - turns are serialized on one queue across both channels: a Ghina message sent while a WhatsApp turn is running waits for it, and vice versa;
  - the turn runs in the DM's workspace (the owner's `CONTACT_WORKSPACES` persona if mapped, else the account's), **not** `HTTP_WORKSPACE`;
  - reminders scheduled from Ghina are filed under the owner's number and DM jid, so they are listed by `/reminders` on WhatsApp and **fire on WhatsApp** like any DM reminder;
  - the reply still comes back in the HTTP response only — nothing is pushed to WhatsApp for an HTTP turn.

  DMs are filed under the phone-number jid even when WhatsApp delivers them on a `@lid` jid; older `@lid`-keyed state is migrated once at startup.

## Endpoints

### `POST /v1/chat`

Run one agent turn and wait for the reply.

```json
{ "chatKey": "user-42", "text": "ringkas catatan hari ini", "model": "sonnet" }
```

| Field | | |
|---|---|---|
| `chatKey` | required | see above |
| `text` | required | non-empty. Slash commands work as on WhatsApp: `/model`, `/reminders`, `/cancel <id>`, `/new`, `/usage`. |
| `model` | optional | model for **this turn only** (alias or full id, `[A-Za-z0-9._[]-]`). Not stored, not probed — an invalid name surfaces as an agent error reply. Without it the chat's `/model` choice (or the CLI default) applies. |
| `media` | optional | up to **3** attachments: `[{ "name": "foto.png", "mimeType": "image/png", "dataBase64": "…" }]`. With media, `text` may be `""`. |

**Media in.** Each item is checked before anything is saved: `mimeType` (parameters like `; charset=` ignored) must be one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/aac`, `audio/ogg`, `audio/opus`, `audio/wav`, `audio/x-wav`, `audio/webm` (else `415`); `dataBase64` must be plain standard base64, no `data:` prefix (else `400`); each item at most **8 MB decoded** and at most 3 items (else `413`). `name` is optional and sanitized to a bare filename. Files are saved to `STATE_DIR/media` the same way WhatsApp media is (`in-<ms>-<i>.<ext>` for images, `in-<ms>-<i>-<name>` otherwise) and the prompt tells the agent each path exactly as it does for WhatsApp media (images: "baca file itu"; documents: read it / pandoc; audio: transcribe if it has a tool, else say so).

`200`:

```json
{ "reply": "Ini ringkasannya…", "attachments": ["/home/killa/.killa/workspaces/main/out/ringkasan.pdf"] }
```

- `reply` — the agent's text with `[[send:]]` / `[[remind:]]` markers stripped, **not** split into WhatsApp-sized chunks. Engine notices (reminder confirmations `⏰ Diingetin: …`, a failed attachment) follow, separated by a blank line.
- `attachments` — present only when non-empty: paths the agent asked to send with `[[send:<path>]]` that exist on disk. Paths as the agent wrote them (usually absolute, inside the workspace). The file is **not** inlined; read it from disk (same machine).
- The call blocks for the whole agent run — up to `AGENT_TIMEOUT_SECONDS` (default 300 s), plus any turn already running for the same `chatKey` (turns are serialized per chat, exactly like WhatsApp). Set the client timeout to at least `AGENT_TIMEOUT_SECONDS + 60 s`. On agent timeout the reply is the engine's usual "kelamaan mikir" text with status `200`.
- `502 {"error":"agent gagal menjawab"}` only if the turn threw before producing anything.

**Reminders.** `[[remind:<spec>|<text>]]` is parsed and scheduled exactly as on WhatsApp, filed under `http:<chatKey>`, and listed by `/reminders` or `GET /v1/reminders`. The HTTP channel is request/response only, so when a plain HTTP chat's reminder fires the engine logs it and sends nothing; poll `GET /v1/reminders` to surface them. A `wa:<number>` chat's reminders fire on WhatsApp (see above).

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

A message the engine sent on its own through `POST /v1/notify` with `remember: true` appears as `{ "at": …, "who": "agent", "text": "…", "kind": "notice" }`; `kind` is absent on every other line, so an old client simply shows it as an agent message.

This is the engine's session-briefing log, not a message archive: at most **20 lines** per chat, each **truncated to 240 chars** with whitespace collapsed, cleared by `/new`. `at` is epoch milliseconds. Ghina should keep its own full history if it needs one.

### `GET /v1/reminders?chatKey=<key>`

The chat's scheduled reminders, soonest first — the same list `/reminders` shows. For a `wa:<number>` key that is every reminder filed under that owner number (including ones scheduled on WhatsApp).

```json
{ "reminders": [
  { "id": 7, "spec": "daily 07:00", "text": "minum obat", "nextAt": 1790121600000 }
] }
```

`nextAt` is epoch milliseconds. `spec` is as the agent wrote it (`TIMEZONE` applies).

### `POST /v1/reminders/cancel`

Same as `/cancel <id>`.

```json
{ "chatKey": "user-42", "id": 7 }
```

`200 {"ok": true}` when cancelled, `200 {"ok": false}` when that chat has no reminder with that id (already fired, cancelled, or another chat's — a chatKey can never cancel someone else's). `id` must be a positive integer (`400`).

### `GET /v1/model?chatKey=<key>`

The chat's saved model choice (the same one `/model` shows and sets) and the names `/model` offers.

```json
{ "model": "opus", "options": ["default", "fable", "opus", "sonnet", "haiku"] }
```

`model` is `null` when the chat uses the default. `options` is `default` plus the aliases discovered from this machine's `claude --help` (falls back to `fable, opus, sonnet, haiku`). It is a suggestion list, not the full set: any full model id is accepted too. For a `wa:<number>` key this is the WhatsApp DM's choice.

### `POST /v1/model`

Same as `/model <name>`. Persists across `/new`, and applies to every later turn of that chat (a `model` on `POST /v1/chat` still overrides it for one turn).

```json
{ "chatKey": "user-42", "model": "sonnet" }
```

`200 {"ok": true, "model": "sonnet"}`. The name is lowercased. `"default"` clears the choice and returns `{"ok": true, "model": null}` without asking Claude. Any other name (alias or full id such as `claude-opus-5-5[1m]`) is saved only after a quick probe run of `claude --model <name>` succeeds, so the call can take a few seconds (up to 60 s). A rejected name is `400 {"error": "<claude's message>"}` and the old choice stays. `model` must be 1–100 chars of `[A-Za-z0-9._[]-]` (`400 model tidak valid`).

### `GET /v1/media?path=<path>`

Stream a file the agent produced — typically a path from `attachments` — so Ghina can render it inline. Response is the raw file with `Content-Type` from its extension (images, pdf, office, text with `charset=utf-8`, audio; anything else, `.html`/`.svg` included, is `application/octet-stream`), `Content-Length`, and `X-Content-Type-Options: nosniff`.

- `path` is absolute (as `attachments` returns it) or relative to `HTTP_WORKSPACE`.
- Served only from inside: `HTTP_WORKSPACE`, the workspace of each owner of `HTTP_ACCOUNT` (where `wa:` turns run), and `STATE_DIR/media`. Same rigor as workspace reads: `..` segments, NUL bytes and hidden segments (`.git`, `node_modules`, `.env*`) → `400`; the path is checked lexically and again after `realpath`, so a symlink that points outside (or onto `.env`) → `400`.
- `404` missing, `400` directory, `413` over **15 MB**.

### `GET /v1/usage?days=<n>`

Token and cost accounting for every agent run (all chats, WhatsApp and HTTP, memory flushes included) over the last `n` local days including today (default 7, max 90; `TIMEZONE` decides where a day starts). Figures are what `claude -p --output-format json` reports; `costUsd` is the CLI's estimate (`total_cost_usd`), not a bill — on a subscription it is notional.

```json
{
  "entries": [
    { "at": 1790000000000, "chatId": "6281234567890@s.whatsapp.net#6281234567890", "model": "claude-sonnet-4-5",
      "inputTokens": 12, "outputTokens": 340, "cacheReadTokens": 45000, "cacheCreationTokens": 1200,
      "costUsd": 0.031, "durationMs": 8123 }
  ],
  "since": 1789923600000,
  "days": [ { "date": "2026-10-01", "turns": 1, "inputTokens": 12, "outputTokens": 340,
              "cacheReadTokens": 45000, "cacheCreationTokens": 1200, "costUsd": 0.031 } ],
  "byModel": { "claude-sonnet-4-5": { "turns": 1, "inputTokens": 12, "outputTokens": 340,
                                       "cacheReadTokens": 45000, "cacheCreationTokens": 1200, "costUsd": 0.031 } },
  "total": { "turns": 1, "inputTokens": 12, "outputTokens": 340, "cacheReadTokens": 45000,
             "cacheCreationTokens": 1200, "costUsd": 0.031 }
}
```

- `days` has one row per day in the window, oldest first, zero rows included.
- `model` is the model that cost the most in that run (from the CLI's `modelUsage`), else the chat's chosen model, else `"default"`. Token counts sum every model the run touched.
- Stored in `STATE_DIR/usage.json`, pruned to the last 90 days on every write. `/usage` in chat shows today and the last 7 days.

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

### `PUT /v1/workspace/file`

Write a UTF-8 text file (create or overwrite). Parent directories are created as needed.

```json
{ "path": "memory/2026-10-01.md", "content": "…" }
```

`200 {"ok": true, "path": "memory/2026-10-01.md"}` (the `path` you sent).

- `path` required, non-empty string; `content` required, string (`""` makes an empty file).
- `413` if `content` is over **512 KB** (UTF-8 bytes). Note: reads stop at 256 KB, so a file written between 256 and 512 KB cannot be read back over `GET /v1/workspace/file`. The 1 MB body cap also applies (JSON escaping counts), also `413`.
- `400` for a directory target, and for anything the path rules below refuse. Writes are refused **anywhere under `.git/`** (and `node_modules/`, `.env*`), case-insensitively, since `.GIT/config` is `.git/config` on macOS.
- Symlinks: the deepest existing ancestor of the target is realpath'd and must be inside the workspace (and not inside `.git` etc.). An existing symlink target is written through only if it resolves inside; a dangling symlink is refused (writing would create a file wherever it points).

### `DELETE /v1/workspace/file?path=<rel>`

Delete one file. `200 {"ok": true}`. `path` required; `404` if missing; `400` for a directory (never recursive) or a refused path. A symlink is removed itself — its target is never touched.

**Path rules (all file endpoints):** absolute paths, any `..` segment, NUL bytes, and any segment naming a hidden entry (`.git`, `node_modules`, `.env*`) → `400`. The resolved path — and its realpath, so a symlink cannot escape — must stay inside the workspace, else `400`.

### `GET /v1/git/log?limit=<n>`

`git log` in the workspace (default 20, max 200).

```json
{ "commits": [
  { "hash": "3f2a…", "date": "2026-09-30T10:12:00+07:00", "author": "Killa", "subject": "memory: catatan harian" }
] }
```

`date` is ISO 8601 author date. Not a git repo, no `git` binary, or git taking over 10 s → `{"commits": []}`. Run via `spawn` with an argument array; no shell.

### `POST /v1/git/commit`

Stage everything and commit: `git add -A`, then `git commit -m <message>`.

```json
{ "message": "memory: catatan harian" }
```

`message` optional (string); missing, `null` or blank → `"update via ghina"`. Non-string or containing a NUL byte → `400`.

| Result | Response |
|---|---|
| committed | `200 {"ok": true, "hash": "<40-hex HEAD>"}` |
| nothing to commit | `200 {"ok": true, "hash": null, "clean": true}` |
| workspace is not a git repo | `400 {"error": "workspace bukan repo git"}` |
| git failed (no `user.name`/`user.email`, hook rejected, timeout 30 s, …) | `500`, git's stderr logged server-side |

- The workspace must be the repo's **top level**. If it is only a subdirectory of some other repo, that is also `400` — otherwise `add -A` would stage the parent repo's files.
- Every git call is `spawn('git', [...args])` with an argument array; the message is one argv element and never reaches a shell. Hooks and signing follow the repo's own git config.
- Commits are serialized per server: concurrent requests run one after another (the later one usually gets `clean: true`).

### `POST /v1/notify`

Push one plain WhatsApp message to the owner — for app alerts (an urgent email, a digest). This is **not** a chat: no session, transcript, queue, model choice or reminder is read or written, no agent turn runs, and nothing is mirrored. A reply from the owner is an ordinary DM, handled like any other.

```json
{ "text": "🔴 *Denda ETLE — Korlantas*\nbayar sebelum 25 Okt.", "to": "6281234567890",
  "remember": true, "ref": "email:18f2c0a9" }
```

- `text` — required, trimmed, at most **4,000** characters after trimming. Sent as-is (WhatsApp markdown works), in one message.
- `to` — optional. Defaults to the **first** `OWNER_NUMBERS` entry of `HTTP_ACCOUNT`; if given, it must be one of that account's owners (non-digits are stripped, so `+62 812…` is fine). Anything else → `400`.
- Sent through `HTTP_ACCOUNT`'s WhatsApp socket to the owner's DM jid (`<number>@s.whatsapp.net`).
- `remember` — optional boolean (default `false`). See below.
- `ref` — optional string, ≤ 200 chars, e.g. `email:<id>`, so the agent can look the details up. Only used with `remember`.
- `200 {"sent": true, "id": "<WhatsApp message id>"}` (`id` omitted if the socket returned none; `"remembered": true` added when it was filed).
- `503 {"error": "wa_not_connected"}` when that account's socket is not open (reconnecting, logged out, not paired yet). Nothing is queued — retry later.
- `502 {"error": "wa_send_failed"}` when the socket threw mid-send.
- `429 {"error": "rate_limited"}` past **30 sends per sliding minute** (per process). Rejected bodies (`400`) don't count.
- One log line per attempt: recipient number, length and message id — never the text.

**`remember: true` — the owner's conversation knows what was sent.** Only after a successful send, the notice is filed into the owner's DM conversation: the same state the WhatsApp DM and a `wa:<number>` HTTP chat share (`<number>@s.whatsapp.net#<number>`). Still no agent run, no session, no queue.

- **Pending note** `{at, text, ref?}` — `text` truncated to 1,000 chars. Persisted in `STATE_DIR/pending-notices.json` (survives a restart). At most **20** per chat (oldest dropped); notes older than **7 days** expire unseen.
- **On the owner's next agent turn in that conversation** — a WhatsApp DM message, or `POST /v1/chat` with `chatKey: "wa:<number>"` — every pending note is put in front of the message, once, then dropped:

  ```
  [Konteks — notifikasi yang Killa kirim sejak obrolan terakhir (bukan pesan dari pengguna):
  - Sab 18 Okt, 21:05 · 🔴 *Denda ETLE — Korlantas* … (ref email:18f2c0a9)
  - Sab 18 Okt, 22:40 · Tagihan PLN …]

  [Sab 18 Okt 2026, 22:41 WIB] itu dendanya kapan jatuh tempo?
  ```

  On a fresh session it comes after the usual briefing. Notes are dropped only once the turn's agent run succeeded; a failed turn leaves them for the next one. Any other chatKey (`email-triage`, `email-cron`, `user-42`, …) never sees them. Slash commands (`/model`, `/reminders`, `/usage`, `/cancel`) don't consume them; `/new` (either side) clears them.
- **Transcript line** `{who: "agent", kind: "notice"}` in the conversation's transcript — so it shows in `GET /v1/chat/history?chatKey=wa:<number>` and, labelled *Kamu (notifikasi)*, in the briefing of a fresh session. Same 240-char cap as every transcript line.
- **Mirror copy** — if the mirror hook is on, one `{"channel":"wa","number":…,"messages":[{"role":"assistant","text":…,"at":…,"kind":"notice"}]}` POST, so Ghina can show it in the WhatsApp side of the conversation. Ghina is usually the sender too: treat `kind: "notice"` as something it may already have and de-duplicate.

```bash
curl -s -H "Authorization: Bearer $HTTP_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"🔴 *Email penting*\nCek inbox Ghina."}' http://127.0.0.1:8787/v1/notify
# {"sent":true,"id":"3EB0C4…"}
```

## Mirror hook (WhatsApp → Ghina)

So Ghina can show the WhatsApp side of a `wa:` conversation, the engine can POST a copy of every completed WhatsApp owner-DM turn to Ghina. Off unless `MIRROR_URL` is set (and then `MIRROR_TOKEN` is required — see [configuration.md](configuration.md#mirror-hook-optional)).

```
POST <MIRROR_URL>
Authorization: Bearer <MIRROR_TOKEN>
Content-Type: application/json

{ "channel": "wa", "number": "6281234567890",
  "messages": [ { "role": "user",      "text": "ingetin jam 7 minum obat", "at": 1790000000000 },
                { "role": "assistant", "text": "Siap!",                     "at": 1790000004000 } ] }
```

- Sent after the reply has gone out on WhatsApp. `user.text` is the inbound text (or `[gambar]` / `[<filename>]` for a file without caption); `assistant.text` is the reply with `[[send:]]`/`[[remind:]]` markers stripped (engine notices like `⏰ Diingetin` are not included). `at` is epoch ms.
- One exception to "a turn": a `POST /v1/notify` with `remember: true` sends a single `assistant` message with `"kind": "notice"` (see that endpoint).
- Only agent turns in an owner's **DM**. Not mirrored: slash commands, group chats, and every HTTP-channel turn — including `wa:` turns, which Ghina already has.
- Fire-and-forget: 10 s timeout, no retry, no queue. A failure (unreachable, timeout, non-2xx) is one log line; it never delays or breaks the WhatsApp reply. Ghina should treat it as best-effort and de-duplicate if it needs to.

## Security notes

- Bind stays on `127.0.0.1` unless you have a reason; if Ghina runs on another host, put a TLS reverse proxy in front rather than binding publicly.
- The token is the whole boundary. Whoever holds it can make the agent — which runs with `--dangerously-skip-permissions` in the workspace — do anything the engine's OS user can. Keep it server-side in Ghina (never in client JS), and treat every Ghina user who can reach `/v1/chat` as someone you'd hand the workspace to. Point `HTTP_WORKSPACE` at a dedicated workspace if they shouldn't see your personal memory.
- The WhatsApp owner check does not apply here; the token replaces it. A `wa:<number>` key is still limited to owner numbers, but anyone holding the token can read and write the owner's WhatsApp conversation through it (history, reminders, turns in the owner's workspace). Ghina must map a `wa:` key only to the owner's own Ghina account.
- `/v1/notify` lets the token holder message the owner's WhatsApp — only the owner numbers of `HTTP_ACCOUNT`, never anyone else, at most 30 a minute. It is the one engine-initiated send besides reminders; keep the volume low (WhatsApp bans accounts for spammy outbound, even to a single number).
- `/v1/media` serves only from the allowed roots, but everything inside them — the owner's workspace included — is readable by the token holder.
