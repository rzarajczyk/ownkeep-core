import { unzipSync } from 'fflate'
import {
  encryptAttachmentBytes,
  encryptAttachmentMeta,
  encryptOptionalThumbnailPart,
} from '../crypto/attachmentCodec'
import { bytesToBlob } from '../crypto/aead'
import { prepareAttachmentPayload } from '../crypto/imageMime'
import { encryptLabelName } from '../crypto/labelCodec'
import { generateNoteKey } from '../crypto/keys'
import { buildNotePayload, encryptNotePayload, wrapNoteKey } from '../crypto/noteCodec'
import { api } from '../api'
import { i18n } from '../i18n'
import { setCachedNoteKey } from '../notesCipher'
import { newMutationId, nowIso } from '../offline/lww'
import type { LocalRepository } from '../offline/repository'
import type { ChecklistItem, EncryptedNoteWire, NoteType } from '../types'
import { MAX_ITEM_INDENT } from '../utils'
import { mapKeepColor } from './keepColors'
import { MAX_UNCOMPRESSED_BYTES, MAX_UNCOMPRESSED_MIB, MAX_ZIP_BYTES, MAX_ZIP_MIB } from './limits'

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

export interface KeepImportResult {
  imported: number
  skipped: number
  warnings: string[]
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

function unzipKeepArchive(zipBytes: Uint8Array): Record<string, Uint8Array> {
  let uncompressed = 0
  return unzipSync(zipBytes, {
    filter(entry) {
      uncompressed += entry.originalSize
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error(i18n.t('import.errors.unzipTooLarge', { max: MAX_UNCOMPRESSED_MIB }))
      }
      return !entry.name.includes('__MACOSX')
    },
  })
}

export async function importKeepZip(options: {
  file: File
  vaultKey: Uint8Array
  repo: LocalRepository
  existingLabels: Map<string, string>
  extraLabelNames?: string[]
  onProgress: (percent: number) => void
}): Promise<KeepImportResult> {
  const { file, vaultKey, repo, extraLabelNames = [], onProgress } = options
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(i18n.t('import.errors.zipTooLarge', { max: MAX_ZIP_MIB }))
  }
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = unzipKeepArchive(zipBytes)
  const warnings: string[] = []
  const noteFiles = Object.keys(entries).filter((name) => name.toLowerCase().endsWith('.json'))
  const labelNameToId = new Map(options.existingLabels)
  let imported = 0
  let skipped = 0
  let processed = 0

  async function ensureLabel(name: string): Promise<string> {
    const key = name.toLowerCase()
    const existing = labelNameToId.get(key)
    if (existing) return existing
    const ciphertext = await encryptLabelName(vaultKey, name)
    const created = await api.createLabel(ciphertext)
    labelNameToId.set(key, created.id)
    return created.id
  }

  const extraLabelIds: string[] = []
  for (const name of extraLabelNames) {
    extraLabelIds.push(await ensureLabel(name))
  }

  for (const path of noteFiles) {
    processed += 1
    onProgress(Math.round((processed / Math.max(noteFiles.length, 1)) * 100))
    try {
      const raw = decodeText(entries[path]!)
      const json: unknown = JSON.parse(raw)
      if (!isKeepNote(json)) continue
      if (json.isTrashed) {
        skipped += 1
        continue
      }
      const attachments = json.attachments ?? []
      const listItems = Array.isArray(json.listContent) ? flattenListItems(json.listContent) : []
      const hasText = Boolean(json.title?.trim() || json.textContent?.trim() || listItems.length)
      if (!hasText && attachments.length === 0) {
        skipped += 1
        continue
      }
      const isList = listItems.length > 0
      const type: NoteType = isList ? 'LIST' : 'TEXT'
      const labelNames = [...(json.labels ?? []), ...(json.labelIds ?? [])]
        .map((item) => item.name?.trim())
        .filter((name): name is string => Boolean(name))
      const labelIds: string[] = [...extraLabelIds]
      for (const name of labelNames) {
        const id = await ensureLabel(name)
        if (!labelIds.includes(id)) labelIds.push(id)
      }
      const noteId = crypto.randomUUID()
      const noteKey = generateNoteKey()
      setCachedNoteKey(noteId, noteKey)
      const mappedColor = mapKeepColor(json.color)
      if (mappedColor.unknown) {
        warnings.push(i18n.t('import.warnings.unknownColor', { color: json.color ?? '', path }))
      }
      const payload = buildNotePayload({
        title: json.title ?? '',
        contentRaw: type === 'TEXT' ? (json.textContent ?? '') : '',
        items: listItems,
        labelIds,
        type,
      })
      const clientUpdatedAt =
        usecToIso(json.userEditedTimestampUsec) ?? usecToIso(json.createdTimestampUsec) ?? nowIso()
      let wire: EncryptedNoteWire = await api.createNote({
        id: noteId,
        type,
        backgroundColor: mappedColor.color,
        archived: Boolean(json.isArchived),
        pinned: Boolean(json.isPinned),
        wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
        ciphertext: await encryptNotePayload(noteId, noteKey, payload),
        labelIds,
        clientUpdatedAt,
        clientMutationId: newMutationId(),
      })

      let uploadedAttachment = false
      for (const attachment of attachments) {
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
        const fileBytes = entries[candidate]!
        const attachmentId = crypto.randomUUID()
        const prepared = await prepareAttachmentPayload(
          basename(relative),
          attachment.mimetype ?? 'application/octet-stream',
          fileBytes,
        )
        const metaCiphertext = await encryptAttachmentMeta(noteKey, attachmentId, {
          originalFilename: prepared.originalFilename,
          mimeType: prepared.mimeType,
          kind: prepared.kind,
        })
        const cipherBytes = await encryptAttachmentBytes(noteKey, attachmentId, prepared.bytes)
        await api.uploadAttachment(
          noteId,
          bytesToBlob(cipherBytes),
          metaCiphertext,
          attachmentId,
          () => undefined,
          await encryptOptionalThumbnailPart(noteKey, attachmentId, prepared.thumbnail),
        )
        uploadedAttachment = true
      }
      if (uploadedAttachment) {
        wire = await api.note(noteId)
      }
      await repo.putSyncedNotes([wire], [])
      imported += 1
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

  return { imported, skipped, warnings }
}
