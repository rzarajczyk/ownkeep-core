import { bytesToBase64 } from '../crypto/aead'
import { renderMarkdown, renderMarkdownInline } from '../markdown/renderMarkdown'
import type { Note } from '../types'
import { stripMarkdownImages } from './markdown'
import type { ExportBinary } from './types'
import { escapeHtml } from './xml'

const PRINT_STYLES = `
body { font-family: Georgia, "Times New Roman", serif; max-width: 42rem; margin: 2rem auto; padding: 0 1.5rem; color: #222; line-height: 1.5; }
h1, h2, h3 { font-weight: 600; }
img { max-width: 100%; height: auto; }
figure { margin: 1.75rem 0; }
figcaption { margin-top: 0.4rem; font-size: 0.85rem; color: #666; }
pre { background: #f4f3ee; padding: 0.75rem 1rem; overflow: auto; border-radius: 6px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ccc; padding: 0.3rem 0.6rem; }
ul.export-checklist { list-style: none; padding-left: 0; }
ul.export-checklist li { margin: 0.25rem 0; }
@media print { body { margin: 0.75in; max-width: none; } }
`.trim()

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`
}

function checklistHtml(note: Note): string {
  const items = note.items
    .map((item) => {
      const indent = (item.indent ?? 0) * 1.5
      const checked = item.checked ? ' checked' : ''
      const text = item.text.trim()
        ? renderMarkdownInline(stripMarkdownImages(item.text))
        : ''
      return `<li style="margin-left:${indent}em"><input type="checkbox" disabled${checked}> ${text}</li>`
    })
    .join('\n')
  return `<ul class="export-checklist">\n${items}\n</ul>`
}

function imageAppendixHtml(images: ExportBinary[]): string {
  if (!images.length) return ''
  return images
    .map((image) => {
      const caption = escapeHtml(image.filename)
      if (!image.bytes) {
        return `<figure><figcaption>${caption}</figcaption></figure>`
      }
      const src = escapeHtml(dataUrl(image.mimeType || 'application/octet-stream', image.bytes))
      return `<figure><img src="${src}" alt="${caption}"><figcaption>${caption}</figcaption></figure>`
    })
    .join('\n')
}

export function noteToHtml(note: Note, images: ExportBinary[] = []): string {
  const title = note.title.trim()
  const pageTitle = escapeHtml(title || 'note')
  const heading = title ? `<h1>${escapeHtml(title)}</h1>\n` : ''
  const body =
    note.type === 'LIST'
      ? checklistHtml(note)
      : renderMarkdown(stripMarkdownImages(note.contentRaw))
  const appendix = imageAppendixHtml(images)
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${pageTitle}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
${heading}${body}
${appendix}
</body>
</html>
`
}
