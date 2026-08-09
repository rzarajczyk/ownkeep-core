import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useRef } from 'react'
import { i18n } from '../i18n'
import { inlineExtensions } from './extensions'
import {
  getEditorMarkdown,
  normalizeStoredMarkdown,
  prepareMarkdownForEditor,
  setEditorSelectionFromMarkdownOffset,
} from './markdownBridge'

type RichInlineEditorProps = {
  value: string
  itemId: string
  checked?: boolean
  placeholder?: string
  'aria-label'?: string
  pendingOffset?: number | null
  onPendingOffsetConsumed?: () => void
  onChange: (markdown: string) => void
  onFocus?: () => void
  onEnter?: () => void
  onBackspaceEmpty?: () => void
  onEditorReady?: (editor: Editor | null) => void
}

export function RichInlineEditor({
  value,
  itemId,
  checked = false,
  placeholder = i18n.t('editor.itemPlaceholder'),
  'aria-label': ariaLabel,
  pendingOffset = null,
  onPendingOffsetConsumed,
  onChange,
  onFocus,
  onEnter,
  onBackspaceEmpty,
  onEditorReady,
}: RichInlineEditorProps) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onEnterRef = useRef(onEnter)
  onEnterRef.current = onEnter
  const onBackspaceEmptyRef = useRef(onBackspaceEmpty)
  onBackspaceEmptyRef.current = onBackspaceEmpty
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const lastEmitted = useRef(value)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: inlineExtensions(placeholder),
    content: prepareMarkdownForEditor(value),
    editorProps: {
      attributes: {
        class: `rich-inline-editor${checked ? ' checked' : ''}`,
        'aria-label': ariaLabel ?? 'Checklist item',
        'data-item-id': itemId,
        role: 'textbox',
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          onEnterRef.current?.()
          return true
        }
        if (event.key === 'Backspace') {
          const empty = view.state.doc.textContent.length === 0
          if (empty) {
            event.preventDefault()
            onBackspaceEmptyRef.current?.()
            return true
          }
        }
        return false
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = normalizeStoredMarkdown(getEditorMarkdown(current))
      lastEmitted.current = next
      onChangeRef.current(next)
    },
    onFocus: () => onFocusRef.current?.(),
  })

  useEffect(() => {
    onEditorReady?.(editor)
    return () => onEditorReady?.(null)
  }, [editor, onEditorReady])

  useEffect(() => {
    if (!editor) return
    const attrs = editor.options.editorProps?.attributes
    const base =
      attrs && typeof attrs === 'object' && !Array.isArray(attrs)
        ? { ...attrs }
        : {}
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...base,
          class: `rich-inline-editor${checked ? ' checked' : ''}`,
        },
      },
    })
  }, [checked, editor])

  useEffect(() => {
    if (!editor) return
    if (value === lastEmitted.current) return
    const current = normalizeStoredMarkdown(getEditorMarkdown(editor))
    if (current === normalizeStoredMarkdown(value)) {
      lastEmitted.current = value
      return
    }
    editor.commands.setContent(prepareMarkdownForEditor(value))
    lastEmitted.current = value
  }, [editor, value])

  useEffect(() => {
    if (!editor || pendingOffset == null) return
    setEditorSelectionFromMarkdownOffset(editor, pendingOffset)
    onPendingOffsetConsumed?.()
  }, [editor, onPendingOffsetConsumed, pendingOffset])

  return <EditorContent editor={editor} className="rich-inline-editor-host" />
}
