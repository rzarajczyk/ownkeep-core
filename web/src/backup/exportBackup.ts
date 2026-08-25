import { decryptAttachmentBytes } from '../crypto/attachmentCodec'
import { i18n } from '../i18n'
import { localDateStamp } from '../keepImport/labels'
import { decryptLabels, fromWire, getCachedNoteKey } from '../notesCipher'
import { api } from '../api'
import type { LocalRepository } from '../offline/repository'
import type { Attachment, EncryptedLabelWire, Note } from '../types'
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
  const labelWires = await api.listLabels()
  const idToName = await decryptLabels(vaultKey, labelWires)
  const records = await repo.listNotes()
  const warnings: string[] = []
  const notes: BackupNote[] = []
  const attachmentBytes: Record<string, Uint8Array> = {}
  const labels = labelsFromWires(labelWires, idToName)
  const total = Math.max(records.length, 1)

  if (records.length === 0) onProgress(90)

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    try {
      const note = await fromWire(record.wire, vaultKey, idToName)
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
