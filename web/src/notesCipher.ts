import {
  decryptAttachmentMeta,
  fieldsFromAttachmentMeta,
  resolveAttachmentThumbnail,
} from './crypto/attachmentCodec'
import { decryptLabelName } from './crypto/labelCodec'
import { generateNoteKey } from './crypto/keys'
import {
  buildNotePayload,
  decryptNotePayload,
  encryptNotePayload,
  unwrapNoteKey,
  wrapNoteKey,
} from './crypto/noteCodec'
import { renderMarkdown, renderMarkdownInline } from './markdown/renderMarkdown'
import type {
  Attachment,
  EncryptedLabelWire,
  EncryptedNoteWire,
  EncryptedNoteWrite,
  Note,
  NoteWrite,
} from './types'

const noteKeyCache = new Map<string, Uint8Array>()

export function clearNoteKeyCache() {
  noteKeyCache.clear()
}

export function getCachedNoteKey(noteId: string): Uint8Array | undefined {
  return noteKeyCache.get(noteId)
}

export function setCachedNoteKey(noteId: string, noteKey: Uint8Array) {
  noteKeyCache.set(noteId, noteKey)
}

export async function decryptLabels(
  vaultKey: Uint8Array,
  wires: EncryptedLabelWire[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const wire of wires) {
    map.set(wire.id, await decryptLabelName(vaultKey, wire.ciphertext))
  }
  return map
}

export async function fromWire(
  wire: EncryptedNoteWire,
  vaultKey: Uint8Array,
  labelNames: Map<string, string>,
): Promise<Note> {
  const noteKey =
    noteKeyCache.get(wire.id) ??
    (await unwrapNoteKey(vaultKey, wire.id, wire.wrappedNoteKey))
  noteKeyCache.set(wire.id, noteKey)
  const payload = await decryptNotePayload(wire.id, noteKey, wire.ciphertext)
  const attachments: Attachment[] = []
  for (const att of wire.attachments) {
    const meta = await decryptAttachmentMeta(noteKey, att.id, att.metaCiphertext)
    const fields = fieldsFromAttachmentMeta(meta)
    const thumbnail = await resolveAttachmentThumbnail(
      noteKey,
      att.id,
      att.thumbnailCiphertext,
      fields.thumbnail,
    )
    attachments.push({
      id: att.id,
      ...fields,
      ...(thumbnail ? { thumbnail } : {}),
      sizeBytes: att.sizeBytes,
      createdAt: att.createdAt,
      url: att.url,
      metaCiphertext: att.metaCiphertext,
    })
  }
  const items = payload.items.map((item) => ({
    ...item,
    textRendered: renderMarkdownInline(item.text),
  }))
  const labels = payload.labelIds
    .map((id) => labelNames.get(id))
    .filter((name): name is string => Boolean(name))
  return {
    id: wire.id,
    type: wire.type,
    title: payload.title,
    contentRaw: payload.contentRaw,
    contentRendered:
      wire.type === 'TEXT' ? renderMarkdown(payload.contentRaw, attachments) : '',
    backgroundColor: wire.backgroundColor,
    archived: wire.archived,
    pinned: wire.pinned,
    labels,
    labelIds: payload.labelIds,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    clientUpdatedAt: wire.clientUpdatedAt ?? wire.updatedAt,
    clientMutationId: wire.clientMutationId ?? null,
    version: wire.version,
    items,
    attachments,
    wrappedNoteKey: wire.wrappedNoteKey,
    ciphertext: wire.ciphertext,
  }
}

export async function toWire(
  noteId: string,
  draft: NoteWrite & {
    type: Note['type']
    title: string
    contentRaw: string
    items: Note['items']
    labelIds: string[]
    backgroundColor: string
    archived: boolean
    pinned: boolean
  },
  vaultKey: Uint8Array,
  options?: {
    existingNoteKey?: Uint8Array
    clientUpdatedAt?: string
    clientMutationId?: string
  },
): Promise<EncryptedNoteWrite> {
  if (draft.metadataOnly) {
    return {
      type: draft.type,
      backgroundColor: draft.backgroundColor,
      archived: draft.archived,
      pinned: draft.pinned,
      version: draft.version,
      labelIds: draft.labelIds,
      clientUpdatedAt: options?.clientUpdatedAt,
      clientMutationId: options?.clientMutationId,
    }
  }
  const noteKey = options?.existingNoteKey ?? noteKeyCache.get(noteId) ?? generateNoteKey()
  noteKeyCache.set(noteId, noteKey)
  const payload = buildNotePayload({
    title: draft.title,
    contentRaw: draft.contentRaw,
    items: draft.items,
    labelIds: draft.labelIds,
    type: draft.type,
  })
  return {
    id: noteId,
    type: draft.type,
    backgroundColor: draft.backgroundColor,
    archived: draft.archived,
    pinned: draft.pinned,
    version: draft.version,
    wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
    ciphertext: await encryptNotePayload(noteId, noteKey, payload),
    labelIds: draft.labelIds,
    clientUpdatedAt: options?.clientUpdatedAt,
    clientMutationId: options?.clientMutationId,
  }
}
