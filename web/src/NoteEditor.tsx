import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Editor } from '@tiptap/core'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Bold,
  Check,
  CircleAlert,
  Code,
  Code2,
  DropletOff,
  Eye,
  GripVertical,
  Heading1,
  Heading2,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  ListX,
  LoaderCircle,
  Palette,
  Paperclip,
  Pencil,
  PenLine,
  Pin,
  Plus,
  RotateCcw,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { AttachmentView } from './AttachmentView'
import { HistoryToolButton, NoteChangeHistory } from './NoteChangeHistory'
import {
  decryptAttachmentMeta,
  encryptAttachmentBytes,
  encryptAttachmentMeta,
  inferAttachmentKind,
} from './crypto/attachmentCodec'
import { buildNotePayload, encryptNotePayload, wrapNoteKey } from './crypto/noteCodec'
import { decryptLabelName } from './crypto/labelCodec'
import type { RevisionPlainPayload } from './crypto/revisionCodec'
import {
  domSelectionRect,
  placeFormattingToolbar,
  textControlSelectionRect,
  type FormattingSelectionAnchor,
  type FormattingToolbarPosition,
} from './formattingToolbarLayout'
import {
  insertFencedCode,
  setHeadingLevel,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleList,
  toggleStrikethrough,
  toggleUnderline,
  type TextareaSnapshot,
} from './markdownFormatting'
import { renderMarkdown, renderMarkdownInline } from './markdown/renderMarkdown'
import { fromWire, getCachedNoteKey, setCachedNoteKey, toWire } from './notesCipher'
import { selectionFromPreviewClick, type PendingEditorSelection } from './previewCursor'
import { RenderedMarkdown } from './RenderedMarkdown'
import { buildEncryptedRevision } from './revisionSnapshots'
import { RichBlockEditor } from './richtext/RichBlockEditor'
import { RichInlineEditor } from './richtext/RichInlineEditor'
import { Tooltip } from './Tooltip'
import type {
  Attachment,
  ChecklistItem,
  CreateNoteRevisionRequest,
  EncryptedNoteWrite,
  Note,
  NoteRevisionDetail,
  SaveState,
} from './types'
import { newMutationId, nowIso } from './offline/lww'
import { createId, errorMessage, isNoteEmpty, NOTE_COLORS, INDENT_DRAG_THRESHOLD_PX, MAX_ITEM_INDENT, normalizeIndents } from './utils'
import { useVault } from './vault/VaultContext'

type TextEditMode = 'edit' | 'rich' | 'preview'

interface NoteEditorProps {
  note: Note
  knownLabels?: string[]
  cancelIfEmpty?: boolean
  startInEditMode?: boolean
  online?: boolean
  persistLocal?: (
    noteId: string,
    write: EncryptedNoteWrite,
    draft: Note,
    baselineRevision?: CreateNoteRevisionRequest | null,
  ) => Promise<Note>
  ensureLabelIds: (names: string[]) => Promise<string[]>
  onClose: () => void
  onOptimistic: (note: Note) => void
  onCanonical: (note: Note) => void
  onDelete: (note: Note) => Promise<boolean>
  onDiscard: (note: Note) => Promise<void>
}

function labelMapFromNames(names: string[], ids: string[]): Map<string, string> {
  const map = new Map<string, string>()
  names.forEach((name, index) => {
    const id = ids[index]
    if (id) map.set(id, name)
  })
  return map
}

function isConflict(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 409
  )
}

/** Drop server-rendered HTML so cards show the live raw draft until save completes. */
function clearRenderedPreview(note: Note): Note {
  return {
    ...note,
    contentRendered: '',
    items: note.items.map((item) =>
      item.textRendered ? { ...item, textRendered: '' } : item,
    ),
  }
}

interface SortableChecklistRowProps {
  item: ChecklistItem
  index: number
  itemCount: number
  previousIndent: number
  mode: TextEditMode
  previewHtml?: string
  pendingOffset?: number | null
  onPendingOffsetConsumed?: () => void
  onToggle: (id: string, checked: boolean) => void
  onTextChange: (id: string, text: string) => void
  onFocusItem: (id: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>, index: number) => void
  onRichEnter: (index: number) => void
  onRichBackspaceEmpty: (index: number) => void
  onRichEditorReady: (id: string, editor: Editor | null) => void
  onMove: (index: number, direction: -1 | 1) => void
  onIndent: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
}

function SortableChecklistRow({
  item,
  index,
  itemCount,
  previousIndent,
  mode,
  previewHtml = '',
  pendingOffset = null,
  onPendingOffsetConsumed,
  onToggle,
  onTextChange,
  onFocusItem,
  onKeyDown,
  onRichEnter,
  onRichBackspaceEmpty,
  onRichEditorReady,
  onMove,
  onIndent,
  onRemove,
}: SortableChecklistRowProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const dragged = useRef(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  }
  const indent = item.indent ?? 0
  const canMoveUp = index > 0
  const canMoveDown = index < itemCount - 1
  const canIndent = index > 0 && indent < MAX_ITEM_INDENT && indent < previousIndent + 1
  const canDeindent = indent > 0
  const readOnly = mode === 'preview'
  const editable = mode === 'edit' || mode === 'rich'

  useEffect(() => {
    if (isDragging) {
      dragged.current = true
      setMenuOpen(false)
    }
  }, [isDragging])

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [menuOpen])

  return (
    <div
      className={`checklist-row${isDragging ? ' dragging' : ''}${readOnly ? ' preview' : ''}`}
      ref={setNodeRef}
      data-item-id={item.id}
      style={{ ...style, ['--item-indent' as string]: indent }}
    >
      <div className="drag-handle-wrap" ref={menuRef}>
        <Tooltip label={t('editor.checklist.dragHandle')}>
          <button
            type="button"
            className="drag-handle"
            aria-label={t('editor.checklist.itemActions', { index: index + 1 })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              if (dragged.current) {
                dragged.current = false
                return
              }
              setMenuOpen((open) => !open)
            }}
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" />
          </button>
        </Tooltip>
        {menuOpen && (
          <div className="checklist-item-menu" role="menu" aria-label={t('editor.checklist.itemActions', { index: index + 1 })}>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveUp}
              onClick={() => {
                onMove(index, -1)
                setMenuOpen(false)
              }}
            >
              <ArrowUp aria-hidden="true" /> {t('editor.checklist.moveUp')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveDown}
              onClick={() => {
                onMove(index, 1)
                setMenuOpen(false)
              }}
            >
              <ArrowDown aria-hidden="true" /> {t('editor.checklist.moveDown')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canIndent}
              onClick={() => {
                onIndent(item.id, 1)
                setMenuOpen(false)
              }}
            >
              <IndentIncrease aria-hidden="true" /> {t('editor.checklist.indent')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canDeindent}
              onClick={() => {
                onIndent(item.id, -1)
                setMenuOpen(false)
              }}
            >
              <IndentDecrease aria-hidden="true" /> {t('editor.checklist.deindent')}
            </button>
          </div>
        )}
      </div>
      <input
        type="checkbox"
        checked={item.checked}
        onChange={(event) => onToggle(item.id, event.target.checked)}
        aria-label={t('editor.checklist.markComplete', { item: item.text || t('editor.checklist.itemAriaLabel', { index: index + 1 }) })}
      />
      {mode === 'preview' ? (
        <div
          className={`checklist-item-preview${item.checked ? ' checked' : ''}`}
          aria-label={t('editor.checklist.itemAriaLabel', { index: index + 1 })}
        >
          {previewHtml ? (
            <RenderedMarkdown className="checklist-markdown" html={previewHtml} inline />
          ) : item.text ? (
            <span>{item.text}</span>
          ) : (
            <span className="editor-preview-empty">{t('editor.itemEmptyPreview')}</span>
          )}
        </div>
      ) : mode === 'rich' ? (
        <RichInlineEditor
          itemId={item.id}
          value={item.text}
          checked={item.checked}
          placeholder={t('editor.itemPlaceholder')}
          aria-label={t('editor.checklist.itemAriaLabel', { index: index + 1 })}
          pendingOffset={pendingOffset}
          onPendingOffsetConsumed={onPendingOffsetConsumed}
          onChange={(text) => onTextChange(item.id, text)}
          onFocus={() => onFocusItem(item.id)}
          onEnter={() => onRichEnter(index)}
          onBackspaceEmpty={() => onRichBackspaceEmpty(index)}
          onEditorReady={(editor) => onRichEditorReady(item.id, editor)}
        />
      ) : (
        <input
          data-item-id={item.id}
          value={item.text}
          onChange={(event) => onTextChange(item.id, event.target.value)}
          onFocus={() => onFocusItem(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={item.checked ? 'checked' : ''}
          placeholder={t('editor.itemPlaceholder')}
          aria-label={t('editor.checklist.itemAriaLabel', { index: index + 1 })}
        />
      )}
      {editable && (
        <Tooltip label={t('editor.checklist.deleteItem', { index: index + 1 })}>
          <button
            type="button"
            className="icon-button small"
            onClick={() => onRemove(item.id)}
            aria-label={t('editor.checklist.deleteItem', { index: index + 1 })}
          >
            <X />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function NoteEditor({
  note,
  knownLabels = [],
  cancelIfEmpty = false,
  startInEditMode: _startInEditMode = false,
  online = typeof navigator === 'undefined' ? true : navigator.onLine,
  persistLocal,
  ensureLabelIds,
  onClose,
  onOptimistic,
  onCanonical,
  onDelete,
  onDiscard,
}: NoteEditorProps) {
  const { t } = useTranslation()
  const { vaultKey } = useVault()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const editorContentAreaRef = useRef<HTMLDivElement>(null)
  const formattingToolbarRef = useRef<HTMLDivElement>(null)
  const updateFormattingToolbarRef = useRef<(target?: EventTarget | null) => void>(() => {})
  const pointerSelectingRef = useRef(false)
  const richBlockEditorRef = useRef<Editor | null>(null)
  const richInlineEditorsRef = useRef<Map<string, Editor>>(new Map())
  const labelMenuRef = useRef<HTMLDivElement>(null)
  const colorMenuRef = useRef<HTMLDivElement>(null)
  const newLabelRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(note)
  const latestDraft = useRef(note)
  const [revision, setRevision] = useState(0)
  const requestedRevision = useRef(0)
  const savedRevision = useRef(0)
  const saving = useRef(false)
  const saveFailed = useRef(false)
  const requestId = useRef(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [closing, setClosing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const baselineEnvelopeRef = useRef<Awaited<ReturnType<typeof buildEncryptedRevision>> | null>(null)
  const baselinePromiseRef = useRef<Promise<void> | null>(null)
  const baselineDoneRef = useRef(false)
  const skipBaselineRef = useRef(Boolean(cancelIfEmpty))
  const openingNoteRef = useRef(note)
  const [labelMenuOpen, setLabelMenuOpen] = useState(false)
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const [formattingSelectionAnchor, setFormattingSelectionAnchor] =
    useState<FormattingSelectionAnchor | null>(null)
  const [formattingToolbarPosition, setFormattingToolbarPosition] =
    useState<FormattingToolbarPosition | null>(null)
  const [textEditMode, setTextEditMode] = useState<TextEditMode>('rich')
  const [previewHtml, setPreviewHtml] = useState(note.contentRendered)
  const [itemPreviewHtml, setItemPreviewHtml] = useState<Record<string, string>>(() =>
    Object.fromEntries(note.items.map((item) => [item.id, item.textRendered])),
  )
  const focusedItemId = useRef<string | null>(note.items[0]?.id ?? null)
  const pendingSelection = useRef<PendingEditorSelection | null>(null)
  const [pendingRichOffset, setPendingRichOffset] = useState<number | null>(null)
  const [pendingRichItemId, setPendingRichItemId] = useState<string | null>(null)
  const [newLabelText, setNewLabelText] = useState('')
  const [labelError, setLabelError] = useState('')
  const [rememberedLabels, setRememberedLabels] = useState<string[]>(knownLabels)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    titleRef.current?.focus()
    return () => dialog.close()
  }, [])

  const prepareBaseline = useCallback(async (): Promise<CreateNoteRevisionRequest | null> => {
    if (skipBaselineRef.current || baselineDoneRef.current) return null
    if (!vaultKey) throw new Error(t('errors.vaultLocked'))
    let envelope = baselineEnvelopeRef.current
    if (!envelope) {
      const opening = openingNoteRef.current
      const noteKey = getCachedNoteKey(opening.id)
      if (!noteKey) throw new Error(t('notes.attachment.noteKeyUnavailableDetail'))
      envelope = await buildEncryptedRevision(opening, vaultKey, noteKey)
      baselineEnvelopeRef.current = envelope
    }
    return envelope
  }, [t, vaultKey])

  const ensureBaseline = useCallback(async () => {
    if (!online) return
    if (skipBaselineRef.current || baselineDoneRef.current) return
    if (baselinePromiseRef.current) {
      await baselinePromiseRef.current
      return
    }
    baselinePromiseRef.current = (async () => {
      const envelope = await prepareBaseline()
      if (!envelope) return
      await api.createNoteRevision(openingNoteRef.current.id, envelope)
      baselineDoneRef.current = true
    })()
    try {
      await baselinePromiseRef.current
    } finally {
      baselinePromiseRef.current = null
    }
  }, [online, prepareBaseline])

  useEffect(() => {
    if (
      !saving.current &&
      requestedRevision.current <= savedRevision.current &&
      note.version > latestDraft.current.version
    ) {
      latestDraft.current = note
      setDraft(note)
    }
  }, [note])

  useLayoutEffect(() => {
    if (!formattingSelectionAnchor) {
      setFormattingToolbarPosition(null)
      return
    }
    const dialog = dialogRef.current
    const toolbar = formattingToolbarRef.current
    if (!dialog || !toolbar) return

    const next = placeFormattingToolbar(dialog, toolbar, formattingSelectionAnchor)
    setFormattingToolbarPosition((previous) =>
      previous && previous.top === next.top && previous.left === next.left ? previous : next,
    )
  }, [formattingSelectionAnchor])

  useEffect(() => {
    setRememberedLabels((previous) => {
      let changed = false
      const names = new Map(previous.map((label) => [label.toLowerCase(), label]))
      for (const label of [...knownLabels, ...draft.labels]) {
        const key = label.toLowerCase()
        if (!names.has(key)) {
          names.set(key, label)
          changed = true
        }
      }
      if (!changed) return previous
      return [...names.values()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      )
    })
  }, [draft.labels, knownLabels])

  useEffect(() => {
    if (!labelMenuOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (!labelMenuRef.current?.contains(event.target as Node)) {
        setLabelMenuOpen(false)
        setNewLabelText('')
        setLabelError('')
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setLabelMenuOpen(false)
        setNewLabelText('')
        setLabelError('')
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape, true)
    window.setTimeout(() => newLabelRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [labelMenuOpen])

  useEffect(() => {
    if (!colorMenuOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (!colorMenuRef.current?.contains(event.target as Node)) {
        setColorMenuOpen(false)
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setColorMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [colorMenuOpen])

  useEffect(() => {
    if (draft.type !== 'TEXT' || textEditMode !== 'preview') return
    const timer = window.setTimeout(() => {
      setPreviewHtml(renderMarkdown(draft.contentRaw, draft.attachments))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [draft.attachments, draft.contentRaw, draft.type, textEditMode])

  useEffect(() => {
    if (textEditMode !== 'edit') return
    const selection = pendingSelection.current
    if (!selection) return
    pendingSelection.current = null

    window.requestAnimationFrame(() => {
      if (latestDraft.current.type === 'LIST') {
        const input = document.querySelector<HTMLInputElement>(
          `input[data-item-id="${focusedItemId.current ?? ''}"]`,
        )
        if (!input) return
        input.focus()
        const start = Math.min(selection.start, input.value.length)
        input.setSelectionRange(start, start)
        return
      }

      const textarea = bodyRef.current
      if (!textarea) return
      textarea.focus()
      const start = Math.min(selection.start, textarea.value.length)
      textarea.setSelectionRange(start, start)
    })
  }, [textEditMode, draft.type])

  function activeRichEditor(): Editor | null {
    if (latestDraft.current.type === 'LIST') {
      const id = focusedItemId.current
      return id ? richInlineEditorsRef.current.get(id) ?? null : null
    }
    return richBlockEditorRef.current
  }

  function applyRichFormat(command: (editor: Editor) => void) {
    const editor = activeRichEditor()
    if (!editor) return
    command(editor)
  }

  useEffect(() => {
    if (draft.type !== 'LIST' || textEditMode !== 'preview') return
    const timer = window.setTimeout(() => {
      setItemPreviewHtml(
        Object.fromEntries(
          draft.items.map((item) => [
            item.id,
            !item.text.trim()
              ? ''
              : item.textRendered || renderMarkdownInline(item.text),
          ]),
        ),
      )
    }, 220)
    return () => window.clearTimeout(timer)
  }, [draft.items, draft.type, textEditMode])

  const flush = useCallback(async () => {
    if (saving.current || requestedRevision.current <= savedRevision.current) return
    if (!vaultKey) {
      setSaveState('error')
      setSaveError(t('editor.saveError.vaultLocked'))
      saveFailed.current = true
      return
    }
    saving.current = true
    const capturedRevision = requestedRevision.current
    const capturedDraft = latestDraft.current
    const thisRequest = ++requestId.current
    saveFailed.current = false
    setSaveState('saving')
    setSaveError('')
    try {
      const labelIds =
        online || capturedDraft.labelIds.length > 0
          ? online
            ? await ensureLabelIds(capturedDraft.labels)
            : capturedDraft.labelIds
          : capturedDraft.labelIds
      const withLabels = { ...capturedDraft, labelIds }
      latestDraft.current = withLabels
      setDraft(withLabels)
      const labelMap = labelMapFromNames(withLabels.labels, labelIds)
      const clientUpdatedAt = nowIso()
      const clientMutationId = newMutationId()
      const wire = await toWire(
        withLabels.id,
        {
          type: withLabels.type,
          title: withLabels.title,
          contentRaw: withLabels.contentRaw,
          items: withLabels.items,
          labelIds,
          backgroundColor: withLabels.backgroundColor,
          archived: withLabels.archived,
          pinned: withLabels.pinned,
          version: withLabels.version,
        },
        vaultKey,
        { clientUpdatedAt, clientMutationId },
      )
      if (persistLocal) {
        // Persist locally first so flaky networks cannot block durability.
        const baselineRevision = await prepareBaseline()
        const canonical = await persistLocal(withLabels.id, wire, {
          ...withLabels,
          clientUpdatedAt,
          clientMutationId,
        }, baselineRevision)
        if (thisRequest === requestId.current) {
          savedRevision.current = capturedRevision
          onCanonical(canonical)
          if (requestedRevision.current === capturedRevision) {
            latestDraft.current = canonical
            setDraft(canonical)
            setSaveState('saved')
          } else {
            const merged = {
              ...latestDraft.current,
              version: canonical.version,
              updatedAt: canonical.updatedAt,
              clientUpdatedAt: canonical.clientUpdatedAt,
              clientMutationId: canonical.clientMutationId,
              attachments: canonical.attachments,
              labelIds: canonical.labelIds,
              labels: canonical.labels,
            }
            latestDraft.current = merged
            setDraft(merged)
            onOptimistic(merged)
          }
        }
        return
      }
      await ensureBaseline()
      const response = await api.updateNote(withLabels.id, wire)
      const canonical = await fromWire(response, vaultKey, labelMap)
      if (thisRequest === requestId.current) {
        savedRevision.current = capturedRevision
        onCanonical(canonical)
        if (requestedRevision.current === capturedRevision) {
          latestDraft.current = canonical
          setDraft(canonical)
          setSaveState('saved')
        } else {
          const merged = {
            ...latestDraft.current,
            version: canonical.version,
            updatedAt: canonical.updatedAt,
            attachments: canonical.attachments,
            labelIds: canonical.labelIds,
            labels: canonical.labels,
          }
          latestDraft.current = merged
          setDraft(merged)
          onOptimistic(merged)
        }
      }
    } catch (reason) {
      if (thisRequest === requestId.current) {
        let message = errorMessage(reason)
        if (isConflict(reason)) {
          try {
            const serverWire = await api.note(capturedDraft.id)
            if (thisRequest === requestId.current) {
              const labelMap = labelMapFromNames(
                latestDraft.current.labels,
                latestDraft.current.labelIds,
              )
              const serverNote = await fromWire(serverWire, vaultKey, labelMap)
              const rebased = {
                ...latestDraft.current,
                attachments: serverNote.attachments,
                version: serverNote.version,
                updatedAt: serverNote.updatedAt,
              }
              latestDraft.current = rebased
              setDraft(rebased)
              onOptimistic(rebased)
              message = t('editor.saveError.conflictRetry')
            }
          } catch {
            message = t('editor.saveError.conflictUnrefreshable')
          }
        }
        saveFailed.current = true
        setSaveState('error')
        setSaveError(message)
      }
    } finally {
      saving.current = false
      if (
        requestedRevision.current > savedRevision.current &&
        thisRequest === requestId.current &&
        requestedRevision.current !== capturedRevision
      ) {
        void flush()
      }
    }
  }, [ensureBaseline, ensureLabelIds, onCanonical, onOptimistic, online, persistLocal, prepareBaseline, t, vaultKey])

  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    if (!revision) return
    // Local-first path persists quickly; network-only path keeps the longer coalesce.
    const delay = persistLocal ? 50 : 650
    const timer = window.setTimeout(() => void flushRef.current(), delay)
    return () => window.clearTimeout(timer)
  }, [persistLocal, revision])

  function change(mutator: (current: Note) => Note) {
    const next = clearRenderedPreview(mutator(latestDraft.current))
    latestDraft.current = next
    requestedRevision.current += 1
    setRevision(requestedRevision.current)
    setDraft(next)
    setSaveState('dirty')
    setSaveError('')
    onOptimistic(next)
  }

  function applyMarkdownFormat(
    transform: (snapshot: TextareaSnapshot) => {
      value: string
      selectionStart: number
      selectionEnd: number
    },
  ) {
    if (latestDraft.current.type === 'LIST') {
      const active = document.activeElement
      const itemInput =
        active instanceof HTMLInputElement && active.dataset.itemId
          ? active
          : (document.querySelector(
              `input[data-item-id="${focusedItemId.current ?? ''}"]`,
            ) as HTMLInputElement | null)
      if (!itemInput?.dataset.itemId) return
      const itemId = itemInput.dataset.itemId
      focusedItemId.current = itemId
      const patch = transform({
        value: itemInput.value,
        selectionStart: itemInput.selectionStart ?? itemInput.value.length,
        selectionEnd: itemInput.selectionEnd ?? itemInput.value.length,
      })
      change((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === itemId ? { ...item, text: patch.value, textRendered: '' } : item,
        ),
      }))
      window.requestAnimationFrame(() => {
        const target = document.querySelector(
          `input[data-item-id="${itemId}"]`,
        ) as HTMLInputElement | null
        if (!target) return
        target.focus()
        target.setSelectionRange(patch.selectionStart, patch.selectionEnd)
      })
      return
    }

    const textarea = bodyRef.current
    if (!textarea) return
    const patch = transform({
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    })
    change((current) => ({ ...current, contentRaw: patch.value }))
    window.requestAnimationFrame(() => {
      const target = bodyRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(patch.selectionStart, patch.selectionEnd)
    })
  }

  function updateFormattingToolbar(target?: EventTarget | null) {
    if (pointerSelectingRef.current) return
    if (target instanceof Element && target.closest('.formatting-toolbar')) return

    const area = editorContentAreaRef.current
    if (!area || textEditMode === 'preview') {
      setFormattingSelectionAnchor(null)
      setFormattingToolbarPosition(null)
      return
    }

    const activeElement =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target
        : document.activeElement
    let selectionRect: DOMRect | null = null
    if (
      (activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement) &&
      area.contains(activeElement)
    ) {
      selectionRect = textControlSelectionRect(activeElement)
    } else {
      selectionRect = domSelectionRect('.rich-block-editor, .rich-inline-editor')
    }

    if (!selectionRect || (selectionRect.width === 0 && selectionRect.height === 0)) {
      setFormattingSelectionAnchor(null)
      setFormattingToolbarPosition(null)
      return
    }

    setFormattingSelectionAnchor({
      top: selectionRect.top,
      bottom: selectionRect.bottom,
      centerX: selectionRect.left + selectionRect.width / 2,
    })
  }
  updateFormattingToolbarRef.current = updateFormattingToolbar

  useEffect(() => {
    if (textEditMode === 'preview') return

    const onSelectionChange = () => {
      // Ignore in-progress mouse drags; show only after selection finishes.
      if (pointerSelectingRef.current) return
      updateFormattingToolbarRef.current()
    }
    const endPointerSelecting = () => {
      if (!pointerSelectingRef.current) return
      pointerSelectingRef.current = false
      updateFormattingToolbarRef.current()
      // Selection can settle after the pointer gesture (especially on touch).
      window.requestAnimationFrame(() => updateFormattingToolbarRef.current())
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerup', endPointerSelecting)
    document.addEventListener('pointercancel', endPointerSelecting)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerup', endPointerSelecting)
      document.removeEventListener('pointercancel', endPointerSelecting)
    }
  }, [textEditMode])

  function runFormat(
    markdown: (snapshot: TextareaSnapshot) => {
      value: string
      selectionStart: number
      selectionEnd: number
    },
    rich: (editor: Editor) => void,
  ) {
    if (textEditMode === 'rich') applyRichFormat(rich)
    else applyMarkdownFormat(markdown)
  }

  function formatButton(
    label: string,
    icon: ReactNode,
    markdown: (snapshot: TextareaSnapshot) => {
      value: string
      selectionStart: number
      selectionEnd: number
    },
    rich: (editor: Editor) => void,
  ) {
    return (
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => runFormat(markdown, rich)}
        >
          {icon}
        </button>
      </Tooltip>
    )
  }

  function clearFormattingToolbar() {
    setFormattingSelectionAnchor(null)
    setFormattingToolbarPosition(null)
  }

  function enterEditMode(selection: PendingEditorSelection | null = null) {
    if (selection) pendingSelection.current = selection
    setPendingRichOffset(null)
    setPendingRichItemId(null)
    clearFormattingToolbar()
    setTextEditMode('edit')
  }

  function enterRichMode(selection: PendingEditorSelection | null = null) {
    if (selection) {
      setPendingRichOffset(selection.start)
      setPendingRichItemId(focusedItemId.current)
    } else {
      setPendingRichOffset(null)
      setPendingRichItemId(null)
    }
    pendingSelection.current = null
    clearFormattingToolbar()
    setTextEditMode('rich')
  }

  function editFromPreview(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest('a, button, input, label, img')) return

    const itemRow = target.closest<HTMLElement>('[data-item-id]')
    const itemId = itemRow?.dataset.itemId
    const previewRoot = target.closest<HTMLElement>(
      '.rendered-content, .checklist-item-preview',
    )

    let selection: PendingEditorSelection | null = null
    if (previewRoot) {
      if (itemId) {
        const item = latestDraft.current.items.find((entry) => entry.id === itemId)
        if (item) {
          selection = selectionFromPreviewClick(
            previewRoot,
            event.clientX,
            event.clientY,
            item.text,
            true,
          )
        }
      } else {
        selection = selectionFromPreviewClick(
          previewRoot,
          event.clientX,
          event.clientY,
          latestDraft.current.contentRaw,
        )
      }
    }

    if (itemId) focusedItemId.current = itemId
    enterRichMode(selection)
  }

  function hasLabel(labels: string[], candidate: string) {
    const lower = candidate.toLowerCase()
    return labels.some((label) => label.toLowerCase() === lower)
  }

  function resolveLabelName(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const pool = [...rememberedLabels, ...knownLabels, ...latestDraft.current.labels]
    return pool.find((label) => label.toLowerCase() === trimmed.toLowerCase()) ?? trimmed
  }

  function rememberLabel(label: string) {
    setRememberedLabels((previous) => {
      if (previous.some((item) => item.toLowerCase() === label.toLowerCase())) return previous
      return [...previous, label].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      )
    })
  }

  async function addLabel(raw: string, options: { keepMenuOpen?: boolean } = {}) {
    if (!online) {
      setLabelError(t('notes.offline.requiresConnection'))
      return
    }
    const label = resolveLabelName(raw)
    if (!label) {
      setLabelError(t('editor.labels.emptyName'))
      return false
    }
    if (label.length > 500) {
      setLabelError(t('editor.labels.tooLong'))
      return false
    }
    if (hasLabel(latestDraft.current.labels, label)) {
      setLabelError(t('editor.labels.duplicate'))
      return false
    }
    rememberLabel(label)
    const nextLabels = [...latestDraft.current.labels, label]
    try {
      const labelIds = await ensureLabelIds(nextLabels)
      change((current) => ({ ...current, labels: nextLabels, labelIds }))
      setNewLabelText('')
      setLabelError('')
      if (!options.keepMenuOpen) setLabelMenuOpen(false)
      return true
    } catch (reason) {
      setLabelError(errorMessage(reason))
      return false
    }
  }

  function toggleMenuLabel(label: string) {
    if (hasLabel(latestDraft.current.labels, label)) {
      removeLabel(label)
      setLabelError('')
      return
    }
    void addLabel(label)
  }

  function removeLabel(label: string) {
    if (!online) return
    change((current) => {
      const index = current.labels.indexOf(label)
      return {
        ...current,
        labels: current.labels.filter((item) => item !== label),
        labelIds:
          index >= 0
            ? current.labelIds.filter((_, labelIndex) => labelIndex !== index)
            : current.labelIds,
      }
    })
  }

  function updateItem(id: string, patch: Partial<ChecklistItem>) {
    change((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }))
  }

  function withNormalizedItems(items: ChecklistItem[]) {
    return normalizeIndents(items).map((item, index) => ({ ...item, sortOrder: index }))
  }

  function addItem(afterIndex?: number) {
    const insertAt =
      typeof afterIndex === 'number' ? afterIndex + 1 : draft.items.length
    const previousIndent =
      draft.items[Math.max(0, insertAt - 1)]?.indent ?? draft.items.at(-1)?.indent ?? 0
    const item: ChecklistItem = {
      id: createId(),
      text: '',
      textRendered: '',
      checked: false,
      sortOrder: insertAt,
      indent: previousIndent,
    }
    change((current) => {
      const items = [...current.items]
      items.splice(insertAt, 0, item)
      return {
        ...current,
        items: withNormalizedItems(items),
      }
    })
    focusedItemId.current = item.id
    window.setTimeout(() => {
      if (textEditMode === 'rich') {
        richInlineEditorsRef.current.get(item.id)?.commands.focus('end')
        return
      }
      document.querySelector<HTMLInputElement>(`input[data-item-id="${item.id}"]`)?.focus()
    })
  }

  function richItemEnter(index: number) {
    addItem(index)
  }

  function richItemBackspaceEmpty(index: number) {
    if (draft.items.length <= 1) return
    const id = draft.items[index]?.id
    if (!id) return
    const previousId = draft.items[index - 1]?.id ?? draft.items[index + 1]?.id
    removeItem(id)
    if (previousId) {
      focusedItemId.current = previousId
      window.setTimeout(() => {
        richInlineEditorsRef.current.get(previousId)?.commands.focus('end')
      })
    }
  }

  function onRichInlineEditorReady(id: string, editor: Editor | null) {
    if (editor) richInlineEditorsRef.current.set(id, editor)
    else richInlineEditorsRef.current.delete(id)
  }

  function addCheckboxes() {
    change((current) => {
      const lines = current.contentRaw.split('\n').filter(Boolean)
      return {
        ...current,
        type: 'LIST',
        contentRaw: '',
        contentRendered: '',
        items: withNormalizedItems(
          (lines.length ? lines : ['']).map((text) => ({
            id: createId(),
            text,
            textRendered: '',
            checked: false,
            sortOrder: 0,
            indent: 0,
          })),
        ),
      }
    })
  }

  function removeCheckboxes() {
    change((current) => ({
      ...current,
      type: 'TEXT',
      contentRaw: current.items.map((item) => item.text).join('\n'),
      items: [],
    }))
  }

  function removeItem(id: string) {
    change((current) => ({
      ...current,
      items: withNormalizedItems(current.items.filter((item) => item.id !== id)),
    }))
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= draft.items.length) return
    change((current) => {
      const items = [...current.items]
      ;[items[index], items[target]] = [items[target], items[index]]
      return {
        ...current,
        items: withNormalizedItems(items),
      }
    })
  }

  function adjustItemIndent(id: string, delta: -1 | 1) {
    change((current) => {
      const index = current.items.findIndex((item) => item.id === id)
      if (index < 0) return current
      const items = current.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item
        return {
          ...item,
          indent: Math.max(0, Math.min(MAX_ITEM_INDENT, (item.indent ?? 0) + delta)),
        }
      })
      return { ...current, items: withNormalizedItems(items) }
    })
  }

  function reorderItems(event: DragEndEvent) {
    const { active, over, delta } = event
    const horizontal = Math.abs(delta.x) > Math.abs(delta.y) && Math.abs(delta.x) >= INDENT_DRAG_THRESHOLD_PX
    if (horizontal) {
      adjustItemIndent(String(active.id), delta.x > 0 ? 1 : -1)
      return
    }
    if (!over || active.id === over.id) return
    change((current) => {
      const oldIndex = current.items.findIndex((item) => item.id === active.id)
      const newIndex = current.items.findIndex((item) => item.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return current
      return {
        ...current,
        items: withNormalizedItems(arrayMove(current.items, oldIndex, newIndex)),
      }
    })
  }

  function itemKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key === 'Enter') {
      event.preventDefault()
      addItem(index)
    }
    if (event.key === 'Backspace' && !draft.items[index]?.text && draft.items.length > 1) {
      event.preventDefault()
      removeItem(draft.items[index].id)
    }
  }

  async function mergeServerMetadataFromWire() {
    if (!vaultKey) throw new Error(t('errors.vaultLocked'))
    const labelMap = labelMapFromNames(
      latestDraft.current.labels,
      latestDraft.current.labelIds,
    )
    const serverNote = await fromWire(await api.note(draft.id), vaultKey, labelMap)
    const next = {
      ...latestDraft.current,
      attachments: serverNote.attachments,
      version: serverNote.version,
      updatedAt: serverNote.updatedAt,
    }
    latestDraft.current = next
    setDraft(next)
    onCanonical(next)
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!online) {
      setUploadError(t('notes.offline.attachmentsRequireConnection'))
      return
    }
    setUploadError('')
    setUploadProgress(0)
    try {
      await ensureBaseline()
      const noteKey = getCachedNoteKey(draft.id)
      if (!noteKey) throw new Error(t('notes.attachment.noteKeyUnavailableDetail'))
      const attachmentId = createId()
      const mimeType = file.type || 'application/octet-stream'
      const kind = inferAttachmentKind(mimeType)
      const plainBytes = new Uint8Array(await file.arrayBuffer())
      const cipherBytes = await encryptAttachmentBytes(noteKey, attachmentId, plainBytes)
      const metaCiphertext = await encryptAttachmentMeta(noteKey, attachmentId, {
        originalFilename: file.name,
        mimeType,
        kind,
      })
      const wire = await api.uploadAttachment(
        draft.id,
        new Blob([
          cipherBytes.buffer.slice(
            cipherBytes.byteOffset,
            cipherBytes.byteOffset + cipherBytes.byteLength,
          ) as ArrayBuffer,
        ]),
        metaCiphertext,
        attachmentId,
        setUploadProgress,
      )
      const meta = await decryptAttachmentMeta(noteKey, wire.id, wire.metaCiphertext)
      const attachment: Attachment = {
        id: wire.id,
        kind: meta.kind ?? inferAttachmentKind(meta.mimeType),
        originalFilename: meta.originalFilename,
        mimeType: meta.mimeType,
        sizeBytes: wire.sizeBytes,
        createdAt: wire.createdAt,
        url: wire.url,
        metaCiphertext: wire.metaCiphertext,
      }
      const next = {
        ...latestDraft.current,
        attachments: [...latestDraft.current.attachments, attachment],
        version: latestDraft.current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      latestDraft.current = next
      setDraft(next)
      onCanonical(next)
      try {
        await mergeServerMetadataFromWire()
      } catch {
        setUploadError(t('editor.attachments.metadataRefreshFailedAfterUpload'))
      }
      if (requestedRevision.current === savedRevision.current) setSaveState('saved')
    } catch (reason) {
      setUploadError(errorMessage(reason))
    } finally {
      setUploadProgress(null)
    }
  }

  async function deleteAttachment(id: string) {
    setUploadError('')
    await ensureBaseline()
    await api.deleteAttachment(id)
    const next = {
      ...latestDraft.current,
      attachments: latestDraft.current.attachments.filter(
        (attachment) => attachment.id !== id,
      ),
      version: latestDraft.current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    latestDraft.current = next
    setDraft(next)
    onCanonical(next)
    try {
      await mergeServerMetadataFromWire()
    } catch {
      setUploadError(t('editor.attachments.metadataRefreshFailedAfterDelete'))
    }
  }

  async function removeNote() {
    setDeleting(true)
    try {
      if (await onDelete(draft)) onClose()
    } finally {
      setDeleting(false)
    }
  }

  async function close() {
    if (closing) return
    setClosing(true)
    setHistoryError('')
    if (cancelIfEmpty && isNoteEmpty(latestDraft.current)) {
      try {
        await onDiscard(latestDraft.current)
        onClose()
      } finally {
        setClosing(false)
      }
      return
    }
    do {
      await flush()
      while (saving.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 25))
      }
      if (saveFailed.current) {
        setClosing(false)
        return
      }
    } while (requestedRevision.current > savedRevision.current)

    // No server-side change this session → do not add a history entry.
    if (latestDraft.current.version === openingNoteRef.current.version) {
      onClose()
      return
    }

    if (!online) {
      onClose()
      return
    }

    if (!vaultKey) {
      setHistoryError(t('editor.history.snapshotFailed', { error: t('errors.vaultLocked') }))
      setClosing(false)
      return
    }
    try {
      const noteKey = getCachedNoteKey(latestDraft.current.id)
      if (!noteKey) throw new Error(t('notes.attachment.noteKeyUnavailableDetail'))
      const envelope = await buildEncryptedRevision(latestDraft.current, vaultKey, noteKey)
      await api.createNoteRevision(latestDraft.current.id, envelope)
      baselineDoneRef.current = true
    } catch (reason) {
      setHistoryError(t('editor.history.snapshotFailed', { error: errorMessage(reason) }))
      setClosing(false)
      return
    }
    onClose()
  }

  async function restoreRevision(
    revisionId: string,
    _detail: NoteRevisionDetail,
    payload: RevisionPlainPayload,
    revisionNoteKey: Uint8Array,
  ) {
    if (!vaultKey) throw new Error(t('errors.vaultLocked'))
    do {
      await flush()
      while (saving.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 25))
      }
      if (saveFailed.current) {
        throw new Error(saveError || t('editor.saveError.vaultLocked'))
      }
    } while (requestedRevision.current > savedRevision.current)

    const current = latestDraft.current
    const currentNoteKey = getCachedNoteKey(current.id)
    if (!currentNoteKey) throw new Error(t('notes.attachment.noteKeyUnavailableDetail'))
    const undoRevision = await buildEncryptedRevision(current, vaultKey, currentNoteKey)

    const existingLabels = await api.listLabels()
    const existingLabelIds = new Set(existingLabels.map((label) => label.id))
    const labelIds = payload.labelIds.filter((id) => existingLabelIds.has(id))
    const labelMap = new Map<string, string>()
    for (const wire of existingLabels) {
      if (!labelIds.includes(wire.id)) continue
      labelMap.set(wire.id, await decryptLabelName(vaultKey, wire.ciphertext))
    }

    const notePayload = buildNotePayload({
      title: payload.title,
      contentRaw: payload.contentRaw,
      items: payload.items.map((item) => ({
        ...item,
        textRendered: '',
      })),
      labelIds,
      type: payload.type,
    })
    const ciphertext = await encryptNotePayload(current.id, revisionNoteKey, notePayload)
    const wrappedNoteKey = await wrapNoteKey(vaultKey, current.id, revisionNoteKey)
    const response = await api.restoreNoteRevision(current.id, revisionId, {
      expectedVersion: current.version,
      undoRevision,
      type: payload.type,
      backgroundColor: payload.backgroundColor,
      archived: payload.archived,
      pinned: payload.pinned,
      wrappedNoteKey,
      ciphertext,
      labelIds,
      attachmentIds: payload.attachments.map((attachment) => attachment.id),
    })

    setCachedNoteKey(current.id, revisionNoteKey)
    const canonical = await fromWire(response.note, vaultKey, labelMap)
    latestDraft.current = canonical
    requestedRevision.current = savedRevision.current
    setDraft(canonical)
    setSaveState('saved')
    setSaveError('')
    onCanonical(canonical)

    if (response.unavailableAttachmentIds.length > 0) {
      const names = payload.attachments
        .filter((attachment) => response.unavailableAttachmentIds.includes(attachment.id))
        .map((attachment) => attachment.originalFilename)
      setHistoryError(
        t('editor.history.unavailableAttachments', {
          names: names.join(', ') || response.unavailableAttachmentIds.join(', '),
        }),
      )
    } else {
      setHistoryError('')
    }
  }

  const menuLabels = useMemo(() => {
    const names = new Map<string, string>()
    for (const label of [...rememberedLabels, ...knownLabels, ...draft.labels]) {
      const key = label.toLowerCase()
      if (!names.has(key)) names.set(key, label)
    }
    return [...names.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
  }, [draft.labels, knownLabels, rememberedLabels])

  const assignedLabels = useMemo(
    () => new Set(draft.labels.map((label) => label.toLowerCase())),
    [draft.labels],
  )

  const formattingToolbar =
    textEditMode === 'preview' || !formattingSelectionAnchor ? null : (
      <div
        ref={formattingToolbarRef}
        className="formatting-toolbar"
        role="toolbar"
        aria-label={t('editor.toolbar.formatting')}
        style={
          formattingToolbarPosition ?? {
            top: formattingSelectionAnchor.top - 62,
            left: formattingSelectionAnchor.centerX,
            visibility: 'hidden',
          }
        }
      >
        {draft.type === 'TEXT' ? (
          <>
            {formatButton(
              t('editor.toolbar.heading1'),
              <Heading1 aria-hidden="true" />,
              (snapshot) => setHeadingLevel(snapshot, 1),
              (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
            )}
            {formatButton(
              t('editor.toolbar.heading2'),
              <Heading2 aria-hidden="true" />,
              (snapshot) => setHeadingLevel(snapshot, 2),
              (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            )}
            {formatButton(
              t('editor.toolbar.normalText'),
              <Type aria-hidden="true" />,
              (snapshot) => setHeadingLevel(snapshot, 0),
              (editor) => editor.chain().focus().setParagraph().run(),
            )}
            {formatButton(
              t('editor.toolbar.codeBlock'),
              <Code2 aria-hidden="true" />,
              insertFencedCode,
              (editor) => editor.chain().focus().toggleCodeBlock().run(),
            )}
            <span className="formatting-menu-separator" aria-hidden="true" />
            {formatButton(
              t('editor.toolbar.bold'),
              <Bold aria-hidden="true" />,
              toggleBold,
              (editor) => editor.chain().focus().toggleBold().run(),
            )}
            {formatButton(
              t('editor.toolbar.italic'),
              <Italic aria-hidden="true" />,
              toggleItalic,
              (editor) => editor.chain().focus().toggleItalic().run(),
            )}
            {formatButton(
              t('editor.toolbar.underline'),
              <Underline aria-hidden="true" />,
              toggleUnderline,
              (editor) => editor.chain().focus().toggleUnderline().run(),
            )}
            {formatButton(
              t('editor.toolbar.strikethrough'),
              <Strikethrough aria-hidden="true" />,
              toggleStrikethrough,
              (editor) => editor.chain().focus().toggleStrike().run(),
            )}
            <span className="formatting-menu-separator" aria-hidden="true" />
            {formatButton(
              t('editor.toolbar.orderedList'),
              <ListOrdered aria-hidden="true" />,
              (snapshot) => toggleList(snapshot, 'ordered'),
              (editor) => editor.chain().focus().toggleOrderedList().run(),
            )}
            {formatButton(
              t('editor.toolbar.unorderedList'),
              <List aria-hidden="true" />,
              (snapshot) => toggleList(snapshot, 'unordered'),
              (editor) => editor.chain().focus().toggleBulletList().run(),
            )}
          </>
        ) : (
          <>
            {formatButton(
              t('editor.toolbar.bold'),
              <Bold aria-hidden="true" />,
              toggleBold,
              (editor) => editor.chain().focus().toggleBold().run(),
            )}
            {formatButton(
              t('editor.toolbar.italic'),
              <Italic aria-hidden="true" />,
              toggleItalic,
              (editor) => editor.chain().focus().toggleItalic().run(),
            )}
            {formatButton(
              t('editor.toolbar.strikethrough'),
              <Strikethrough aria-hidden="true" />,
              toggleStrikethrough,
              (editor) => editor.chain().focus().toggleStrike().run(),
            )}
            {formatButton(
              t('editor.toolbar.inlineCode'),
              <Code aria-hidden="true" />,
              toggleInlineCode,
              (editor) => editor.chain().focus().toggleCode().run(),
            )}
          </>
        )}
      </div>
    )

  return (
    <dialog
      ref={dialogRef}
      className="note-dialog"
      aria-label={t('editor.ariaLabel', { title: draft.title || t('editor.untitled') })}
      onCancel={(event) => {
        event.preventDefault()
        void close()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) void close()
      }}
    >
      <div
        className="editor"
        style={{ backgroundColor: draft.backgroundColor || '#ffffff' }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="editor-header">
          <span className={`save-status ${saveState}`} role="status" aria-live="polite">
            {saveState === 'saving' && <LoaderCircle className="spin" aria-hidden="true" />}
            {saveState === 'saved' && <Check aria-hidden="true" />}
            {saveState === 'error' && <CircleAlert aria-hidden="true" />}
            {saveState === 'dirty' && t('editor.saveStatus.dirty')}
            {saveState === 'saving' && t('editor.saveStatus.saving')}
            {saveState === 'saved' && t('editor.saveStatus.saved')}
            {saveState === 'error' && t('editor.saveStatus.error')}
          </span>
          <div className="editor-mode-tabs" role="tablist" aria-label={t('editor.modes.tablistAria')}>
            <button
              type="button"
              role="tab"
              className={textEditMode === 'edit' ? 'active' : undefined}
              onClick={() => enterEditMode()}
              aria-selected={textEditMode === 'edit'}
            >
              <Pencil aria-hidden="true" /> {t('editor.modes.markdown')}
            </button>
            <button
              type="button"
              role="tab"
              className={textEditMode === 'rich' ? 'active' : undefined}
              onClick={() => enterRichMode()}
              aria-selected={textEditMode === 'rich'}
            >
              <PenLine aria-hidden="true" /> {t('editor.modes.richEdit')}
            </button>
            <button
              type="button"
              role="tab"
              className={textEditMode === 'preview' ? 'active' : undefined}
              onClick={() => {
                clearFormattingToolbar()
                setTextEditMode('preview')
                setPendingRichOffset(null)
                setPendingRichItemId(null)
              }}
              aria-selected={textEditMode === 'preview'}
            >
              <Eye aria-hidden="true" /> {t('editor.modes.render')}
            </button>
          </div>
          <Tooltip label={t('editor.closeTooltip')}>
            <button
              type="button"
              className="icon-button"
              onClick={() => void close()}
              disabled={closing}
              aria-label={t('editor.close')}
            >
              {closing ? <LoaderCircle className="spin" /> : <X />}
            </button>
          </Tooltip>
        </header>

        <input
          ref={titleRef}
          className="editor-title"
          value={draft.title}
          onChange={(event) =>
            change((current) => ({ ...current, title: event.target.value }))
          }
          placeholder={t('editor.titlePlaceholder')}
          aria-label={t('editor.titleAria')}
        />

        <div
          className="editor-content-area"
          ref={editorContentAreaRef}
          onPointerDown={(event) => {
            if ((event.target as Element).closest?.('.formatting-toolbar')) return
            clearFormattingToolbar()
            // Touch/pen text selection is OS-driven (long-press / handles) and often
            // ends with pointercancel instead of pointerup. Only gate mouse drags.
            if (event.pointerType === 'mouse') {
              pointerSelectingRef.current = true
            }
          }}
          onKeyUp={(event) => updateFormattingToolbar(event.target)}
          onScrollCapture={() => updateFormattingToolbar()}
        >
          {draft.type === 'TEXT' ? (
            textEditMode === 'preview' ? (
              <div
                className="editor-markdown-preview"
                aria-label={t('editor.previewAria')}
                onClick={editFromPreview}
              >
                {previewHtml ? (
                  <RenderedMarkdown
                    className="rendered-content"
                    html={previewHtml}
                    noteId={draft.id}
                    attachments={draft.attachments}
                  />
                ) : (
                  <p className="editor-preview-empty">{t('editor.previewEmpty')}</p>
                )}
              </div>
            ) : textEditMode === 'rich' ? (
              <RichBlockEditor
                value={draft.contentRaw}
                attachments={draft.attachments}
                placeholder={t('editor.contentPlaceholder')}
                aria-label={t('editor.contentAria')}
                pendingOffset={pendingRichOffset}
                onPendingOffsetConsumed={() => setPendingRichOffset(null)}
                onChange={(contentRaw) =>
                  change((current) => ({ ...current, contentRaw }))
                }
                onEditorReady={(editor) => {
                  richBlockEditorRef.current = editor
                }}
              />
            ) : (
              <textarea
                ref={bodyRef}
                className="editor-body"
                value={draft.contentRaw}
                onChange={(event) =>
                  change((current) => ({ ...current, contentRaw: event.target.value }))
                }
                placeholder={t('editor.contentPlaceholder')}
                aria-label={t('editor.contentAria')}
              />
            )
          ) : (
            <div
              className={`checklist-editor${textEditMode === 'preview' ? ' preview-mode' : ''}${textEditMode === 'rich' ? ' rich-mode' : ''}`}
              aria-label={textEditMode === 'preview' ? t('editor.previewAria') : undefined}
              onClick={textEditMode === 'preview' ? editFromPreview : undefined}
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderItems}>
                <SortableContext
                  items={draft.items.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {draft.items.map((item, index) => (
                    <SortableChecklistRow
                      key={item.id}
                      item={item}
                      index={index}
                      itemCount={draft.items.length}
                      previousIndent={index > 0 ? (draft.items[index - 1].indent ?? 0) : 0}
                      mode={textEditMode}
                      previewHtml={itemPreviewHtml[item.id] ?? item.textRendered}
                      pendingOffset={
                        pendingRichItemId === item.id ? pendingRichOffset : null
                      }
                      onPendingOffsetConsumed={() => {
                        setPendingRichOffset(null)
                        setPendingRichItemId(null)
                      }}
                      onToggle={(id, checked) => updateItem(id, { checked })}
                      onTextChange={(id, text) => updateItem(id, { text })}
                      onFocusItem={(id) => {
                        focusedItemId.current = id
                      }}
                      onKeyDown={itemKeyDown}
                      onRichEnter={richItemEnter}
                      onRichBackspaceEmpty={richItemBackspaceEmpty}
                      onRichEditorReady={onRichInlineEditorReady}
                      onMove={moveItem}
                      onIndent={adjustItemIndent}
                      onRemove={removeItem}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {(textEditMode === 'edit' || textEditMode === 'rich') && (
                <button type="button" className="add-item" onClick={() => addItem()}>
                  <Plus aria-hidden="true" /> {t('editor.checklist.addItem')}
                </button>
              )}
            </div>
          )}
        </div>
        {formattingToolbar}

        <div className="editor-native-fields">
          <span className="editor-labels-caption" id="note-labels-caption">
            {t('editor.labels.caption')}
          </span>
          <div className="editor-labels" role="group" aria-labelledby="note-labels-caption">
            {draft.labels.map((label) => (
              <span className="label-chip" key={label}>
                <span className="label-chip-text">{label}</span>
                <Tooltip
                  label={
                    online
                      ? t('editor.labels.remove', { label })
                      : t('notes.offline.requiresConnection')
                  }
                >
                  <button
                    type="button"
                    className="label-chip-remove"
                    onClick={() => removeLabel(label)}
                    disabled={!online}
                    aria-label={t('editor.labels.remove', { label })}
                  >
                    <X aria-hidden="true" />
                  </button>
                </Tooltip>
              </span>
            ))}
            <div className="label-add-wrap" ref={labelMenuRef}>
              <Tooltip
                label={
                  online ? t('editor.labels.add') : t('notes.offline.requiresConnection')
                }
              >
                <button
                  type="button"
                  className="label-chip label-chip-add"
                  disabled={!online}
                  onClick={() => {
                    if (!online) return
                    setLabelMenuOpen((open) => !open)
                    setLabelError('')
                    setNewLabelText('')
                  }}
                  aria-label={t('editor.labels.add')}
                  aria-haspopup="menu"
                  aria-expanded={labelMenuOpen}
                >
                  <Plus aria-hidden="true" />
                </button>
              </Tooltip>
              {labelMenuOpen && (
                <div className="label-menu" role="menu" aria-label={t('editor.labels.add')}>
                  <div className="label-menu-create">
                    <label className="sr-only" htmlFor="new-note-label">
                      {t('editor.labels.newLabel')}
                    </label>
                    <input
                      ref={newLabelRef}
                      id="new-note-label"
                      type="text"
                      value={newLabelText}
                      maxLength={500}
                      placeholder={t('editor.labels.createPlaceholder')}
                      onChange={(event) => {
                        setNewLabelText(event.target.value)
                        setLabelError('')
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void addLabel(newLabelText, { keepMenuOpen: true })
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void addLabel(newLabelText, { keepMenuOpen: true })}
                    >
                      {t('editor.labels.create')}
                    </button>
                  </div>
                  {labelError && (
                    <p className="label-menu-error" role="alert">
                      {labelError}
                    </p>
                  )}
                  {menuLabels.length > 0 ? (
                    <ul className="label-menu-list">
                      {menuLabels.map((label) => {
                        const assigned = assignedLabels.has(label.toLowerCase())
                        return (
                          <li key={label}>
                            <button
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={assigned}
                              className={assigned ? 'selected' : undefined}
                              onClick={() => toggleMenuLabel(label)}
                            >
                              <span>{label}</span>
                              {assigned ? <Check aria-hidden="true" /> : null}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="label-menu-empty">{t('editor.labels.empty')}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {draft.attachments.length > 0 && (
          <section className="editor-attachments" aria-label={t('editor.attachments.aria')}>
            {draft.attachments.map((attachment) => (
              <AttachmentView
                key={attachment.id}
                noteId={draft.id}
                attachment={attachment}
                online={online}
                onDelete={online ? deleteAttachment : undefined}
              />
            ))}
          </section>
        )}

        {historyError && (
          <div className="save-error" role="alert">
            <span>{historyError}</span>
            <button
              type="button"
              onClick={() => {
                setHistoryError('')
                void close()
              }}
            >
              <RotateCcw aria-hidden="true" /> {t('editor.history.retrySnapshot')}
            </button>
          </div>
        )}
        {saveError && (
          <div className="save-error" role="alert">
            <span>{t('editor.saveError.preserved', { error: saveError })}</span>
            <button type="button" onClick={() => void flush()}>
              <RotateCcw aria-hidden="true" /> {t('editor.saveError.retry')}
            </button>
          </div>
        )}
        {uploadError && (
          <p className="save-error" role="alert">
            {uploadError}
          </p>
        )}
        {uploadProgress !== null && (
          <div className="upload-progress" role="status">
            <span>{t('editor.attachments.uploading', { progress: uploadProgress })}</span>
            <progress max="100" value={uploadProgress} />
          </div>
        )}

        <footer className="editor-footer">
          <div className="editor-tools editor-tools-left">
            <Tooltip label={draft.pinned ? t('editor.toolbar.unpin') : t('editor.toolbar.pin')}>
              <button
                type="button"
                className={`icon-button ${draft.pinned ? 'selected-tool' : ''}`}
                onClick={() => change((current) => ({ ...current, pinned: !current.pinned }))}
                aria-label={draft.pinned ? t('editor.toolbar.unpin') : t('editor.toolbar.pin')}
                aria-pressed={draft.pinned}
              >
                <Pin />
              </button>
            </Tooltip>
            <span className="editor-tool-separator" aria-hidden="true" />
            <div className="color-picker-wrap" ref={colorMenuRef}>
              <Tooltip label={t('editor.toolbar.colorPalette')}>
                <button
                  type="button"
                  className={`icon-button${colorMenuOpen ? ' selected-tool' : ''}`}
                  onClick={() => setColorMenuOpen((open) => !open)}
                  aria-label={t('editor.toolbar.colorPalette')}
                  aria-haspopup="menu"
                  aria-expanded={colorMenuOpen}
                >
                  <Palette />
                </button>
              </Tooltip>
              {colorMenuOpen && (
                <div className="color-picker-menu" role="menu" aria-label={t('editor.toolbar.noteColorAria')}>
                  {NOTE_COLORS.map((color) => {
                    const selected =
                      draft.backgroundColor === color.value ||
                      (color.value === '#ffffff' &&
                        (!draft.backgroundColor || draft.backgroundColor === 'default'))
                    return (
                      <Tooltip label={t(`editor.colors.${color.labelKey}`)} key={color.value}>
                        <button
                          type="button"
                          role="menuitemradio"
                          className={`color-swatch${selected ? ' selected' : ''}${color.value === '#ffffff' ? ' default' : ''}`}
                          style={{ backgroundColor: color.value }}
                          onClick={() =>
                            change((current) => ({
                              ...current,
                              backgroundColor: color.value,
                            }))
                          }
                          aria-label={t(`editor.colors.${color.labelKey}`)}
                          aria-checked={selected}
                        >
                          {color.value === '#ffffff' ? (
                            <DropletOff aria-hidden="true" />
                          ) : null}
                        </button>
                      </Tooltip>
                    )
                  })}
                </div>
              )}
            </div>
            <Tooltip
              label={draft.type === 'TEXT' ? t('editor.toolbar.addCheckboxes') : t('editor.toolbar.removeCheckboxes')}
            >
              <button
                type="button"
                className="icon-button"
                onClick={draft.type === 'TEXT' ? addCheckboxes : removeCheckboxes}
                aria-label={draft.type === 'TEXT' ? t('editor.toolbar.addCheckboxes') : t('editor.toolbar.removeCheckboxes')}
              >
                {draft.type === 'TEXT' ? <ListChecks /> : <ListX />}
              </button>
            </Tooltip>
            <Tooltip
              label={
                online
                  ? t('editor.attachments.upload')
                  : t('notes.offline.attachmentsRequireConnection')
              }
            >
              <label className={`icon-button file-picker${online ? '' : ' disabled'}`}>
                <Paperclip aria-hidden="true" />
                <span className="sr-only">{t('editor.attachments.upload')}</span>
                <input
                  type="file"
                  disabled={!online}
                  onChange={(event) => void upload(event)}
                />
              </label>
            </Tooltip>
            <HistoryToolButton
              label={
                online ? t('editor.history.open') : t('notes.offline.requiresConnection')
              }
              onClick={() => {
                if (!online) return
                setHistoryOpen(true)
              }}
            />
          </div>
          <div className="editor-tools editor-tools-right">
            <Tooltip
              label={
                online
                  ? draft.archived
                    ? t('editor.toolbar.restore')
                    : t('editor.toolbar.archive')
                  : t('notes.offline.requiresConnection')
              }
            >
              <button
                type="button"
                className="icon-button"
                disabled={!online}
                onClick={() =>
                  change((current) => ({ ...current, archived: !current.archived }))
                }
                aria-label={draft.archived ? t('editor.toolbar.restore') : t('editor.toolbar.archive')}
              >
                {draft.archived ? <ArchiveRestore /> : <Archive />}
              </button>
            </Tooltip>
            <Tooltip
              label={
                online ? t('editor.toolbar.delete') : t('notes.offline.requiresConnection')
              }
            >
              <button
                type="button"
                className="icon-button danger"
                onClick={() => void removeNote()}
                disabled={deleting || !online}
                aria-label={t('editor.toolbar.delete')}
              >
                {deleting ? <LoaderCircle className="spin" /> : <Trash2 />}
              </button>
            </Tooltip>
          </div>
        </footer>
        {vaultKey && (
          <NoteChangeHistory
            noteId={draft.id}
            currentVersion={draft.version}
            vaultKey={vaultKey}
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onRestore={restoreRevision}
          />
        )}
      </div>
    </dialog>
  )
}
