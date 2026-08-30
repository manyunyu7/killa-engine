# Deploying to a VPS

A laptop agent sleeps when the laptop does. A $5 VPS makes it 24/7. Anything that runs Node 22 works.

## 1. Node 22

Baileys 7 needs Node 22+. If the box's system Node is older (common — distro packages lag), use nvm and leave system Node alone:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22
```

## 2. Claude Code, headless

The CLI's normal login opens a browser the VPS doesn't have. Instead:

```bash
# on your LAPTOP (has a browser):
claude setup-token          # prints a long-lived auth token

# on the VPS:
npm install -g @anthropic-ai/claude-code
claude                      # choose the token/paste option, paste it
claude -p "say ok"          # verify before going further
```

This uses your existing Claude subscription — same account, no API key, no separate bill.

## 3. Dedicated user (recommended)

The agent runs with permissions skipped ([security.md](security.md)), so give it a small home:

```bash
sudo useradd -m -s /bin/bash killa
sudo -iu killa
# repeat nvm + claude setup as this user, then:
git clone https://github.com/<you>/killa-engine && cd killa-engine
npm install && npm run setup
```

## 4. The workspace

A fresh VPS has no workspace, and the engine refuses to start without one. Two ways in.

### Starting fresh

`npm run setup` (step 3) already did it. Workspaces live in one place the engine owns:

```
/home/killa/
├── killa-engine/          code — clone, pull, delete at will
│   ├── .env               this instance's config
│   ├── sessions/          WhatsApp credentials (= being logged in)
│   └── state/             chat sessions, reminders, media
└── .killa/workspaces/
    ├── main/              ← WORKSPACE=main
    └── kerja/             ← WORKSPACE_KERJA=kerja
```

The separation matters: workspaces sit outside the engine checkout, so `git pull` on the code can never touch the agent's memory, and `rm -rf killa-engine` costs you nothing but a clone.

```bash
npm run workspace              # what exists, and which account uses which
npm run workspace new kerja    # scaffold another
```

### Bringing an existing workspace

If your agent already lives in a folder — from a laptop, from OpenClaw, from another box — do **not** scaffold. Put the folder on the VPS and point at it:

```bash
# a git repo — clone straight into the managed root:
git clone git@github.com:<you>/<workspace>.git ~/.killa/workspaces/main

# not a repo:
rsync -av --exclude .env ~/my-workspace/ killa@vps:~/.killa/workspaces/main/
```

Then `WORKSPACE=main` in `.env`. Prefer to keep it where it already is (a repo you also work on directly)? Point `WORKSPACE` at the absolute path instead — that stays supported, and `npm run workspace` lists it as `di luar root`.

Nothing else is needed: an OpenClaw workspace (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `memory/`) drops in unchanged — only `CLAUDE.md` is auto-loaded, the rest is whatever `CLAUDE.md` tells the agent to read. Two things do not survive the trip, and both bite silently:

- **`HEARTBEAT.md` does nothing here.** killa-engine has no scheduler; the only timed outbound is [reminders](configuration.md#reminders). If your workspace relied on OpenClaw's cron, that behavior is gone.
- **Private repo, no keys.** A VPS clone needs a deploy key or a PAT. And if the agent is supposed to `git push` its own memory, give it an identity (`git config user.name/user.email`) and a credential helper, or its commits pile up locally forever.

Check the size before cloning: a workspace with months of memory and a `.git` full of media can be hundreds of MB, and that all sits on a $5 box's disk.

### More than one person

Adding a number to `OWNER_NUMBERS` gives that person **your** workspace: the same persona, the same `MEMORY.md`, the same `USER.md`. Right for your own second phone, wrong for anyone else.

For a real second user, give them their own account — same process, separate everything that matters:

```env
ACCOUNTS=main,rere
WORKSPACE=main
OWNER_NUMBERS=628111...

WORKSPACE_RERE=rere              # npm run workspace new rere
OWNER_NUMBERS_RERE=628222...     # only they can talk to it
```

Pair a second WhatsApp number for `rere` (`qr-rere.png`) and it runs its own persona and memory, with per-chat Claude sessions as always. One process, one `npm install`, one pm2 entry.

A separate *instance* is only needed when the two must not share a machine account at all — different `claude` login, different OS user, different disk quota. Then it's a second clone with its own `SESSION_DIR`, `STATE_DIR` and pm2 name.

| | Extra `OWNER_NUMBERS` | Extra account | Separate instance |
|---|---|---|---|
| Your second phone | ✅ | overkill | overkill |
| A family member | ❌ shares your memory | ✅ | overkill |
| A second persona for you | ❌ | ✅ | overkill |
| Different Claude login / isolation | ❌ | ❌ | ✅ |

## 5. Keep it alive: pm2

```bash
npm install -g pm2
cd ~/killa-engine
pm2 start src/main.ts --name killa-engine --time \
    --interpreter "$(nvm which 22)"     # pin the right Node
pm2 save
pm2 startup    # run the command it prints, once, to survive reboots
```

`--interpreter` matters when system Node ≠ nvm Node: pm2 resurrection after reboot uses whatever interpreter was recorded, and Baileys crashes confusingly on Node 18.

## 6. Pair

```bash
pm2 logs killa-engine
```

The ASCII QR is usually mangled by pm2's log prefixes — that's why the engine also writes `qr-main.png`:

```bash
# from your laptop:
scp vps:~/killa-engine/qr-main.png . && open qr-main.png
```

Scan it with the agent's phone. `TERHUBUNG sebagai <number>` in the logs means you're live; the PNG is deleted automatically once connected.

## 7. Ongoing

- **Updates:** `git pull && npm install && pm2 restart killa-engine`. Sessions and state survive restarts.
- **Re-pairing:** only needed if WhatsApp logs the device out (the engine wipes the dead session and shows a fresh QR; set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `.env` to get pinged when this happens).
- **Timezone:** set `TIMEZONE=Asia/Jakarta` in `.env` — reminders and the agent's sense of "today" follow it, whatever the VPS clock is set to. The startup log prints the zone it resolved; check it once after deploying.
- **Watch usage.** Every message is a real agent run against your subscription quota. Personal chat volume is fine; don't wire it into anything high-frequency.

## Coexisting with other Baileys services

Multiple Baileys processes on one box are fine (each owns its own `sessions/` dir and number), but never point two processes at the **same** session dir or pair the same number twice — the second login kills the first. One number, one process, one dir.
