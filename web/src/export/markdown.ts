import type { Note } from '../types'

const IMAGE_MARKDOWN = /!\[([^\]]*)\]\((?:[^)]+)\)/g

export function stripMarkdownImages(markdown: string): string {
  return markdown.replace(IMAGE_MARKDOWN, (_full, alt: string) => alt ?? '')
}

function checklistMarkdown(note: Note): string {
  return note.items
    .map((item) => {
      const indent = '  '.repeat(item.indent ?? 0)
      const mark = item.checked ? 'x' : ' '
      return `${indent}- [${mark}] ${stripMarkdownImages(item.text)}`
    })
    .join('\n')
}

export function noteBodyMarkdown(note: Note): string {
  if (note.type === 'LIST') return checklistMarkdown(note)
  return stripMarkdownImages(note.contentRaw).trimEnd()
}

export function noteToMarkdown(
  note: Note,
  appendix?: { images: string[]; files?: string[] },
): string {
  const parts: string[] = []
  const title = note.title.trim()
  if (title) parts.push(`# ${title}`, '')
  const body = noteBodyMarkdown(note)
  if (body) parts.push(body)
  if (appendix?.images.length) {
    if (parts.length) parts.push('')
    for (const filename of appendix.images) {
      parts.push(`![${filename}](${filename})`)
    }
  }
  if (appendix?.files?.length) {
    if (parts.length) parts.push('')
    for (const filename of appendix.files) {
      parts.push(`[${filename}](${filename})`)
    }
  }
  const joined = parts.join('\n').replace(/\n+$/, '')
  return joined ? `${joined}\n` : ''
}
