import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useRef } from 'react'
import { i18n } from '../i18n'
import { useOnline } from '../offline/useOnline'
import type { Attachment } from '../types'
import { useAttachmentImageUrls } from '../useAttachmentImageUrls'
import { blockExtensions } from './extensions'
import {
  getEditorMarkdown,
  normalizeStoredMarkdown,
  prepareMarkdownForEditor,
  setEditorSelectionFromMarkdownOffset,
} from './markdownBridge'

type RichBlockEditorProps = {
  value: string
  noteId?: string
  attachments?: Attachment[]
  placeholder?: string
  'aria-label'?: string
  pendingOffset?: number | null
  onPendingOffsetConsumed?: () => void
  onChange: (markdown: string) => void
  onEditorReady?: (editor: Editor | null) => void
}

export function RichBlockEditor({
  value,
  noteId,
  attachments = [],
  placeholder = i18n.t('editor.contentPlaceholder'),
  'aria-label': ariaLabel = i18n.t('editor.contentAria'),
  pendingOffset = null,
  onPendingOffsetConsumed,
  onChange,
  onEditorReady,
}: RichBlockEditorProps) {
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastEmitted = useRef(value)
  const hostRef = useRef<HTMLDivElement>(null)
  const online = useOnline()
  useAttachmentImageUrls(hostRef, attachments, value, noteId, online)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: blockExtensions(placeholder),
    content: prepareMarkdownForEditor(value, attachments),
    editorProps: {
      attributes: {
        class: 'rich-block-editor rendered-content',
        'aria-label': ariaLabel,
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = normalizeStoredMarkdown(
        getEditorMarkdown(current, attachmentsRef.current),
      )
      lastEmitted.current = next
      onChangeRef.current(next)
    },
  })

  useEffect(() => {
    onEditorReady?.(editor)
    return () => onEditorReady?.(null)
  }, [editor, onEditorReady])

  useEffect(() => {
    if (!editor) return
    if (value === lastEmitted.current) return
    const prepared = prepareMarkdownForEditor(value, attachments)
    const current = normalizeStoredMarkdown(
      getEditorMarkdown(editor, attachments),
    )
    if (current === normalizeStoredMarkdown(value)) {
      lastEmitted.current = value
      return
    }
    editor.commands.setContent(prepared)
    lastEmitted.current = value
  }, [attachments, editor, value])

  useEffect(() => {
    if (!editor || pendingOffset == null) return
    setEditorSelectionFromMarkdownOffset(editor, pendingOffset)
    onPendingOffsetConsumed?.()
  }, [editor, onPendingOffsetConsumed, pendingOffset])

  return (
    <div ref={hostRef} className="rich-block-editor-host">
      <EditorContent editor={editor} />
    </div>
  )
}
