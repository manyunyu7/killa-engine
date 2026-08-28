# Security Model

Honest version: **this runs an unattended agent with real tool access, gated by WhatsApp sender identity.** Read this page before deploying.

## Trust boundaries

```
 UNTRUSTED                 │  TRUSTED
 anyone on WhatsApp ───────┤  OWNER_NUMBERS senders
                           │  the workspace
                           │  the claude CLI + your Claude account
                           │  the host the engine runs on
```

Three layers, from outside in:

### 1. Who gets in: the owner whitelist

Every inbound message resolves to a phone number first (LID → real number); if resolution fails or the number isn't in `OWNER_NUMBERS`, the message is dropped **silently**. No reply, no "unauthorized" — an outsider can't even confirm the bot exists.

WhatsApp numbers are a reasonable identity: registering one requires a SIM, and spoofing a sender number isn't a thing the WhatsApp protocol offers. The realistic compromise path is someone with your unlocked phone — at which point they are you for most purposes anyway.

### 2. What a message can do: everything

This is the sharp edge. The agent runs with `--dangerously-skip-permissions`, because a headless run has nobody to approve tool calls. A whitelisted message can make the agent read, write, execute, and network **as the OS user running the engine** — the workspace boundary in `CLAUDE.md` is an instruction the model follows, *not* a sandbox.

Mitigations, in order of how much they actually help:

1. **Whitelist only numbers you personally hold.** The whole model rests here.
2. **Dedicated OS user.** Create a `killa` user that owns the workspace and the engine dir and nothing else; run the engine (and thus every `claude` child) as that user. Now "everything" means "everything a nobody-user can do."
3. **Don't feed it hostile text.** If you paste content from strangers into the chat ("summarize this email"), you're carrying prompt-injection across the trust boundary yourself. For a personal agent this is a judgment call you make per message.
4. **Point the workspace somewhere you can lose.** And keep it in git, so even a bad write is one `git checkout` away from undone.

### 3. What can leak: the credentials on disk

| Path | What it really is | If stolen |
|---|---|---|
| `sessions/` | WhatsApp login, full stop | Attacker **is** the agent's number: reads its chats, messages as it |
| `~/.claude` of the running user | Claude account credentials | Attacker spends your subscription, reads that user's Claude Code history |
| `state/chat-sessions.json` | Session id ↔ number map | Low value alone |
| The workspace | Your agent's memory of your life | As sensitive as what you told it |

`sessions/`, `.env`, and `state/` are gitignored. Keep the workspace a **private** repo if you version it (you should). Nothing in this project phones home; the only outbound connections are WhatsApp's servers, Anthropic's API (via the CLI), and optionally the Telegram alert.

## Anti-ban posture (availability is security too)

A banned number is a dead agent. Inherited rules from a gateway that *did* get a predecessor banned:

- **Reply-only.** No code path initiates a conversation. Scheduled/proactive features must use a different channel (Telegram, ntfy) — resist the temptation.
- **Spare number.** If the worst happens, you lose a SIM's worth of identity, not your personal number.
- One linked-device session per account dir; don't share the number with other tooling.

## Reporting

Found a hole? Open a private report, not a public issue, until there's a fix.
