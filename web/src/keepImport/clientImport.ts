import { unzipSync } from 'fflate'
import {
  encryptAttachmentBytes,
  encryptAttachmentMeta,
  inferAttachmentKind,
} from '../crypto/attachmentCodec'
import { encryptLabelName } from '../crypto/labelCodec'
import { generateNoteKey } from '../crypto/keys'
import { buildNotePayload, encryptNotePayload, wrapNoteKey } from '../crypto/noteCodec'
import { api } from '../api'
import { i18n } from '../i18n'
import { setCachedNoteKey } from '../notesCipher'
import type { NoteType } from '../types'

interface KeepListItem {
  text?: string
  isChecked?: boolean
}

interface KeepNoteJson {
  title?: string
  textContent?: string
  listContent?: KeepListItem[]
  isArchived?: boolean
  isPinned?: boolean
  labelIds?: Array<{ name?: string }>
  labels?: Array<{ name?: string }>
  attachments?: Array<{ filePath?: string }>
  color?: string
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

export async function importKeepZip(
  file: File,
  vaultKey: Uint8Array,
  onProgress: (percent: number) => void,
): Promise<{ imported: number; skipped: number; warnings: string[] }> {
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = unzipSync(zipBytes)
  const warnings: string[] = []
  const noteFiles = Object.keys(entries).filter(
    (name) => name.toLowerCase().endsWith('.json') && !name.includes('__MACOSX'),
  )
  const labelNameToId = new Map<string, string>()
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

  for (const path of noteFiles) {
    processed += 1
    onProgress(Math.round((processed / Math.max(noteFiles.length, 1)) * 100))
    try {
      const raw = decodeText(entries[path]!)
      const json = JSON.parse(raw) as KeepNoteJson
      if (!json.title && !json.textContent && !json.listContent?.length) {
        skipped += 1
        continue
      }
      const isList = Array.isArray(json.listContent) && json.listContent.length > 0
      const type: NoteType = isList ? 'LIST' : 'TEXT'
      const labelNames = [
        ...(json.labels ?? []),
        ...(json.labelIds ?? []),
      ]
        .map((item) => item.name?.trim())
        .filter((name): name is string => Boolean(name))
      const labelIds: string[] = []
      for (const name of labelNames) {
        labelIds.push(await ensureLabel(name))
      }
      const noteId = crypto.randomUUID()
      const noteKey = generateNoteKey()
      setCachedNoteKey(noteId, noteKey)
      const items =
        type === 'LIST'
          ? (json.listContent ?? []).map((item, index) => ({
              id: crypto.randomUUID(),
              text: item.text ?? '',
              checked: Boolean(item.isChecked),
              sortOrder: index,
              indent: 0,
              textRendered: '',
            }))
          : []
      const payload = buildNotePayload({
        title: json.title ?? '',
        contentRaw: type === 'TEXT' ? (json.textContent ?? '') : '',
        items,
        labelIds,
        type,
      })
      await api.createNote({
        id: noteId,
        type,
        backgroundColor: json.color && /^[#a-zA-Z0-9_-]{1,32}$/.test(json.color) ? json.color : 'default',
        archived: Boolean(json.isArchived),
        pinned: Boolean(json.isPinned),
        wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
        ciphertext: await encryptNotePayload(noteId, noteKey, payload),
        labelIds,
      })

      for (const attachment of json.attachments ?? []) {
        const relative = attachment.filePath
        if (!relative) continue
        const candidate =
          Object.keys(entries).find((name) => name.endsWith(relative) || basename(name) === basename(relative)) ??
          null
        if (!candidate) {
          warnings.push(i18n.t('import.warnings.missingAttachment', { relative, path }))
          continue
        }
        const fileBytes = entries[candidate]!
        const attachmentId = crypto.randomUUID()
        const filename = basename(relative)
        const mimeType = filename.match(/\.(png|jpe?g|gif|webp|avif|bmp)$/i)
          ? `image/${filename.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')}`
          : 'application/octet-stream'
        const metaCiphertext = await encryptAttachmentMeta(noteKey, attachmentId, {
          originalFilename: filename,
          mimeType,
          kind: inferAttachmentKind(mimeType),
        })
        const cipherBytes = await encryptAttachmentBytes(noteKey, attachmentId, fileBytes)
        await api.uploadAttachment(
          noteId,
          new Blob([
            cipherBytes.buffer.slice(
              cipherBytes.byteOffset,
              cipherBytes.byteOffset + cipherBytes.byteLength,
            ) as ArrayBuffer,
          ]),
          metaCiphertext,
          attachmentId,
          () => undefined,
        )
      }
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
