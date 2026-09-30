import { describe, expect, it } from 'vitest'
import { dmJid, forAccountConfig, isGroupJid, isWorkspaceName, parseConfig, resolveWorkspace, routeForChat, workspaceFor } from '../src/config.ts'

const base = { WORKSPACE_DIR: '/ws', OWNER_NUMBERS: '628111' }


describe('parseConfig', () => {
    it('fills sensible defaults', () => {
        const { config, errors } = parseConfig(base, '/root')
        expect(errors).toEqual([])
        expect(config.accounts).toEqual(['main'])
        expect(config.sessionDir).toBe('/root/sessions')
        expect(config.stateDir).toBe('/root/state')
        expect(config.mediaDir).toBe('/root/state/media')
        expect(config.sessionIdleMs).toBe(180 * 60_000)
        expect(config.agentTimeoutMs).toBe(300_000)
        expect(config.remindersMaxPerDay).toBe(20)
        expect(config.telegram).toBeNull()
    })

    it('strips non-digits and blanks from owner numbers', () => {
        const { config } = parseConfig({ ...base, OWNER_NUMBERS: ' +62 811-1 , ,628222 ' }, '/root')
        expect(config.ownerNumbers).toEqual(['628111', '628222'])
    })

    it('splits accounts and trims them', () => {
        const { config } = parseConfig({ ...base, ACCOUNTS: 'main, kerja ,' }, '/root')
        expect(config.accounts).toEqual(['main', 'kerja'])
    })

    it('honours custom directories', () => {
        const { config } = parseConfig({ ...base, STATE_DIR: '/data', SESSION_DIR: '/creds' }, '/root')
        expect(config.stateDir).toBe('/data')
        expect(config.mediaDir).toBe('/data/media')
        expect(config.sessionDir).toBe('/creds')
    })

    it.each([
        ['SESSION_IDLE_MINUTES', 'abc', 'sessionIdleMs', 180 * 60_000],
        ['SESSION_IDLE_MINUTES', '0', 'sessionIdleMs', 180 * 60_000],
        ['SESSION_IDLE_MINUTES', '-5', 'sessionIdleMs', 180 * 60_000],
        ['AGENT_TIMEOUT_SECONDS', '', 'agentTimeoutMs', 300_000],
        ['REMINDERS_MAX_PER_DAY', 'x', 'remindersMaxPerDay', 20],
    ])('falls back when %s is %s', (key, value, field, expected) => {
        const { config } = parseConfig({ ...base, [key]: value }, '/root')
        expect(config[field as 'sessionIdleMs']).toBe(expected)
    })

    it('accepts valid numeric overrides', () => {
        const { config } = parseConfig({ ...base, SESSION_IDLE_MINUTES: '5', AGENT_TIMEOUT_SECONDS: '60' }, '/root')
        expect(config.sessionIdleMs).toBe(300_000)
        expect(config.agentTimeoutMs).toBe(60_000)
    })

    it('requires both Telegram values before enabling alerts', () => {
        expect(parseConfig({ ...base, TELEGRAM_BOT_TOKEN: 't' }, '/root').config.telegram).toBeNull()
        expect(parseConfig({ ...base, TELEGRAM_CHAT_ID: 'c' }, '/root').config.telegram).toBeNull()
        expect(parseConfig({ ...base, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' }, '/root').config.telegram)
            .toEqual({ token: 't', chat: 'c' })
    })

    it('reports a missing workspace', () => {
        expect(parseConfig({ OWNER_NUMBERS: '628111' }, '/root').errors[0]).toContain('WORKSPACE wajib diisi')
    })

    it('reports a workspace that does not exist on disk', () => {
        const { errors } = parseConfig(base, '/root', () => false)
        expect(errors[0]).toContain('tidak ditemukan')
    })

    it('reports missing owners — without which the agent is unreachable', () => {
        const { errors } = parseConfig({ WORKSPACE_DIR: '/ws' }, '/root')
        expect(errors.join()).toContain('OWNER_NUMBERS')
    })

    it('reports every problem at once instead of one per run', () => {
        expect(parseConfig({}, '/root').errors).toHaveLength(2)
    })
})

describe('workspace resolution', () => {
    const home = '/home/killa'
    const root = `${home}/.killa/workspaces`

    it('puts a bare name under the managed root', () => {
        const { config } = parseConfig({ WORKSPACE: 'kerja', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspacesDir).toBe(root)
        expect(config.workspaceDir).toBe(`${root}/kerja`)
    })

    it('honours an absolute path as given', () => {
        const { config } = parseConfig({ WORKSPACE: '/srv/ws', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspaceDir).toBe('/srv/ws')
    })

    it('expands ~ in a workspace reference', () => {
        const { config } = parseConfig({ WORKSPACE: '~/ws', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspaceDir).toBe(`${home}/ws`)
    })

    it('lets WORKSPACE_DIR win over WORKSPACE, so old installs keep working', () => {
        const { config } = parseConfig(
            { WORKSPACE: 'kerja', WORKSPACE_DIR: '/legacy/path', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspaceDir).toBe('/legacy/path')
    })

    it('moves the root when WORKSPACES_DIR says so', () => {
        const { config } = parseConfig(
            { WORKSPACE: 'kerja', WORKSPACES_DIR: '~/ws-root', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspaceDir).toBe(`${home}/ws-root/kerja`)
    })

    it('rejects a name that would escape the root', () => {
        const { config } = parseConfig(
            { WORKSPACE: '../../etc', OWNER_NUMBERS: '628111' }, '/root', () => true, home)
        expect(config.workspaceDir).not.toContain(`${root}/..`)
    })

    it('complains when nothing is configured at all', () => {
        expect(parseConfig({ OWNER_NUMBERS: '628111' }, '/root', () => true, home).errors[0])
            .toContain('WORKSPACE wajib diisi')
    })
})

describe('per-account overrides', () => {
    const home = '/home/killa'
    const root = `${home}/.killa/workspaces`
    const base = { ACCOUNTS: 'main,kerja', WORKSPACE: 'utama', OWNER_NUMBERS: '628111' }

    it('gives an account its own workspace', () => {
        const { config } = parseConfig({ ...base, WORKSPACE_KERJA: 'kantor' }, '/root', () => true, home)
        expect(forAccountConfig(config, 'kerja').workspaceDir).toBe(`${root}/kantor`)
        expect(forAccountConfig(config, 'main').workspaceDir).toBe(`${root}/utama`)
    })

    it('gives an account its own owners', () => {
        const { config } = parseConfig({ ...base, OWNER_NUMBERS_KERJA: '628999' }, '/root', () => true, home)
        expect(forAccountConfig(config, 'kerja').ownerNumbers).toEqual(['628999'])
        expect(forAccountConfig(config, 'main').ownerNumbers).toEqual(['628111'])
    })

    it('falls back to the shared values for accounts with no override', () => {
        const { config } = parseConfig(base, '/root', () => true, home)
        expect(forAccountConfig(config, 'kerja')).toEqual({ workspaceDir: `${root}/utama`, ownerNumbers: ['628111'], contactWorkspaces: {} })
    })

    it('normalizes account names into env keys', () => {
        const { config } = parseConfig(
            { ACCOUNTS: 'main,kerja-2', WORKSPACE: 'utama', OWNER_NUMBERS: '628111', 'WORKSPACE_KERJA_2': 'dua' },
            '/root', () => true, home)
        expect(forAccountConfig(config, 'kerja-2').workspaceDir).toBe(`${root}/dua`)
    })

    it('reports a per-account workspace that does not exist', () => {
        const { errors } = parseConfig({ ...base, WORKSPACE_KERJA: 'hilang' }, '/root',
            p => !p.endsWith('hilang'), home)
        expect(errors.join()).toContain('akun kerja')
    })

    it('routes a mapped contact to their own workspace', () => {
        const { config, errors } = parseConfig(
            { ...base, WORKSPACE: 'utama', CONTACT_WORKSPACES: '+62 856-4728-1472: mybabygurll' },
            '/root', () => true, home)
        expect(errors).toEqual([])
        expect(workspaceFor(config, 'main', '6285647281472')).toBe(`${root}/mybabygurll`)
        // everyone else still lands in the account's own workspace
        expect(workspaceFor(config, 'main', '628111')).toBe(`${root}/utama`)
    })

    it('lets an absolute path be the contact workspace', () => {
        const { config } = parseConfig({ ...base, CONTACT_WORKSPACES: '628222:/srv/bg' }, '/root', () => true, home)
        expect(workspaceFor(config, 'main', '628222')).toBe('/srv/bg')
    })

    it('scopes the contact map per account when asked', () => {
        const { config } = parseConfig(
            { ACCOUNTS: 'main,kerja', WORKSPACE: 'utama', OWNER_NUMBERS: '628111',
              CONTACT_WORKSPACES: '628222:bg', CONTACT_WORKSPACES_KERJA: '628222:kantor' },
            '/root', () => true, home)
        expect(workspaceFor(config, 'kerja', '628222')).toBe(`${root}/kantor`)
        expect(workspaceFor(config, 'main', '628222')).toBe(`${root}/bg`)
    })

    it('reports a malformed contact entry instead of ignoring it', () => {
        const { errors } = parseConfig({ ...base, CONTACT_WORKSPACES: 'mybabygurll' }, '/root', () => true, home)
        expect(errors.join()).toContain('CONTACT_WORKSPACES tidak valid')
    })

    it('reports a contact workspace that does not exist', () => {
        const { errors } = parseConfig({ ...base, CONTACT_WORKSPACES: '628222:hilang' }, '/root',
            p => !p.endsWith('hilang'), home)
        expect(errors.join()).toContain('workspace kontak 628222')
    })

    it('accepts owners defined only per account', () => {
        const { errors, config } = parseConfig(
            { ACCOUNTS: 'main', WORKSPACE: 'utama', OWNER_NUMBERS_MAIN: '628111' }, '/root', () => true, home)
        expect(errors).toEqual([])
        expect(forAccountConfig(config, 'main').ownerNumbers).toEqual(['628111'])
    })
})

describe('isWorkspaceName', () => {
    it.each(['main', 'kerja-2', 'a.b_c', 'X1'])('accepts %s', n => {
        expect(isWorkspaceName(n)).toBe(true)
    })

    it.each(['..', '.', 'a/b', '~/x', '/abs', '', 'a b'])('rejects %s', n => {
        expect(isWorkspaceName(n)).toBe(false)
    })

    it('is what keeps a name from escaping the root', () => {
        // '..' is not a name, so it is treated as a path and never joined
        // onto the root — no traversal out of the managed directory.
        expect(resolveWorkspace('..', '/root/ws', '/home/k')).not.toContain('/root/ws')
        expect(resolveWorkspace('', '/root/ws', '/home/k')).toBe('')
    })
})

describe('group routes', () => {
    const home = '/home/killa'
    const base = { WORKSPACE_DIR: '/ws', OWNER_NUMBERS: '628111' }

    const withGroup = (over: Record<string, string> = {}) => parseConfig({
        ...base,
        GROUPS: 'railway',
        GROUP_JID_RAILWAY: '12345@g.us',
        GROUP_TRIGGER_RAILWAY: 'Meii',
        GROUP_WORKSPACE_RAILWAY: '/home/killa-rw/.killa/workspaces/railway',
        GROUP_RUNAS_RAILWAY: 'killa-rw',
        ...over,
    }, '/root', () => true, home)

    it('reads a route and lower-cases the trigger once', () => {
        const { config, errors } = withGroup()
        expect(errors).toEqual([])
        const r = routeForChat(config, '12345@g.us')
        expect(r?.name).toBe('railway')
        expect(r?.trigger).toBe('meii')
        expect(r?.runAs).toBe('killa-rw')
        expect(r?.workspaceDir).toBe('/home/killa-rw/.killa/workspaces/railway')
    })

    it('does not route a group it was never told about', () => {
        const { config } = withGroup()
        expect(routeForChat(config, '99999@g.us')).toBeNull()
    })

    it('refuses a route with no trigger — that would answer every message', () => {
        const { errors } = withGroup({ GROUP_TRIGGER_RAILWAY: '' })
        expect(errors.some(e => e.includes('GROUP_TRIGGER_RAILWAY'))).toBe(true)
    })

    it('refuses a jid that is not a group', () => {
        const { errors } = withGroup({ GROUP_JID_RAILWAY: '628111@s.whatsapp.net' })
        expect(errors.some(e => e.includes('@g.us'))).toBe(true)
    })

    it('does not stat a runAs workspace — it lives in another user home', () => {
        // exists() says no; a runAs route must still be accepted, because this
        // process genuinely cannot see into the other user's home.
        const { errors } = parseConfig({
            ...base, GROUPS: 'railway', GROUP_JID_RAILWAY: '12345@g.us',
            GROUP_TRIGGER_RAILWAY: 'meii', GROUP_RUNAS_RAILWAY: 'killa-rw',
            GROUP_WORKSPACE_RAILWAY: '/home/killa-rw/.killa/workspaces/railway',
        }, '/root', p => p === '/ws', home)
        expect(errors).toEqual([])
    })

    it('still checks a workspace it can see', () => {
        const { errors } = withGroup({ GROUP_RUNAS_RAILWAY: '' })
        expect(errors.some(e => e.includes('tidak ditemukan'))).toBe(false)
    })
})

describe('HTTP channel config', () => {
    it('is off unless HTTP_PORT is set', () => {
        expect(parseConfig(base, '/root').config.http).toBeNull()
    })

    it('defaults to loopback, the first account and its workspace', () => {
        const { config, errors } = parseConfig({ ...base, ACCOUNTS: 'main,kerja', WORKSPACE_KERJA: '/ws-k',
                                                 HTTP_PORT: '8787', HTTP_TOKEN: ' t0k ' }, '/root')
        expect(errors).toEqual([])
        expect(config.http).toEqual({ port: 8787, bind: '127.0.0.1', token: 't0k', account: 'main', workspaceDir: '/ws' })
    })

    it('honours HTTP_ACCOUNT, HTTP_BIND and HTTP_WORKSPACE', () => {
        const { config } = parseConfig({ ...base, ACCOUNTS: 'main,kerja', WORKSPACE_KERJA: '/ws-k', HTTP_PORT: '1',
                                         HTTP_TOKEN: 't', HTTP_ACCOUNT: 'kerja', HTTP_BIND: '0.0.0.0' }, '/root')
        expect(config.http).toMatchObject({ account: 'kerja', bind: '0.0.0.0', workspaceDir: '/ws-k' })
        const over = parseConfig({ ...base, HTTP_PORT: '1', HTTP_TOKEN: 't', HTTP_WORKSPACE: '/ws-ghina' }, '/root')
        expect(over.config.http?.workspaceDir).toBe('/ws-ghina')
    })

    it.each([
        [{ HTTP_PORT: '8787' }, 'HTTP_TOKEN wajib'],
        [{ HTTP_PORT: 'abc', HTTP_TOKEN: 't' }, 'HTTP_PORT tidak valid'],
        [{ HTTP_PORT: '70000', HTTP_TOKEN: 't' }, 'HTTP_PORT tidak valid'],
        [{ HTTP_PORT: '8787', HTTP_TOKEN: 't', HTTP_ACCOUNT: 'nope' }, 'HTTP_ACCOUNT "nope"'],
    ])('reports %j', (env, message) => {
        expect(parseConfig({ ...base, ...env }, '/root').errors).toEqual([expect.stringContaining(message)])
    })

    it('reports a missing HTTP_WORKSPACE', () => {
        const { errors } = parseConfig({ ...base, HTTP_PORT: '1', HTTP_TOKEN: 't', HTTP_WORKSPACE: '/gone' }, '/root',
                                       p => p !== '/gone')
        expect(errors).toEqual(['workspace HTTP tidak ditemukan: /gone'])
    })
})

describe('mirror config', () => {
    it('is off unless MIRROR_URL is set', () => {
        expect(parseConfig(base, '/root').config.mirror).toBeNull()
    })

    it('reads url and token', () => {
        const { config, errors } = parseConfig({ ...base, MIRROR_URL: ' https://ghina.test/api/mirror ', MIRROR_TOKEN: ' m ' }, '/root')
        expect(errors).toEqual([])
        expect(config.mirror).toEqual({ url: 'https://ghina.test/api/mirror', token: 'm' })
    })

    it.each([
        [{ MIRROR_URL: 'https://x.test' }, 'MIRROR_TOKEN wajib'],
        [{ MIRROR_URL: 'bukan url', MIRROR_TOKEN: 't' }, 'MIRROR_URL tidak valid'],
        [{ MIRROR_URL: 'ftp://x.test', MIRROR_TOKEN: 't' }, 'MIRROR_URL tidak valid'],
    ])('reports %j', (env, message) => {
        expect(parseConfig({ ...base, ...env }, '/root').errors).toEqual([expect.stringContaining(message)])
    })
})

describe('jid helpers', () => {
    it('builds the DM jid and spots groups', () => {
        expect(dmJid('628111')).toBe('628111@s.whatsapp.net')
        expect(isGroupJid('123@g.us')).toBe(true)
        expect(isGroupJid('628111@s.whatsapp.net')).toBe(false)
    })
})
