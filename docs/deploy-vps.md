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

## 4. Keep it alive: pm2

```bash
npm install -g pm2
cd ~/killa-engine
pm2 start src/index.js --name killa-engine --time \
    --interpreter "$(nvm which 22)"     # pin the right Node
pm2 save
pm2 startup    # run the command it prints, once, to survive reboots
```

`--interpreter` matters when system Node ≠ nvm Node: pm2 resurrection after reboot uses whatever interpreter was recorded, and Baileys crashes confusingly on Node 18.

## 5. Pair

```bash
pm2 logs killa-engine
```

The ASCII QR is usually mangled by pm2's log prefixes — that's why the engine also writes `qr-main.png`:

```bash
# from your laptop:
scp vps:~/killa-engine/qr-main.png . && open qr-main.png
```

Scan it with the agent's phone. `TERHUBUNG sebagai <number>` in the logs means you're live; the PNG is deleted automatically once connected.

## 6. Ongoing

- **Updates:** `git pull && npm install && pm2 restart killa-engine`. Sessions and state survive restarts.
- **Re-pairing:** only needed if WhatsApp logs the device out (the engine wipes the dead session and shows a fresh QR; set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `.env` to get pinged when this happens).
- **Timezone:** `sudo timedatectl set-timezone Asia/Jakarta` — the agent's sense of "today" comes from the box.
- **Watch usage.** Every message is a real agent run against your subscription quota. Personal chat volume is fine; don't wire it into anything high-frequency.

## Coexisting with other Baileys services

Multiple Baileys processes on one box are fine (each owns its own `sessions/` dir and number), but never point two processes at the **same** session dir or pair the same number twice — the second login kills the first. One number, one process, one dir.
