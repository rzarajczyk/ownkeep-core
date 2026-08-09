import { Archive, ArchiveRestore, MoreHorizontal, Pin, Trash2 } from 'lucide-react'
import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentView } from './AttachmentView'
import { RenderedMarkdown } from './RenderedMarkdown'
import type { Note } from './types'
import { linkify } from './utils'

interface NoteCardProps {
  note: Note
  onOpen: (note: Note) => void
  onArchive: (note: Note) => Promise<void>
  onDelete: (note: Note) => Promise<unknown>
}

export function NoteCard({ note, onOpen, onArchive, onDelete }: NoteCardProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [working, setWorking] = useState(false)

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
    if (target.closest('a, button, .card-actions, .popover-menu')) return
    onOpen(note)
  }

  return (
    <article
      className="note-card"
      style={{ backgroundColor: note.backgroundColor || '#ffffff' }}
      aria-label={note.title || t('notes.card.untitled')}
      tabIndex={0}
      onClick={openNote}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openNote(event)
        }
      }}
    >
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
            {note.labels.map((label) => <li key={label}>{label}</li>)}
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
