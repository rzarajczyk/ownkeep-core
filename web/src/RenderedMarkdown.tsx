import { useMemo, useRef } from 'react'
import type { Attachment } from './types'
import { useOnline } from './offline/useOnline'
import { sanitizedMarkup } from './utils'
import { useAttachmentImageUrls } from './useAttachmentImageUrls'

interface RenderedMarkdownProps {
  html: string
  noteId?: string
  attachments?: Attachment[]
  className?: string
  /** When true, renders a <span> for checklist / inline contexts. */
  inline?: boolean
}

/**
 * Sanitized markdown HTML with attachment image blob rewriting.
 * Shared by NoteCard now; NoteEditor live preview can reuse this later.
 */
export function RenderedMarkdown({
  html,
  noteId,
  attachments = [],
  className,
  inline = false,
}: RenderedMarkdownProps) {
  const ref = useRef<HTMLElement | null>(null)
  const markup = useMemo(() => sanitizedMarkup(html), [html])
  const online = useOnline()
  useAttachmentImageUrls(ref, attachments, html, noteId, online)

  if (inline) {
    return (
      <span
        ref={(node) => {
          ref.current = node
        }}
        className={className}
        dangerouslySetInnerHTML={markup}
      />
    )
  }

  return (
    <div
      ref={(node) => {
        ref.current = node
      }}
      className={className}
      dangerouslySetInnerHTML={markup}
    />
  )
}
