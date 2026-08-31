import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WAMessage } from 'baileys'
import { extractText, imageExtension, isGroup, resolveSender, saveIncomingImage } from '../src/whatsapp/inbound.ts'

describe('resolveSender in groups', () => {
    it('reads the person, not the group', async () => {
        // remoteJid is the group; the human is in participant.
        const got = await resolveSender(
            { remoteJid: '12345@g.us', participant: '628999@s.whatsapp.net' }, undefined)
        expect(got).toBe('628999')
    })

    it('falls back to participantAlt when participant is a lid', async () => {
        const got = await resolveSender(
            { remoteJid: '12345@g.us', participant: '', participantAlt: '628777@s.whatsapp.net' }, undefined)
        expect(got).toBe('628777')
    })

    it('still reads remoteJid for a direct message', async () => {
        const got = await resolveSender({ remoteJid: '628111@s.whatsapp.net' }, undefined)
        expect(got).toBe('628111')
    })
})

describe('extractText', () => {
    it.each([
        [{ conversation: 'halo' }, 'halo'],
        [{ extendedTextMessage: { text: 'balasan' } }, 'balasan'],
        [{ imageMessage: { caption: 'caption gambar' } }, 'caption gambar'],
        [{ videoMessage: { caption: 'caption video' } }, 'caption video'],
        [{ imageMessage: {} }, ''],
        [{}, ''],
    ])('reads %o', (message, expected) => {
        expect(extractText({ message } as WAMessage)).toBe(expected)
    })

    it('returns empty for a message with no content at all', () => {
        expect(extractText({ message: null } as WAMessage)).toBe('')
    })
})

describe('isGroup', () => {
    it('spots group jids', () => {
        expect(isGroup('123-456@g.us')).toBe(true)
        expect(isGroup('628111@s.whatsapp.net')).toBe(false)
    })
})

describe('resolveSender', () => {
    it('takes the number straight off a normal jid', async () => {
        expect(await resolveSender({ remoteJid: '628111@s.whatsapp.net' }, undefined)).toBe('628111')
    })

    it('prefers the Alt field for a @lid jid', async () => {
        expect(await resolveSender({ remoteJid: '99@lid', remoteJidAlt: '628111@s.whatsapp.net' }, undefined))
            .toBe('628111')
        expect(await resolveSender({ remoteJid: '99@lid', participantAlt: '628222@s.whatsapp.net' }, undefined))
            .toBe('628222')
    })

    it('falls back to the LID mapping lookup', async () => {
        const lookup = { getPNForLID: vi.fn(async () => '628333@s.whatsapp.net') }
        expect(await resolveSender({ remoteJid: '99@lid' }, lookup)).toBe('628333')
        expect(lookup.getPNForLID).toHaveBeenCalledWith('99@lid')
    })

    it('returns null when the number cannot be known — never a guess', async () => {
        expect(await resolveSender({ remoteJid: '99@lid' }, undefined)).toBeNull()
        expect(await resolveSender({ remoteJid: '99@lid' }, { getPNForLID: async () => null })).toBeNull()
        expect(await resolveSender({}, undefined)).toBeNull()
    })

    it('reports a failing lookup and stays null', async () => {
        const onError = vi.fn()
        const lookup = { getPNForLID: async () => { throw new Error('signal down') } }
        expect(await resolveSender({ remoteJid: '99@lid' }, lookup, onError)).toBeNull()
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('signal down'))
    })

    it('ignores an Alt that is not a phone-number jid', async () => {
        expect(await resolveSender({ remoteJid: '99@lid', remoteJidAlt: '88@lid' }, undefined)).toBeNull()
    })
})

describe('imageExtension', () => {
    it.each([
        ['image/png', 'png'],
        ['image/jpeg', 'jpeg'],
        ['image/webp;codecs=x', 'webp'],
        [null, 'jpeg'],
        ['', 'jpeg'],
        ['garbage', 'jpeg'],
    ])('%s -> %s', (mime, ext) => {
        expect(imageExtension(mime)).toBe(ext)
    })
})

describe('saveIncomingImage', () => {
    const imageMsg = { message: { imageMessage: { mimetype: 'image/png' } } } as WAMessage
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'killa-media-'))

    it('writes the download and returns its path', async () => {
        const dir = tmp()
        const file = await saveIncomingImage(imageMsg, dir, async () => Buffer.from('png-bytes'),
            undefined, () => 12345)
        expect(file).toBe(path.join(dir, 'in-12345.png'))
        expect(fs.readFileSync(file!, 'utf8')).toBe('png-bytes')
    })

    it('creates the media directory if it is missing', async () => {
        const dir = path.join(tmp(), 'nested')
        expect(await saveIncomingImage(imageMsg, dir, async () => Buffer.from('x'), undefined, () => 1)).toBeTruthy()
    })

    it('returns null for a message with no image', async () => {
        const download = vi.fn()
        expect(await saveIncomingImage({ message: { conversation: 'halo' } } as WAMessage, tmp(), download)).toBeNull()
        expect(download).not.toHaveBeenCalled()
    })

    it('reports a failed download and returns null instead of throwing', async () => {
        const onError = vi.fn()
        const file = await saveIncomingImage(imageMsg, tmp(),
            async () => { throw new Error('media expired') }, onError)
        expect(file).toBeNull()
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('media expired'))
    })
})
