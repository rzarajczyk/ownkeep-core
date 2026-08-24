import { FileUp, LoaderCircle, Printer } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from '../types'
import { Tooltip } from '../Tooltip'
import { exportNeedsAttachments } from './attachments'
import { downloadNoteFile, printNoteHtml } from './download'
import { exportNote } from './exportNote'
import type { ExportFormat } from './types'

interface ExportMenuProps {
  note: Note
  online: boolean
  onError: (message: string) => void
}

const FILE_FORMATS: Array<{ format: ExportFormat; labelKey: string }> = [
  { format: 'md', labelKey: 'markdown' },
  { format: 'md-zip', labelKey: 'markdownZip' },
  { format: 'html', labelKey: 'html' },
  { format: 'txt', labelKey: 'plainText' },
]

const OFFICE_FORMATS: Array<{ format: ExportFormat; labelKey: string }> = [
  { format: 'odt', labelKey: 'odt' },
  { format: 'docx', labelKey: 'docx' },
  { format: 'rtf', labelKey: 'rtf' },
]

export function ExportMenu({ note, online, onError }: ExportMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeMenu = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  function formatAvailable(format: ExportFormat): boolean {
    if (exporting) return false
    const need = exportNeedsAttachments(format, note)
    if (need === 'none') return true
    return online
  }

  async function run(format: ExportFormat) {
    if (!formatAvailable(format)) return
    setExporting(true)
    onError('')
    try {
      const result = await exportNote(note, format)
      if (result.errors.length) onError(result.errors.join(' '))
      if (result.kind === 'print') printNoteHtml(result.html)
      else downloadNoteFile(result.filename, result.blob)
      setOpen(false)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }

  function menuButton(format: ExportFormat, label: ReactNode, extraClass?: string) {
    const available = formatAvailable(format)
    const button = (
      <button
        type="button"
        role="menuitem"
        className={extraClass}
        disabled={!available}
        onClick={() => void run(format)}
      >
        {label}
      </button>
    )
    if (available) return button
    return <Tooltip label={t('notes.offline.requiresConnection')}>{button}</Tooltip>
  }

  return (
    <div className="export-menu-wrap" ref={wrapRef}>
      <Tooltip label={exporting ? t('editor.export.exporting') : t('editor.export.open')}>
        <button
          type="button"
          className={`icon-button${open ? ' selected-tool' : ''}`}
          onClick={() => setOpen((current) => !current)}
          aria-label={t('editor.export.open')}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={exporting}
        >
          {exporting ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileUp aria-hidden="true" />}
        </button>
      </Tooltip>
      {open && (
        <div className="export-menu" role="menu" aria-label={t('editor.export.menuAria')}>
          {FILE_FORMATS.map((item) => (
            <span key={item.format}>{menuButton(item.format, t(`editor.export.${item.labelKey}`))}</span>
          ))}
          <div className="export-menu-separator" role="separator" />
          {OFFICE_FORMATS.map((item) => (
            <span key={item.format}>{menuButton(item.format, t(`editor.export.${item.labelKey}`))}</span>
          ))}
          <div className="export-menu-separator" role="separator" />
          {menuButton(
            'print',
            <>
              <Printer aria-hidden="true" />
              {t('editor.export.printPdf')}
            </>,
            'export-print-item',
          )}
        </div>
      )}
    </div>
  )
}
