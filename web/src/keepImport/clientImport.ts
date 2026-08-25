import { i18n } from '../i18n'
import { nowIso } from '../offline/lww'
import type { LocalRepository } from '../offline/repository'
import type { ChecklistItem, NoteType } from '../types'
import { MAX_ITEM_INDENT } from '../utils'
import { ingestPlainNotes, type ImportResult, type PlainImportNote } from '../vaultImport/ingest'
import { unzipArchive } from '../vaultImport/unzip'
import { looksLikeOwnKeepBackup } from '../backup/format'
import { mapKeepColor } from './keepColors'
import { MAX_UNCOMPRESSED_BYTES, MAX_UNCOMPRESSED_MIB, MAX_ZIP_BYTES, MAX_ZIP_MIB } from './limits'

export type { ImportResult as KeepImportResult }

interface KeepListItem {
  text?: string
  isChecked?: boolean
  childListItems?: KeepListItem[]
}

interface KeepNoteJson {
  title?: string
  textContent?: string
  listContent?: KeepListItem[]
  isArchived?: boolean
  isPinned?: boolean
  isTrashed?: boolean
  labelIds?: Array<{ name?: string }>
  labels?: Array<{ name?: string }>
  attachments?: Array<{ filePath?: string; name?: string; mimetype?: string }>
  color?: string
  userEditedTimestampUsec?: number | string
  createdTimestampUsec?: number | string
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

function isKeepNote(value: unknown): value is KeepNoteJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return [
    'textContent',
    'listContent',
    'isArchived',
    'isPinned',
    'isTrashed',
    'userEditedTimestampUsec',
    'createdTimestampUsec',
    'attachments',
  ].some((key) => key in record)
}

function usecToIso(value: unknown): string | null {
  const micros =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(micros)) return null
  const date = new Date(Math.floor(micros / 1000))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function flattenListItems(items: KeepListItem[], indent = 0): ChecklistItem[] {
  const out: ChecklistItem[] = []
  for (const item of items) {
    out.push({
      id: crypto.randomUUID(),
      text: item.text ?? '',
      checked: Boolean(item.isChecked),
      sortOrder: out.length,
      indent: Math.min(indent, MAX_ITEM_INDENT),
      textRendered: '',
    })
    if (Array.isArray(item.childListItems) && item.childListItems.length > 0) {
      for (const child of flattenListItems(item.childListItems, indent + 1)) {
        out.push({ ...child, sortOrder: out.length })
      }
    }
  }
  return out
}

export async function importKeepZip(options: {
  file: File
  vaultKey: Uint8Array
  repo: LocalRepository
  existingLabels: Map<string, string>
  extraLabelNames?: string[]
  onProgress: (percent: number) => void
}): Promise<ImportResult> {
  const { file, vaultKey, repo, extraLabelNames = [], onProgress } = options
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(i18n.t('import.errors.zipTooLarge', { max: MAX_ZIP_MIB }))
  }
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = unzipArchive(
    zipBytes,
    MAX_UNCOMPRESSED_BYTES,
    i18n.t('import.errors.unzipTooLarge', { max: MAX_UNCOMPRESSED_MIB }),
  )
  if (looksLikeOwnKeepBackup(entries)) {
    throw new Error(i18n.t('import.errors.ownkeepBackup'))
  }
  const warnings: string[] = []
  const noteFiles = Object.keys(entries).filter((name) => name.toLowerCase().endsWith('.json'))
  const notes: PlainImportNote[] = []
  let skipped = 0

  for (const path of noteFiles) {
    try {
      const json: unknown = JSON.parse(decodeText(entries[path]!))
      if (!isKeepNote(json)) continue
      if (json.isTrashed) {
        skipped += 1
        continue
      }
      const keepAttachments = json.attachments ?? []
      const listItems = Array.isArray(json.listContent) ? flattenListItems(json.listContent) : []
      const hasText = Boolean(json.title?.trim() || json.textContent?.trim() || listItems.length)
      if (!hasText && keepAttachments.length === 0) {
        skipped += 1
        continue
      }
      const isList = listItems.length > 0
      const type: NoteType = isList ? 'LIST' : 'TEXT'
      const labelNames = [...(json.labels ?? []), ...(json.labelIds ?? [])]
        .map((item) => item.name?.trim())
        .filter((name): name is string => Boolean(name))
      const mappedColor = mapKeepColor(json.color)
      if (mappedColor.unknown) {
        warnings.push(i18n.t('import.warnings.unknownColor', { color: json.color ?? '', path }))
      }
      const attachments: PlainImportNote['attachments'] = []
      for (const attachment of keepAttachments) {
        const relative = attachment.filePath || attachment.name
        if (!relative) continue
        const candidate =
          Object.keys(entries).find(
            (name) => name.endsWith(relative) || basename(name) === basename(relative),
          ) ?? null
        if (!candidate) {
          warnings.push(i18n.t('import.warnings.missingAttachment', { relative, path }))
          continue
        }
        attachments.push({
          filename: basename(relative),
          mimeType: attachment.mimetype ?? 'application/octet-stream',
          bytes: entries[candidate]!,
        })
      }
      notes.push({
        sourcePath: path,
        type,
        title: json.title ?? '',
        contentRaw: type === 'TEXT' ? (json.textContent ?? '') : '',
        items: listItems,
        labelNames,
        backgroundColor: mappedColor.color,
        archived: Boolean(json.isArchived),
        pinned: Boolean(json.isPinned),
        clientUpdatedAt:
          usecToIso(json.userEditedTimestampUsec) ?? usecToIso(json.createdTimestampUsec) ?? nowIso(),
        attachments,
      })
    } catch (error) {
      skipped += 1
      warnings.push(
        i18n.t('import.warnings.skipped', {
          path,
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
    onProgress,
  })
  return {
    imported: result.imported,
    skipped: result.skipped + skipped,
    warnings: [...warnings, ...result.warnings],
  }
}
