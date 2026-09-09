import { describe, expect, it } from 'vitest'
import { isImageFile, mimeFor } from '../src/core/files.ts'

describe('isImageFile', () => {
    it.each(['/a/b.png', '/a/b.JPG', 'x.jpeg', 'x.webp', 'x.gif'])('%s is an image', f => {
        expect(isImageFile(f)).toBe(true)
    })

    it.each(['laporan.docx', 'a.pdf', 'a.pptx', 'a', 'a.png.docx'])('%s is not', f => {
        expect(isImageFile(f)).toBe(false)
    })
})

describe('mimeFor', () => {
    it('knows the office formats the agent actually produces', () => {
        expect(mimeFor('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        expect(mimeFor('a.pdf')).toBe('application/pdf')
        expect(mimeFor('a.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    })

    it('still sends something unknown rather than refusing', () => {
        expect(mimeFor('laporan.odt')).toBe('application/octet-stream')
        expect(mimeFor('noext')).toBe('application/octet-stream')
    })
})
