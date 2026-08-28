/**
 * agent.js — the bridge to Claude Code.
 *
 * One function: give it a message, get a reply. Everything else — tools,
 * memory, file access, skills — is Claude Code's job. That's the whole
 * point of this project: we don't build an agent runtime, we borrow one.
 *
 * Sessions: `claude -p --output-format json` returns a session_id; passing
 * it back via --resume continues the same conversation with full context.
 */

const { spawn } = require('child_process')

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

/**
 * Run one agent turn.
 *
 * @param {object} opts
 * @param {string} opts.text       user message
 * @param {string|null} opts.sessionId  resume this session, or null for fresh
 * @param {string} opts.workspace  cwd for the run (the agent's world)
 * @param {number} opts.timeoutMs
 * @param {string} [opts.model]    model alias/id to pass via --model
 * @returns {Promise<{reply: string, sessionId: string|null}>}
 */
function runAgent({ text, sessionId, workspace, timeoutMs, model }) {
    return new Promise((resolve) => {
        const args = ['-p', text, '--output-format', 'json']
        if (model) args.push('--model', model)

        // Headless run: nobody is there to approve tool calls. The workspace
        // is the blast radius — point WORKSPACE_DIR somewhere you trust the
        // agent to act in, and nowhere you don't.
        args.push('--dangerously-skip-permissions')

        if (sessionId) args.push('--resume', sessionId)

        const child = spawn(CLAUDE_BIN, args, {
            cwd: workspace,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let out = ''
        let err = ''
        let done = false

        const timer = setTimeout(() => {
            if (done) return
            done = true
            child.kill('SIGKILL')
            resolve({ reply: '⏱️ Kelamaan mikir — coba tanya lagi.', sessionId })
        }, timeoutMs)

        child.stdout.on('data', c => { out += c })
        child.stderr.on('data', c => { err += c })

        child.on('error', (e) => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve({ reply: `⚠️ Gagal menjalankan agent: ${e.message}`, sessionId })
        })

        child.on('close', (code) => {
            if (done) return
            done = true
            clearTimeout(timer)

            try {
                const parsed = JSON.parse(out)
                const reply = (parsed.result || '').trim()
                resolve({
                    reply: reply || '🤔 (agent selesai tanpa jawaban)',
                    sessionId: parsed.session_id || sessionId,
                })
            } catch (e) {
                // A dead --resume target is the common failure here; the caller
                // clears the session so the next message starts fresh.
                console.error(`agent exit ${code}: ${err.slice(0, 500)}`)
                resolve({
                    reply: '⚠️ Sesi agent bermasalah — pesan berikutnya mulai sesi baru.',
                    sessionId: null,
                })
            }
        })
    })
}

module.exports = { runAgent }
