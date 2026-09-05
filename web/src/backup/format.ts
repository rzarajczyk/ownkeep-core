import { zipSync } from 'fflate'
import type { AttachmentKind, NoteType } from '../types'
import { MAX_ITEM_INDENT } from '../utils'

export const BACKUP_FORMAT = 'ownkeep.backup'
export const BACKUP_VERSION = 1
export const BACKUP_ROOT = 'ownkeep-backup'

export class BackupFormatError extends Error {
  readonly code: 'invalidManifest' | 'unsupportedVersion'
  readonly version?: number

  constructor(code: 'invalidManifest' | 'unsupportedVersion', version?: number) {
    super(code)
    this.name = 'BackupFormatError'
    this.code = code
    this.version = version
  }
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
}

export interface BackupLabel {
  id: string
  name: string
  createdAt: string
}

export interface BackupAttachment {
  id: string
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
  createdAt: string
}

export interface BackupChecklistItem {
  id: string
  text: string
  checked: boolean
  sortOrder: number
  indent: number
}

export interface BackupNote {
  id: string
  type: NoteType
  title: string
  contentRaw: string
  backgroundColor: string
  archived: boolean
  pinned: boolean
  createdAt: string
  clientUpdatedAt: string
  labelIds: string[]
  items: BackupChecklistItem[]
  attachments: BackupAttachment[]
}

export interface BackupArchive {
  manifest: BackupManifest
  labels: BackupLabel[]
  notes: BackupNote[]
  attachmentBytes: Record<string, Uint8Array>
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function backupNotePath(noteId: string): string {
  return `${BACKUP_ROOT}/notes/${noteId}.json`
}

export function backupAttachmentPath(attachmentId: string): string {
  return `${BACKUP_ROOT}/attachments/${attachmentId}`
}

export function packBackupZip(archive: BackupArchive): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [`${BACKUP_ROOT}/manifest.json`]: encodeJson(archive.manifest),
    [`${BACKUP_ROOT}/labels.json`]: encodeJson(archive.labels),
  }
  for (const note of archive.notes) {
    entries[backupNotePath(note.id)] = encodeJson(note)
  }
  for (const [id, bytes] of Object.entries(archive.attachmentBytes)) {
    entries[backupAttachmentPath(id)] = copyBytes(bytes)
  }
  return zipSync(entries)
}

function normalizeEntries(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const normalized: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.includes('__MACOSX')) continue
    normalized[normalizePath(path)] = bytes
  }
  return normalized
}

export function parseBackupEntries(rawEntries: Record<string, Uint8Array>): BackupArchive {
  const entries = normalizeEntries(rawEntries)
  const paths = Object.keys(entries)
  const manifestPath = findManifestPath(paths, entries)
  if (!manifestPath) throw new BackupFormatError('invalidManifest')
  const root = dirname(manifestPath)
  const manifest = parseManifest(readJson(entries, manifestPath))
  const labels = parseLabels(readJson(entries, joinPath(root, 'labels.json'), true) ?? [])
  const notesPrefix = joinPath(root, 'notes/')
  const attachmentsPrefix = joinPath(root, 'attachments/')
  const notes: BackupNote[] = []
  for (const path of paths) {
    if (!isDirectChild(path, notesPrefix) || !path.toLowerCase().endsWith('.json')) continue
    try {
      notes.push(parseNote(readJson(entries, path)))
    } catch {
      throw new BackupFormatError('invalidManifest')
    }
  }
  const attachmentBytes: Record<string, Uint8Array> = {}
  for (const path of paths) {
    if (!isDirectChild(path, attachmentsPrefix)) continue
    const id = path.slice(attachmentsPrefix.length)
    if (!id) continue
    attachmentBytes[id] = entries[path]!
  }
  return { manifest, labels, notes, attachmentBytes }
}

export function looksLikeOwnKeepBackup(rawEntries: Record<string, Uint8Array>): boolean {
  try {
    const entries = normalizeEntries(rawEntries)
    const manifestPath = findManifestPath(Object.keys(entries), entries)
    if (!manifestPath) return false
    const manifest = parseManifest(readJson(entries, manifestPath))
    return manifest.format === BACKUP_FORMAT
  } catch {
    return false
  }
}

function findManifestPath(paths: string[], entries: Record<string, Uint8Array>): string | undefined {
  const candidates = paths.filter((path) => path.toLowerCase().endsWith('manifest.json'))
  const preferred = candidates.find(
    (path) => path === `${BACKUP_ROOT}/manifest.json` || path.endsWith(`/${BACKUP_ROOT}/manifest.json`),
  )
  const ordered = preferred ? [preferred, ...candidates.filter((path) => path !== preferred)] : candidates
  for (const path of ordered) {
    try {
      const json = readJson(entries, path)
      if (isRecord(json) && json.format === BACKUP_FORMAT) return path
    } catch {
      continue
    }
  }
  return ordered[0]
}

function joinPath(root: string, child: string): string {
  if (!root) return child
  return `${root.replace(/\/$/, '')}/${child}`
}

function isDirectChild(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false
  const rest = path.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/')
}

function readJson(entries: Record<string, Uint8Array>, path: string, optional = false): unknown {
  const bytes = entries[path]
  if (!bytes) {
    if (optional) return undefined
    throw new BackupFormatError('invalidManifest')
  }
  try {
    return JSON.parse(decodeText(bytes)) as unknown
  } catch {
    throw new BackupFormatError('invalidManifest')
  }
}

function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('invalidManifest')
  }
  const version = typeof value.version === 'number' ? value.version : Number(value.version)
  if (!Number.isInteger(version)) throw new BackupFormatError('invalidManifest')
  if (version !== BACKUP_VERSION) throw new BackupFormatError('unsupportedVersion', version)
  const exportedAt = typeof value.exportedAt === 'string' ? value.exportedAt : new Date().toISOString()
  return { format: BACKUP_FORMAT, version, exportedAt }
}

function parseLabels(value: unknown): BackupLabel[] {
  if (!Array.isArray(value)) throw new BackupFormatError('invalidManifest')
  const labels: BackupLabel[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!id || !name) continue
    labels.push({
      id,
      name,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    })
  }
  return labels
}

function parseNote(value: unknown): BackupNote {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('invalid note')
  }
  const items = Array.isArray(value.items) ? value.items.flatMap((item, index) => parseItem(item, index)) : []
  const type: NoteType = value.type === 'LIST' || items.length > 0 ? 'LIST' : 'TEXT'
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.flatMap((item) => parseAttachment(item))
    : []
  const labelIds = Array.isArray(value.labelIds)
    ? value.labelIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : []
  return {
    id: value.id,
    type,
    title: typeof value.title === 'string' ? value.title : '',
    contentRaw: typeof value.contentRaw === 'string' ? value.contentRaw : '',
    backgroundColor: typeof value.backgroundColor === 'string' ? value.backgroundColor : '#ffffff',
    archived: Boolean(value.archived),
    pinned: Boolean(value.pinned),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    clientUpdatedAt: typeof value.clientUpdatedAt === 'string' ? value.clientUpdatedAt : '',
    labelIds,
    items,
    attachments,
  }
}

function parseItem(value: unknown, index: number): BackupChecklistItem[] {
  if (!isRecord(value)) return []
  const indent = typeof value.indent === 'number' ? value.indent : 0
  return [
    {
      id: typeof value.id === 'string' && value.id ? value.id : `item-${index}`,
      text: typeof value.text === 'string' ? value.text : '',
      checked: Boolean(value.checked),
      sortOrder: typeof value.sortOrder === 'number' ? value.sortOrder : index,
      indent: Math.max(0, Math.min(indent, MAX_ITEM_INDENT)),
    },
  ]
}

function parseAttachment(value: unknown): BackupAttachment[] {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return []
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream'
  const kind: AttachmentKind =
    value.kind === 'IMAGE' || value.kind === 'FILE'
      ? value.kind
      : mimeType.startsWith('image/')
        ? 'IMAGE'
        : 'FILE'
  return [
    {
      id: value.id,
      originalFilename:
        typeof value.originalFilename === 'string' && value.originalFilename
          ? value.originalFilename
          : value.id,
      mimeType,
      kind,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    },
  ]
}
