import { Archive, ArchiveRestore, MoreHorizontal, Pin, Trash2 } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentView } from './AttachmentView'
import { RenderedMarkdown } from './RenderedMarkdown'
import { useOnline } from './offline/useOnline'
import type { Note } from './types'
import { linkify } from './utils'

export const NOTE_LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE_PX = 10

interface NoteCardProps {
  note: Note
  onOpen: (note: Note) => void
  onArchive: (note: Note) => Promise<void>
  onDelete: (note: Note) => Promise<unknown>
  selectionMode?: boolean
  selected?: boolean
  onSelectionChange?: (note: Note, selected: boolean) => void
}

export function NoteCard({
  note,
  onOpen,
  onArchive,
  onDelete,
  selectionMode = false,
  selected = false,
  onSelectionChange,
}: NoteCardProps) {
  const { t } = useTranslation()
  const online = useOnline()
  const [menuOpen, setMenuOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [pressing, setPressing] = useState(false)
  const longPressTimer = useRef<number | null>(null)
  const suppressResetTimer = useRef<number | null>(null)
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null)
  const suppressNextClick = useRef(false)

  function cancelLongPress() {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    pointerOrigin.current = null
    setPressing(false)
  }

  function clearClickSuppression() {
    if (suppressResetTimer.current !== null) {
      window.clearTimeout(suppressResetTimer.current)
      suppressResetTimer.current = null
    }
    suppressNextClick.current = false
  }

  function finishLongPress() {
    const suppressReleaseClick = suppressNextClick.current
    cancelLongPress()
    if (!suppressReleaseClick) return
    suppressResetTimer.current = window.setTimeout(() => {
      suppressNextClick.current = false
      suppressResetTimer.current = null
    }, 0)
  }

  function abortLongPress() {
    cancelLongPress()
    clearClickSuppression()
  }

  useEffect(
    () => () => {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
      if (suppressResetTimer.current !== null) window.clearTimeout(suppressResetTimer.current)
    },
    [],
  )

  async function act(action: () => Promise<unknown>) {
    setWorking(true)
    setMenuOpen(false)
    try {
      await action()
    } finally {
      setWorking(false)
    }
  }

  function openNote(event: MouseEvent | KeyboardEvent) {
    const target = event.target as HTMLElement
    if (suppressNextClick.current) {
      clearClickSuppression()
      event.preventDefault()
      return
    }
    if (target.closest('.note-selection-control')) return
    if (selectionMode) {
      event.preventDefault()
      onSelectionChange?.(note, !selected)
      return
    }
    if (target.closest('a, button, input, .card-actions, .popover-menu')) return
    onOpen(note)
  }

  function startLongPress(event: ReactPointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (
      selectionMode ||
      event.pointerType === 'mouse' ||
      target.closest('a, button, input, .card-actions, .popover-menu')
    ) {
      return
    }
    cancelLongPress()
    pointerOrigin.current = { x: event.clientX, y: event.clientY }
    setPressing(true)
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null
      pointerOrigin.current = null
      suppressNextClick.current = true
      setPressing(false)
      onSelectionChange?.(note, true)
    }, NOTE_LONG_PRESS_MS)
  }

  function moveLongPress(event: ReactPointerEvent<HTMLElement>) {
    const origin = pointerOrigin.current
    if (
      !origin ||
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <=
        LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      return
    }
    cancelLongPress()
  }

  return (
    <article
      className={`note-card${selectionMode ? ' selection-mode' : ''}${selected ? ' selected' : ''}${pressing ? ' long-press-pending' : ''}`}
      style={{ backgroundColor: note.backgroundColor || '#ffffff' }}
      data-note-id={note.id}
      aria-label={note.title || t('notes.card.untitled')}
      tabIndex={0}
      onClick={openNote}
      onPointerDown={startLongPress}
      onPointerMove={moveLongPress}
      onPointerUp={finishLongPress}
      onPointerCancel={abortLongPress}
      onPointerLeave={abortLongPress}
      onContextMenu={(event) => {
        if (pressing || suppressNextClick.current) event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openNote(event)
        }
      }}
    >
      <label
        className="note-selection-control"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelectionChange?.(note, event.target.checked)}
          aria-label={
            selected
              ? t('notes.batch.deselectNote', {
                  title: note.title || t('notes.card.untitled'),
                })
              : t('notes.batch.selectNote', {
                  title: note.title || t('notes.card.untitled'),
                })
          }
        />
        <span aria-hidden="true" />
      </label>
      <div className="card-open">
        {note.pinned && <Pin className="card-pin" aria-label={t('notes.card.pinned')} />}
        {note.attachments
          .filter((attachment) => attachment.kind === 'IMAGE')
          .slice(0, 1)
          .map((attachment) => (
            <AttachmentView
              noteId={note.id}
              attachment={attachment}
              compact
              online={online}
              key={attachment.id}
            />
          ))}
        {note.title ? <h2>{note.title}</h2> : null}
        {note.type === 'TEXT' ? (
          note.contentRendered ? (
            <RenderedMarkdown
              className="rendered-content"
              html={note.contentRendered}
              noteId={note.id}
              attachments={note.attachments}
            />
          ) : (
            note.contentRaw && <p className="plain-content">{linkify(note.contentRaw)}</p>
          )
        ) : (
          <ul className="card-checklist" aria-label={t('notes.card.checklist')}>
            {note.items.slice(0, 8).map((item) => (
              <li
                className={item.checked ? 'checked' : ''}
                data-indent={item.indent ?? 0}
                key={item.id}
              >
                <span aria-hidden="true">{item.checked ? '✓' : ''}</span>
                {item.textRendered ? (
                  <RenderedMarkdown
                    className="checklist-markdown"
                    html={item.textRendered}
                    noteId={note.id}
                    inline
                  />
                ) : (
                  <span>{linkify(item.text)}</span>
                )}
              </li>
            ))}
            {note.items.length > 8 && (
              <li className="more-items">{t('notes.card.moreItems', { count: note.items.length - 8 })}</li>
            )}
          </ul>
        )}
        {note.labels.length > 0 && (
          <ul className="note-labels" aria-label={t('notes.card.labels')}>
            {note.labels.map((label, index) => <li key={`${label}-${index}`}>{label}</li>)}
          </ul>
        )}
      </div>

      {note.attachments.filter((attachment) => attachment.kind === 'FILE').length > 0 && (
        <div className="card-files">
          {note.attachments
            .filter((attachment) => attachment.kind === 'FILE')
            .map((attachment) => (
              <AttachmentView
                noteId={note.id}
                attachment={attachment}
                compact
                key={attachment.id}
              />
            ))}
        </div>
      )}

      <footer className="card-actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="icon-button"
          onClick={() => void act(() => onArchive(note))}
          disabled={working}
          aria-label={note.archived ? t('notes.card.restore') : t('notes.card.archive')}
        >
          {note.archived ? <ArchiveRestore /> : <Archive />}
        </button>
        <div className="menu-wrap">
          <button
            type="button"
            className="icon-button"
            aria-label={t('notes.card.moreActions')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal />
          </button>
          {menuOpen && (
            <div className="popover-menu">
              <button type="button" onClick={() => void act(() => onDelete(note))}>
                <Trash2 aria-hidden="true" /> {t('notes.card.delete')}
              </button>
            </div>
          )}
        </div>
      </footer>
    </article>
  )
}
