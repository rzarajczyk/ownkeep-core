import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Attachment } from '../types'
import { preprocessMarkdown } from './preprocessMarkdown'

marked.setOptions({
  gfm: true,
  breaks: false,
})

function attachmentImageSrc(destination: string, attachments: Attachment[]): string | null {
  const trimmed = destination.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) return null
  if (lower.startsWith('/attachments/')) return trimmed
  const filename = trimmed.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''
  if (!filename) return null
  const match = attachments.find(
    (attachment) =>
      attachment.kind === 'IMAGE' &&
      attachment.originalFilename.toLowerCase() === filename.toLowerCase(),
  )
  return match ? `/attachments/${match.id}` : null
}

function rewriteImageSources(html: string, attachments: Attachment[]): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (!src) return
    const rewritten = attachmentImageSrc(src, attachments)
    if (rewritten) {
      img.setAttribute('src', rewritten)
    } else {
      img.removeAttribute('src')
    }
  })
  return doc.body.innerHTML
}

const BLOCK_PURIFY = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    'del',
    's',
    'sub',
    'sup',
    'a',
    'ul',
    'ol',
    'li',
    'code',
    'pre',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align'],
}

const INLINE_PURIFY = {
  ALLOWED_TAGS: ['strong', 'em', 'u', 'del', 's', 'sub', 'sup', 'a', 'code', 'br'],
  ALLOWED_ATTR: ['href', 'title'],
}

export function renderMarkdown(markdown: string, attachments: Attachment[] = []): string {
  const prepared = preprocessMarkdown(markdown)
  const raw = marked.parse(prepared, { async: false }) as string
  const withImages = rewriteImageSources(raw, attachments)
  return DOMPurify.sanitize(withImages, BLOCK_PURIFY)
}

export function renderMarkdownInline(markdown: string): string {
  const prepared = preprocessMarkdown(markdown)
  const raw = marked.parseInline(prepared, { async: false }) as string
  return DOMPurify.sanitize(raw, INLINE_PURIFY)
}
