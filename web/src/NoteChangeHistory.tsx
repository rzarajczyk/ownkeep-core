import { Check, History, LoaderCircle, Pencil, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import {
  REVISION_LABEL_MAX_LENGTH,
  decryptRevisionLabel,
  encryptRevisionLabel,
  type RevisionPlainPayload,
} from './crypto/revisionCodec'
import { renderMarkdown, renderMarkdownInline } from './markdown/renderMarkdown'
import { decryptRevisionDetail } from './revisionSnapshots'
import type { NoteRevisionDetail, NoteRevisionSummary } from './types'
import { errorMessage } from './utils'
import { Tooltip } from './Tooltip'

interface NoteChangeHistoryProps {
  noteId: string
  currentVersion: number
  vaultKey: Uint8Array
  open: boolean
  onClose: () => void
  onRestore: (
    revisionId: string,
    detail: NoteRevisionDetail,
    payload: RevisionPlainPayload,
    noteKey: Uint8Array,
  ) => Promise<void>
}

export function NoteChangeHistory({
  noteId,
  currentVersion,
  vaultKey,
  open,
  onClose,
  onRestore,
}: NoteChangeHistoryProps) {
  const { t } = useTranslation()
  const [items, setItems] = useState<NoteRevisionSummary[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<NoteRevisionDetail | null>(null)
  const [payload, setPayload] = useState<RevisionPlainPayload | null>(null)
  const [selectedNoteKey, setSelectedNoteKey] = useState<Uint8Array | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [labelSaving, setLabelSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  const formatRevisionDate = useCallback(
    (createdAt: string) =>
      new Date(createdAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [],
  )

  const decryptLabels = useCallback(
    async (summaries: NoteRevisionSummary[]) => {
      const next: Record<string, string> = {}
      for (const summary of summaries) {
        if (!summary.labelCiphertext) continue
        try {
          next[summary.id] = await decryptRevisionLabel(
            vaultKey,
            noteId,
            summary.id,
            summary.labelCiphertext,
          )
        } catch {
          // Leave unlabeled if ciphertext cannot be decrypted.
        }
      }
      return next
    },
    [noteId, vaultKey],
  )

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (reset) {
        setLoading(true)
        setError('')
      } else {
        setLoadingMore(true)
      }
      try {
        const currentCursor = reset ? null : cursorRef.current
        const page = await api.listNoteRevisions(noteId, {
          createdBefore: currentCursor?.createdAt,
          afterId: currentCursor?.id,
          limit: 50,
        })
        const nextItems = reset ? page.items : [...itemsRef.current, ...page.items]
        setItems(nextItems)
        setHasMore(page.hasMore)
        setCursor(
          page.nextCreatedAt && page.nextAfterId
            ? { createdAt: page.nextCreatedAt, id: page.nextAfterId }
            : null,
        )
        const decoded = await decryptLabels(page.items)
        setLabels((previous) => (reset ? decoded : { ...previous, ...decoded }))
      } catch (reason) {
        setError(errorMessage(reason))
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [decryptLabels, noteId],
  )

  useEffect(() => {
    if (!open) return
    setItems([])
    setLabels({})
    setCursor(null)
    setSelectedId(null)
    setDetail(null)
    setPayload(null)
    setSelectedNoteKey(null)
    setEditingLabelId(null)
    void loadPage(true)
  }, [loadPage, noteId, open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (!editingLabelId) return
    labelInputRef.current?.focus()
    labelInputRef.current?.select()
  }, [editingLabelId])

  useEffect(() => {
    if (!open || !selectedId) return
    const controller = new AbortController()
    setPreviewLoading(true)
    setError('')
    void api
      .getNoteRevision(noteId, selectedId, controller.signal)
      .then(async (revision) => {
        const decrypted = await decryptRevisionDetail(noteId, revision, vaultKey)
        if (controller.signal.aborted) return
        setDetail(revision)
        setPayload(decrypted.payload)
        setSelectedNoteKey(decrypted.noteKey)
        setLabelDraft(labels[revision.id] ?? '')
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(errorMessage(reason))
          setDetail(null)
          setPayload(null)
          setSelectedNoteKey(null)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false)
      })
    return () => controller.abort()
  }, [labels, noteId, open, selectedId, vaultKey])

  function startEditingLabel(item: NoteRevisionSummary) {
    setSelectedId(item.id)
    setLabelDraft(labels[item.id] ?? '')
    setEditingLabelId(item.id)
  }

  async function saveLabel(item: NoteRevisionSummary) {
    setLabelSaving(true)
    setError('')
    try {
      const trimmed = labelDraft.trim()
      const labelCiphertext =
        trimmed.length === 0
          ? null
          : await encryptRevisionLabel(vaultKey, noteId, item.id, trimmed)
      const updated = await api.updateNoteRevisionLabel(noteId, item.id, labelCiphertext)
      setItems((previous) =>
        previous.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      )
      setDetail((previous) => (previous ? { ...previous, ...updated } : previous))
      setLabels((previous) => {
        const next = { ...previous }
        if (trimmed) next[updated.id] = trimmed
        else delete next[updated.id]
        return next
      })
      setEditingLabelId(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLabelSaving(false)
    }
  }

  async function restore() {
    if (!detail || !payload || !selectedNoteKey) return
    if (!window.confirm(t('editor.history.restoreConfirm'))) return
    setRestoring(true)
    setError('')
    try {
      await onRestore(detail.id, detail, payload, selectedNoteKey)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRestoring(false)
    }
  }

  if (!open) return null

  return createPortal(
    <dialog
      ref={dialogRef}
      className="note-history-dialog"
      aria-label={t('editor.history.aria')}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <section className="note-history-panel" onClick={(event) => event.stopPropagation()}>
      <header className="note-history-header">
        <div>
          <p className="eyebrow">{t('editor.history.eyebrow')}</p>
          <h2>{t('editor.history.title')}</h2>
        </div>
        <Tooltip label={t('editor.history.close')}>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('editor.history.close')}
          >
            <X aria-hidden="true" />
          </button>
        </Tooltip>
      </header>

      {error && (
        <p className="save-error" role="alert">
          {error}
        </p>
      )}

      <div className="note-history-body">
        <div className="note-history-list" role="listbox" aria-label={t('editor.history.listAria')}>
          {loading ? (
            <p className="note-history-empty">
              <LoaderCircle className="spin" aria-hidden="true" /> {t('editor.history.loading')}
            </p>
          ) : items.length === 0 ? (
            <p className="note-history-empty">{t('editor.history.empty')}</p>
          ) : (
            items.map((item) => {
              const isCurrent =
                item.origin !== 'CONFLICT_LOCAL' &&
                item.origin !== 'CONFLICT_REMOTE' &&
                item.sourceVersion === currentVersion
              const hasCustomLabel = Boolean(labels[item.id]?.trim())
              const displayName =
                labels[item.id]?.trim() ||
                t('editor.history.unlabeled', { date: formatRevisionDate(item.createdAt) })
              return (
              <div
                key={item.id}
                role="option"
                aria-selected={selectedId === item.id}
                className={`note-history-item${selectedId === item.id ? ' selected' : ''}${isCurrent ? ' current' : ''}`}
              >
                {editingLabelId === item.id ? (
                  <form
                    className="note-history-inline-label"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveLabel(item)
                    }}
                  >
                    <input
                      ref={labelInputRef}
                      type="text"
                      value={labelDraft}
                      maxLength={REVISION_LABEL_MAX_LENGTH}
                      placeholder={t('editor.history.labelPlaceholder')}
                      aria-label={t('editor.history.label')}
                      disabled={labelSaving}
                      onChange={(event) => setLabelDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditingLabelId(null)
                        }
                      }}
                    />
                    <button
                      type="submit"
                      className="icon-button"
                      disabled={labelSaving}
                      aria-label={t('editor.history.saveLabel')}
                    >
                      {labelSaving ? (
                        <LoaderCircle className="spin" aria-hidden="true" />
                      ) : (
                        <Check aria-hidden="true" />
                      )}
                    </button>
                  </form>
                ) : (
                  <div className="note-history-item-title-row">
                    <button
                      type="button"
                      className="note-history-item-name"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <strong>{displayName}</strong>
                    </button>
                    <button
                      type="button"
                      className="note-history-item-edit"
                      onClick={() => startEditingLabel(item)}
                      aria-label={t('editor.history.editLabel', { label: displayName })}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                  </div>
                )}
                {(hasCustomLabel || isCurrent) && (
                  <button
                    type="button"
                    className="note-history-item-select"
                    onClick={() => setSelectedId(item.id)}
                  >
                    {hasCustomLabel && <span>{formatRevisionDate(item.createdAt)}</span>}
                    {isCurrent && (
                      <span className="note-history-current-badge">
                        {t('editor.history.current')}
                      </span>
                    )}
                  </button>
                )}
              </div>
            )})
          )}
          {hasMore && (
            <button
              type="button"
              className="secondary-button"
              disabled={loadingMore}
              onClick={() => void loadPage(false)}
            >
              {loadingMore ? t('editor.history.loadingMore') : t('editor.history.loadMore')}
            </button>
          )}
        </div>

        <div className="note-history-preview">
          {!selectedId ? (
            <p className="note-history-empty">{t('editor.history.selectPrompt')}</p>
          ) : previewLoading || !payload ? (
            <p className="note-history-empty">
              <LoaderCircle className="spin" aria-hidden="true" /> {t('editor.history.loadingPreview')}
            </p>
          ) : (
            <>
              <div className="note-history-meta">
                <span>
                  {payload.pinned ? t('editor.history.pinned') : t('editor.history.unpinned')}
                </span>
                <span>
                  {payload.archived ? t('editor.history.archived') : t('editor.history.active')}
                </span>
                <span>
                  {payload.type === 'LIST' ? t('editor.history.listNote') : t('editor.history.textNote')}
                </span>
              </div>

              <h3>{payload.title || t('editor.untitled')}</h3>
              {payload.type === 'TEXT' ? (
                payload.contentRaw.trim() ? (
                  <div
                    className="editor-preview markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(payload.contentRaw) }}
                  />
                ) : (
                  <p className="editor-preview-empty">{t('editor.previewEmpty')}</p>
                )
              ) : (
                <ul className="note-history-checklist">
                  {payload.items.map((item) => (
                    <li key={item.id} className={item.checked ? 'checked' : undefined}>
                      <span
                        dangerouslySetInnerHTML={{ __html: renderMarkdownInline(item.text) }}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {payload.attachments.length > 0 && (
                <section aria-label={t('editor.attachments.aria')}>
                  <h4>{t('editor.history.attachments')}</h4>
                  <ul className="note-history-attachments">
                    {payload.attachments.map((attachment) => (
                      <li key={attachment.id}>{attachment.originalFilename}</li>
                    ))}
                  </ul>
                </section>
              )}

              <button
                type="button"
                className="primary-button"
                disabled={restoring}
                onClick={() => void restore()}
              >
                {restoring ? (
                  <>
                    <LoaderCircle className="spin" aria-hidden="true" /> {t('editor.history.restoring')}
                  </>
                ) : (
                  <>
                    <RotateCcw aria-hidden="true" /> {t('editor.history.restore')}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
      </section>
    </dialog>,
    document.body,
  )
}

export function HistoryToolButton({
  onClick,
  label,
}: {
  onClick: () => void
  label: string
}) {
  return (
    <Tooltip label={label}>
      <button type="button" className="icon-button" onClick={onClick} aria-label={label}>
        <History aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
