import { i18n } from '../i18n'
import { nowIso } from '../offline/lww'
import type { LocalRepository } from '../offline/repository'
import { ingestPlainNotes, type ImportResult, type PlainImportNote } from '../vaultImport/ingest'
import { unzipArchive } from '../vaultImport/unzip'
import { BackupFormatError, parseBackupEntries, type BackupNote } from './format'
import { MAX_UNCOMPRESSED_BYTES, MAX_UNCOMPRESSED_MIB, MAX_ZIP_BYTES, MAX_ZIP_MIB } from './limits'

function backupError(error: unknown): Error {
  if (error instanceof BackupFormatError) {
    if (error.code === 'unsupportedVersion') {
      return new Error(i18n.t('backup.restore.errors.unsupportedVersion', { version: error.version }))
    }
    return new Error(i18n.t('backup.restore.errors.invalidManifest'))
  }
  return error instanceof Error ? error : new Error(i18n.t('import.warnings.unknownError'))
}

function toPlainNote(
  note: BackupNote,
  labelNamesById: Map<string, string>,
  attachmentBytes: Record<string, Uint8Array>,
  warnings: string[],
): PlainImportNote {
  const attachments: PlainImportNote['attachments'] = []
  for (const attachment of note.attachments) {
    const bytes = attachmentBytes[attachment.id]
    if (!bytes) {
      warnings.push(
        i18n.t('import.warnings.missingAttachment', {
          relative: attachment.originalFilename,
          path: note.id,
        }),
      )
      continue
    }
    attachments.push({
      filename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      bytes,
    })
  }
  return {
    sourcePath: `notes/${note.id}.json`,
    type: note.type,
    title: note.title,
    contentRaw: note.contentRaw,
    items: note.items.map((item) => ({
      ...item,
      textRendered: '',
    })),
    labelNames: note.labelIds.map((id) => labelNamesById.get(id) ?? id),
    backgroundColor: note.backgroundColor,
    archived: note.archived,
    pinned: note.pinned,
    clientUpdatedAt: note.clientUpdatedAt || note.createdAt || nowIso(),
    attachments,
  }
}

export async function importBackupZip(options: {
  file: File
  vaultKey: Uint8Array
  repo: LocalRepository
  existingLabels: Map<string, string>
  extraLabelNames?: string[]
  onProgress: (percent: number) => void
}): Promise<ImportResult> {
  const { file, vaultKey, repo, extraLabelNames = [], onProgress } = options
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(i18n.t('backup.restore.errors.zipTooLarge', { max: MAX_ZIP_MIB }))
  }
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = unzipArchive(
    zipBytes,
    MAX_UNCOMPRESSED_BYTES,
    i18n.t('backup.restore.errors.unzipTooLarge', { max: MAX_UNCOMPRESSED_MIB }),
  )
  let archive
  try {
    archive = parseBackupEntries(entries)
  } catch (error) {
    throw backupError(error)
  }
  const warnings: string[] = []
  const labelNamesById = new Map(archive.labels.map((label) => [label.id, label.name]))
  const notes: PlainImportNote[] = []
  let skipped = 0
  for (const note of archive.notes) {
    try {
      notes.push(toPlainNote(note, labelNamesById, archive.attachmentBytes, warnings))
    } catch (error) {
      skipped += 1
      warnings.push(
        i18n.t('import.warnings.skipped', {
          path: note.id,
          error: error instanceof Error ? error.message : i18n.t('import.warnings.unknownError'),
        }),
      )
    }
  }
  const result = await ingestPlainNotes({
    notes,
    vaultKey,
    repo,
    existingLabels: options.existingLabels,
    extraLabelNames,
    ensureLabelNames: archive.labels.map((label) => label.name),
    onProgress,
  })
  return {
    imported: result.imported,
    skipped: result.skipped + skipped,
    warnings: [...warnings, ...result.warnings],
  }
}
