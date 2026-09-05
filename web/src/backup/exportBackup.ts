import { decryptAttachmentBytes } from '../crypto/attachmentCodec'
import { i18n } from '../i18n'
import { localDateStamp } from '../keepImport/labels'
import { decryptLabels, fromWire, getCachedNoteKey } from '../notesCipher'
import { api } from '../api'
import type { LocalRepository } from '../offline/repository'
import type { Attachment, EncryptedLabelWire, EncryptedNoteWire, Note } from '../types'
import type { SyncCursor } from '../offline/types'
import { errorMessage } from '../utils'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  packBackupZip,
  type BackupArchive,
  type BackupLabel,
  type BackupNote,
} from './format'

export interface BackupExportResult {
  blob: Blob
  filename: string
  noteCount: number
  warnings: string[]
}

export async function exportBackupZip(options: {
  vaultKey: Uint8Array
  repo: LocalRepository
  onProgress: (percent: number) => void
  now?: Date
}): Promise<BackupExportResult> {
  const { vaultKey, repo, onProgress, now = new Date() } = options
  onProgress(0)
  const pendingNotes = await repo.listPendingNotes()
  const labelWires = await api.listLabels()
  const idToName = await decryptLabels(vaultKey, labelWires)
  const records = await listBackupNotes(pendingNotes)
  const warnings: string[] = []
  const notes: BackupNote[] = []
  const attachmentBytes: Record<string, Uint8Array> = {}
  const labels = labelsFromWires(labelWires, idToName)
  const total = Math.max(records.length, 1)

  if (records.length === 0) onProgress(90)

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    try {
      const note = await fromWire(record, vaultKey, idToName)
      const exported = await exportNote(note, attachmentBytes, warnings)
      mergeNoteLabels(labels, note, idToName)
      notes.push(exported)
    } catch (error) {
      warnings.push(
        i18n.t('backup.export.warnings.noteFailed', {
          id: record.id,
          error: error instanceof Error ? error.message : i18n.t('backup.export.warnings.unknownError'),
        }),
      )
    }
    onProgress(Math.round(((index + 1) / total) * 90))
  }

  onProgress(95)
  const archive: BackupArchive = {
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
    },
    labels,
    notes,
    attachmentBytes,
  }
  const zipBytes = packBackupZip(archive)
  onProgress(100)
  return {
    blob: new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
    filename: `ownkeep-backup-${localDateStamp(now)}.zip`,
    noteCount: notes.length,
    warnings,
  }
}

async function listBackupNotes(pendingNotes: EncryptedNoteWire[]): Promise<EncryptedNoteWire[]> {
  const notes = new Map<string, EncryptedNoteWire>()
  let cursor: SyncCursor = {}
  while (true) {
    const page = await api.notes({ limit: 100, ...cursor })
    for (const wire of page.items) notes.set(wire.id, wire)
    for (const id of page.deletedIds) notes.delete(id)
    if (!page.hasMore) break
    if (
      !page.nextUpdatedAfter || !page.nextAfterId ||
      (page.nextUpdatedAfter === cursor.updatedAfter && page.nextAfterId === cursor.afterId)
    ) {
      throw new Error(i18n.t('backup.export.errors.incompleteSync'))
    }
    cursor = { updatedAfter: page.nextUpdatedAfter, afterId: page.nextAfterId }
  }
  for (const pending of pendingNotes) {
    const remote = notes.get(pending.id)
    notes.set(pending.id, { ...pending, attachments: remote?.attachments ?? pending.attachments })
  }
  return [...notes.values()]
}

function labelsFromWires(wires: EncryptedLabelWire[], idToName: Map<string, string>): BackupLabel[] {
  return wires.map((wire) => ({
    id: wire.id,
    name: idToName.get(wire.id) ?? wire.id,
    createdAt: wire.createdAt,
  }))
}

function mergeNoteLabels(labels: BackupLabel[], note: Note, idToName: Map<string, string>) {
  const known = new Set(labels.map((label) => label.id))
  for (let index = 0; index < note.labelIds.length; index += 1) {
    const id = note.labelIds[index]!
    if (known.has(id)) continue
    labels.push({
      id,
      name: note.labels[index] ?? idToName.get(id) ?? id,
      createdAt: note.createdAt,
    })
    known.add(id)
  }
}

async function exportNote(
  note: Note,
  attachmentBytes: Record<string, Uint8Array>,
  warnings: string[],
): Promise<BackupNote> {
  const attachments: BackupNote['attachments'] = []
  for (const attachment of note.attachments) {
    try {
      attachmentBytes[attachment.id] = await decryptAttachment(note.id, attachment)
      attachments.push({
        id: attachment.id,
        originalFilename: attachment.originalFilename,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        createdAt: attachment.createdAt,
      })
    } catch (error) {
      warnings.push(
        i18n.t('backup.export.warnings.attachmentFailed', {
          name: attachment.originalFilename,
          title: note.title || note.id,
          error: errorMessage(error),
        }),
      )
    }
  }
  return {
    id: note.id,
    type: note.type,
    title: note.title,
    contentRaw: note.contentRaw,
    backgroundColor: note.backgroundColor,
    archived: note.archived,
    pinned: note.pinned,
    createdAt: note.createdAt,
    clientUpdatedAt: note.clientUpdatedAt ?? note.updatedAt,
    labelIds: note.labelIds,
    items: note.items.map((item) => ({
      id: item.id,
      text: item.text,
      checked: item.checked,
      sortOrder: item.sortOrder,
      indent: item.indent,
    })),
    attachments,
  }
}

async function decryptAttachment(noteId: string, attachment: Attachment): Promise<Uint8Array> {
  const noteKey = getCachedNoteKey(noteId)
  if (!noteKey) {
    throw new Error(i18n.t('notes.attachment.noteKeyUnavailable'))
  }
  const cipher = await api.attachmentCipherBlob(attachment.id, attachment.url)
  return decryptAttachmentBytes(noteKey, attachment.id, new Uint8Array(cipher))
}
