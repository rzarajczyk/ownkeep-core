import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { Note } from '../types'
import { buildExportDocument, noteToPlainText } from './document'
import { noteToDocx } from './docx'
import { noteExportBasename, uniquifyFilenames } from './filename'
import { noteToHtml } from './html'
import { noteToMarkdown, stripMarkdownImages } from './markdown'
import { noteToOdt } from './odt'
import { noteToRtf } from './rtf'
import type { ExportBinary } from './types'
import { noteToMarkdownZip } from './zip'

const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const photo: ExportBinary = { filename: 'photo.png', mimeType: 'image/png', bytes: PNG_1x1 }
const pdf: ExportBinary = {
  filename: 'notes.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-1.4'),
}

function textNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    type: 'TEXT',
    title: 'Hello',
    contentRaw: 'A **bold** note',
    contentRendered: '',
    backgroundColor: '#ffffff',
    archived: false,
    pinned: false,
    labels: [],
    labelIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    items: [],
    attachments: [],
    ...overrides,
  }
}

function decode(entry: Uint8Array | undefined): string {
  return new TextDecoder().decode(entry)
}

describe('note export converters', () => {
  it('builds markdown with a title and strips inline images from the body', () => {
    const md = noteToMarkdown(
      textNote({ contentRaw: 'See ![cat](cat.png) today' }),
    )
    expect(md).toBe('# Hello\n\nSee cat today\n')
    expect(stripMarkdownImages('![only](x.png)')).toBe('only')
  })

  it('exports checklist notes as task-list markdown', () => {
    const md = noteToMarkdown(
      textNote({
        type: 'LIST',
        title: 'Shop',
        contentRaw: '',
        items: [
          { id: 'a', text: 'Milk', textRendered: '', checked: true, sortOrder: 0, indent: 0 },
          { id: 'b', text: 'Bread', textRendered: '', checked: false, sortOrder: 1, indent: 1 },
        ],
      }),
    )
    expect(md).toContain('# Shop')
    expect(md).toContain('- [x] Milk')
    expect(md).toContain('  - [ ] Bread')
  })

  it('strips inline images from checklist item markdown', () => {
    const md = noteToMarkdown(
      textNote({
        type: 'LIST',
        title: 'Pics',
        contentRaw: '',
        items: [
          {
            id: 'a',
            text: 'See ![cat](cat.png)',
            textRendered: '',
            checked: false,
            sortOrder: 0,
            indent: 0,
          },
        ],
      }),
    )
    expect(md).toContain('- [ ] See cat')
    expect(md).not.toContain('cat.png')
  })

  it('appends images then file links only when requested', () => {
    const md = noteToMarkdown(textNote(), { images: ['photo.png'], files: ['notes.pdf'] })
    expect(md.endsWith('![photo.png](photo.png)\n\n[notes.pdf](notes.pdf)\n')).toBe(true)
  })

  it('converts notes to plain text without markdown markers', () => {
    const text = noteToPlainText(textNote({ contentRaw: 'A **bold** note' }))
    expect(text).toContain('Hello')
    expect(text).toContain('bold')
    expect(text).not.toContain('**')
  })

  it('builds HTML with a data-URL image appendix and no file attachments', () => {
    const html = noteToHtml(textNote({ contentRaw: 'See ![cat](cat.png) today' }), [photo])
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('See cat today')
    expect(html).not.toContain('cat.png')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('<figcaption>photo.png</figcaption>')
    expect(html).not.toContain('notes.pdf')
  })

  it('packs markdown plus every attachment into a zip', () => {
    const bytes = noteToMarkdownZip(
      textNote({ title: 'Shopping list', contentRaw: 'Buy milk ![x](photo.png)' }),
      'Shopping list',
      [photo],
      [pdf],
    )
    const entries = unzipSync(bytes)
    expect(Object.keys(entries).sort()).toEqual(['Shopping list.md', 'notes.pdf', 'photo.png'].sort())
    const md = decode(entries['Shopping list.md'])
    expect(md).toContain('# Shopping list')
    expect(md).toContain('Buy milk x')
    expect(md).toContain('![photo.png](photo.png)')
    expect(md).toContain('[notes.pdf](notes.pdf)')
    expect(entries['photo.png']).toEqual(PNG_1x1)
  })

  it('embeds images at the end of ODT/DOCX and omits non-image files', () => {
    const doc = buildExportDocument(textNote())
    const odt = unzipSync(noteToOdt(doc, [photo]))
    expect(decode(odt['content.xml'])).toContain('Hello')
    expect(decode(odt['content.xml'])).toContain('Pictures/photo.png')
    expect(odt['Pictures/photo.png']).toEqual(PNG_1x1)
    expect(Object.keys(odt).some((name) => name.includes('notes.pdf'))).toBe(false)

    const docx = unzipSync(noteToDocx(doc, [photo]))
    expect(decode(docx['word/document.xml'])).toContain('Hello')
    expect(decode(docx['word/document.xml'])).toContain('rIdImg1')
    expect(Object.keys(docx).some((name) => name.startsWith('word/media/'))).toBe(true)
    expect(Object.keys(docx).some((name) => name.includes('notes.pdf'))).toBe(false)
  })

  it('embeds PNG pictures in RTF', async () => {
    const rtf = await noteToRtf(buildExportDocument(textNote()), [photo])
    expect(rtf).toContain('\\rtf1')
    expect(rtf).toContain('\\pict')
    expect(rtf).toContain('pngblip')
    expect(rtf).toContain('photo.png')
    expect(rtf).not.toContain('notes.pdf')
  })

  it('sanitizes download names and uniquifies zip entries', () => {
    expect(noteExportBasename('  My: note*/  ')).toBe('My note')
    expect(noteExportBasename('')).toBe('note')
    expect(uniquifyFilenames(['photo.png', 'photo.png', 'PHOTO.png'])).toEqual([
      'photo.png',
      'photo-2.png',
      'PHOTO-3.png',
    ])
  })
})
