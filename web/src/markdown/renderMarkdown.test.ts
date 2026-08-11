import { describe, expect, it } from 'vitest'
import {
  expandSubSuperscript,
  neutralizeReferenceDefinitions,
  neutralizeTaskListMarkers,
} from './preprocessMarkdown'
import { renderMarkdown, renderMarkdownInline } from './renderMarkdown'

describe('preprocessMarkdown', () => {
  it('neutralizes GFM task list markers', () => {
    expect(neutralizeTaskListMarkers('- [ ] todo')).toBe('- \\[ \\] todo')
    expect(neutralizeTaskListMarkers('- [x] done')).toBe('- \\[x\\] done')
  })

  it('neutralizes reference definitions and footnotes', () => {
    expect(neutralizeReferenceDefinitions('[ref]: https://example.com')).toBe(
      '\\[ref\\]: https://example.com',
    )
    expect(neutralizeReferenceDefinitions('[^1]: footnote text')).toBe(
      '\\[^1\\]: footnote text',
    )
  })

  it('expands subscript and superscript without breaking strikethrough', () => {
    expect(expandSubSuperscript('H~2~O')).toBe('H<sub>2</sub>O')
    expect(expandSubSuperscript('x^2^')).toBe('x<sup>2</sup>')
    expect(expandSubSuperscript('~~gone~~')).toBe('~~gone~~')
    expect(expandSubSuperscript('[^1]')).toBe('[^1]')
  })
})

describe('renderMarkdown', () => {
  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
    expect(html).toContain('>a<')
    expect(html).toContain('>1<')
  })

  it('renders underline, subscript, and superscript', () => {
    const html = renderMarkdown('<u>under</u> H~2~O and x^2^')
    expect(html).toContain('<u>under</u>')
    expect(html).toContain('<sub>2</sub>')
    expect(html).toContain('<sup>2</sup>')
  })

  it('does not render GFM task list checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done')
    expect(html).not.toContain('<input')
    expect(html).toContain('[ ] todo')
    expect(html).toContain('[x] done')
  })

  it('does not link footnote-style references', () => {
    const html = renderMarkdown('text[^1]\n\n[^1]: note')
    expect(html).not.toContain('href="note"')
    expect(html).toContain('[^1]')
  })

  it('does not link reference definitions', () => {
    const html = renderMarkdown('[ref]: https://example.com\n\nsee [ref]')
    expect(html).toContain('see [ref]')
    expect(html).not.toMatch(/see <a[^>]*>ref<\/a>/)
  })

  it('blocks remote images to avoid leaking note views to third parties', () => {
    const html = renderMarkdown('![tracking pixel](https://example.com/pixel.png)')
    expect(html).toContain('<img')
    expect(html).not.toContain('src=')
    expect(html).not.toContain('example.com')
  })

  it('rewrites matching image filenames to encrypted attachment URLs', () => {
    const html = renderMarkdown('![photo](photo.jpg)', [
      {
        id: 'attachment-1',
        kind: 'IMAGE',
        originalFilename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 123,
        createdAt: '2026-01-01T00:00:00Z',
        url: '/attachments/attachment-1',
      },
    ])
    expect(html).toContain('src="/attachments/attachment-1"')
  })

  it('renders inline sub, sup, and underline in checklist preview', () => {
    const html = renderMarkdownInline('H~2~O <u>x</u> y^2^')
    expect(html).toContain('<sub>2</sub>')
    expect(html).toContain('<u>x</u>')
    expect(html).toContain('<sup>2</sup>')
  })
})
