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
import { newMutationId } from '../offline/lww'
import type { LocalRepository } from '../offline/repository'
import type { ChecklistItem, EncryptedNoteWire, NoteType } from '../types'
import { NOTE_COLORS } from '../utils'

export interface ImportResult {
  imported: number
  skipped: number
  warnings: string[]
}

export interface PlainImportAttachment {
  filename: string
  mimeType: string
  bytes: Uint8Array
}

export interface PlainImportNote {
  sourcePath: string
  type: NoteType
  title: string
  contentRaw: string
  items: ChecklistItem[]
  labelNames: string[]
  backgroundColor: string
  archived: boolean
  pinned: boolean
  clientUpdatedAt: string
  attachments: PlainImportAttachment[]
}

const NOTE_COLOR_VALUES = new Set<string>(NOTE_COLORS.map((color) => color.value))

export async function ingestPlainNotes(options: {
  notes: PlainImportNote[]
  vaultKey: Uint8Array
  repo: LocalRepository
  existingLabels: Map<string, string>
  extraLabelNames?: string[]
  ensureLabelNames?: string[]
  onProgress: (percent: number) => void
}): Promise<ImportResult> {
  const {
    notes,
    vaultKey,
    repo,
    extraLabelNames = [],
    ensureLabelNames = [],
    onProgress,
  } = options
  const labelNameToId = new Map(options.existingLabels)
  const warnings: string[] = []
  let imported = 0
  let skipped = 0

  async function ensureLabel(name: string): Promise<string> {
    const key = name.toLowerCase()
    const existing = labelNameToId.get(key)
    if (existing) return existing
    const ciphertext = await encryptLabelName(vaultKey, name)
    const created = await api.createLabel(ciphertext)
    labelNameToId.set(key, created.id)
    return created.id
  }

  for (const name of [...ensureLabelNames, ...extraLabelNames]) {
    const trimmed = name.trim()
    if (trimmed) await ensureLabel(trimmed)
  }

  const extraLabelIds: string[] = []
  for (const name of extraLabelNames) {
    const trimmed = name.trim()
    if (!trimmed) continue
    extraLabelIds.push(await ensureLabel(trimmed))
  }

  const total = Math.max(notes.length, 1)
  if (notes.length === 0) onProgress(100)

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index]!
    onProgress(Math.round(((index + 1) / total) * 100))
    try {
      const hasText = Boolean(note.title.trim() || note.contentRaw.trim() || note.items.length)
      if (!hasText && note.attachments.length === 0) {
        skipped += 1
        continue
      }
      const labelIds: string[] = [...extraLabelIds]
      for (const name of note.labelNames) {
        const trimmed = name.trim()
        if (!trimmed) continue
        const id = await ensureLabel(trimmed)
        if (!labelIds.includes(id)) labelIds.push(id)
      }
      const noteId = crypto.randomUUID()
      const noteKey = generateNoteKey()
      setCachedNoteKey(noteId, noteKey)
      const backgroundColor = NOTE_COLOR_VALUES.has(note.backgroundColor)
        ? note.backgroundColor
        : '#ffffff'
      if (backgroundColor !== note.backgroundColor) {
        warnings.push(
          i18n.t('import.warnings.unknownColor', {
            color: note.backgroundColor,
            path: note.sourcePath,
          }),
        )
      }
      const items = note.items.map((item, itemIndex) => ({
        ...item,
        id: crypto.randomUUID(),
        sortOrder: itemIndex,
        textRendered: '',
      }))
      const payload = buildNotePayload({
        title: note.title,
        contentRaw: note.type === 'TEXT' ? note.contentRaw : '',
        items,
        labelIds,
        type: note.type,
      })
      let wire: EncryptedNoteWire = await api.createNote({
        id: noteId,
        type: note.type,
        backgroundColor,
        archived: note.archived,
        pinned: note.pinned,
        wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
        ciphertext: await encryptNotePayload(noteId, noteKey, payload),
        labelIds,
        clientUpdatedAt: note.clientUpdatedAt,
        clientMutationId: newMutationId(),
      })
      let uploadedAttachment = false
      for (const attachment of note.attachments) {
        const attachmentId = crypto.randomUUID()
        const prepared = await prepareAttachmentPayload(
          attachment.filename,
          attachment.mimeType,
          attachment.bytes,
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
          path: note.sourcePath,
          error: error instanceof Error ? error.message : i18n.t('import.warnings.unknownError'),
        }),
      )
    }
  }

  return { imported, skipped, warnings }
}
