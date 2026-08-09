import DOMPurify from 'dompurify'
import type { ReactNode } from 'react'
import { ApiError } from './api'
import { i18n } from './i18n'
import type { Note, NoteWrite } from './types'

export const NOTE_COLORS = [
  { value: '#ffffff', labelKey: 'default' },
  { value: '#f28b82', labelKey: 'red' },
  { value: '#fbbc04', labelKey: 'orange' },
  { value: '#fff475', labelKey: 'yellow' },
  { value: '#ccff90', labelKey: 'green' },
  { value: '#a7ffeb', labelKey: 'teal' },
  { value: '#cbf0f8', labelKey: 'blue' },
  { value: '#aecbfa', labelKey: 'darkBlue' },
  { value: '#d7aefb', labelKey: 'purple' },
  { value: '#fdcfe8', labelKey: 'pink' },
  { value: '#e6c9a8', labelKey: 'brown' },
  { value: '#e8eaed', labelKey: 'gray' },
] as const

export type NoteColorLabelKey = (typeof NOTE_COLORS)[number]['labelKey']

export function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function noteToWrite(note: Note): NoteWrite {
  return {
    version: note.version,
    type: note.type,
    title: note.title,
    contentRaw: note.contentRaw,
    backgroundColor: note.backgroundColor,
    archived: note.archived,
    pinned: note.pinned,
    labels: note.labels,
    labelIds: note.labelIds,
    items: note.items.map((item, index) => ({
      id: item.id,
      text: item.text,
      checked: item.checked,
      sortOrder: index,
      indent: item.indent ?? 0,
    })),
  }
}

export function isNoteEmpty(note: Note) {
  if (note.attachments.length > 0) return false
  if (note.title.trim()) return false
  if (note.type === 'TEXT') return !note.contentRaw.trim()
  return note.items.every((item) => !item.text.trim())
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return i18n.t('common.bytes.b', { value: bytes })
  if (bytes < 1024 ** 2) return i18n.t('common.bytes.kb', { value: (bytes / 1024).toFixed(1) })
  return i18n.t('common.bytes.mb', { value: (bytes / 1024 ** 2).toFixed(1) })
}

export function linkify(text: string): ReactNode[] {
  const pattern = /(https?:\/\/[^\s<]+)/gi
  return text.split(pattern).map((part, index) =>
    /^https?:\/\/[^\s<]+$/i.test(part) ? (
      <a
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        key={`${part}-${index}`}
      >
        {part}
      </a>
    ) : (
      part
    ),
  )
}

export function sanitizedMarkup(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  })
  const document = new DOMParser().parseFromString(sanitized, 'text/html')
  document.querySelectorAll('a[href]').forEach((anchor) => {
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  })
  return {
    __html: document.body.innerHTML,
  }
}

export const MAX_ITEM_INDENT = 5
export const INDENT_DRAG_THRESHOLD_PX = 28

export function normalizeIndents<T extends { indent?: number }>(items: T[]): Array<T & { indent: number }> {
  let previousIndent = 0
  return items.map((item, index) => {
    const requested = Math.max(0, Math.min(item.indent ?? 0, MAX_ITEM_INDENT))
    const maxAllowed = index === 0 ? 0 : previousIndent + 1
    const indent = Math.min(requested, maxAllowed)
    previousIndent = indent
    return { ...item, indent }
  })
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const translated = translateApiError(error)
    if (translated) return translated
  }
  if (error instanceof Error && error.message) return error.message
  return i18n.t('errors.generic')
}

function translateApiError(error: ApiError): string | null {
  const code = error.code
  if (!code) return null

  switch (code) {
    case 'connection_failed':
      return i18n.t('errors.api.connectionFailed')
    case 'session_expired':
      return i18n.t('errors.api.sessionExpired')
    case 'request_failed':
      return i18n.t('errors.api.requestFailed', { status: error.status })
    case 'upload_failed':
      return i18n.t('errors.api.uploadFailed')
    case 'invalid_upload_response':
      return i18n.t('errors.api.invalidUploadResponse')
    case 'attachment_load_failed':
      return i18n.t('errors.api.attachmentLoadFailed')
    default: {
      const key = `errors.api.codes.${code}`
      if (i18n.exists(key)) return i18n.t(key)
      return null
    }
  }
}

export function optimisticNote(
  type: Note['type'],
  archived: boolean,
): Omit<Note, 'id'> {
  const now = new Date().toISOString()
  return {
    type,
    title: '',
    contentRaw: '',
    contentRendered: '',
    backgroundColor: '#ffffff',
    archived,
    pinned: false,
    labels: [],
    labelIds: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
    items: [],
    attachments: [],
  }
}
