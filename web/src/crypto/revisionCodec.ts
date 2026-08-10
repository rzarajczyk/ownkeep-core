import type { AttachmentKind, ChecklistItem, NoteType } from '../types'
import { base64ToBytes, bytesToBase64, decryptJson, encryptJson } from './aead'
import { aadRevision, aadRevisionLabel } from './keys'

export const REVISION_LABEL_MAX_LENGTH = 80

export interface RevisionAttachmentPayload {
  id: string
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
  sizeBytes: number
}

export interface RevisionPlainPayload {
  v: 1
  title: string
  contentRaw: string
  items: Array<{
    id: string
    text: string
    checked: boolean
    sortOrder: number
    indent: number
  }>
  type: NoteType
  backgroundColor: string
  archived: boolean
  pinned: boolean
  labelIds: string[]
  attachments: RevisionAttachmentPayload[]
}

export interface RevisionLabelPlainPayload {
  v: 1
  label: string
}

export function buildRevisionPayload(input: {
  title: string
  contentRaw: string
  items: ChecklistItem[]
  type: NoteType
  backgroundColor: string
  archived: boolean
  pinned: boolean
  labelIds: string[]
  attachments: RevisionAttachmentPayload[]
}): RevisionPlainPayload {
  return {
    v: 1,
    title: input.title,
    contentRaw: input.type === 'TEXT' ? input.contentRaw : '',
    items:
      input.type === 'LIST'
        ? input.items.map((item) => ({
            id: item.id,
            text: item.text,
            checked: item.checked,
            sortOrder: item.sortOrder,
            indent: item.indent,
          }))
        : [],
    type: input.type,
    backgroundColor: input.backgroundColor,
    archived: input.archived,
    pinned: input.pinned,
    labelIds: input.labelIds,
    attachments: input.attachments.map((attachment) => ({
      id: attachment.id,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      sizeBytes: attachment.sizeBytes,
    })),
  }
}

export async function encryptRevisionPayload(
  noteId: string,
  revisionId: string,
  noteKey: Uint8Array,
  payload: RevisionPlainPayload,
): Promise<string> {
  const blob = await encryptJson(noteKey, payload, aadRevision(noteId, revisionId))
  return bytesToBase64(blob)
}

export async function decryptRevisionPayload(
  noteId: string,
  revisionId: string,
  noteKey: Uint8Array,
  ciphertextB64: string,
): Promise<RevisionPlainPayload> {
  const payload = await decryptJson<RevisionPlainPayload>(
    noteKey,
    base64ToBytes(ciphertextB64),
    aadRevision(noteId, revisionId),
  )
  if (payload.v !== 1) throw new Error(`Unsupported revision payload version: ${payload.v}`)
  return payload
}

export async function encryptRevisionLabel(
  vaultKey: Uint8Array,
  noteId: string,
  revisionId: string,
  label: string,
): Promise<string> {
  const trimmed = label.trim()
  if (trimmed.length === 0) {
    throw new Error('Revision label must not be blank')
  }
  if (trimmed.length > REVISION_LABEL_MAX_LENGTH) {
    throw new Error(`Revision label must be at most ${REVISION_LABEL_MAX_LENGTH} characters`)
  }
  const blob = await encryptJson(
    vaultKey,
    { v: 1, label: trimmed } satisfies RevisionLabelPlainPayload,
    aadRevisionLabel(noteId, revisionId),
  )
  return bytesToBase64(blob)
}

export async function decryptRevisionLabel(
  vaultKey: Uint8Array,
  noteId: string,
  revisionId: string,
  ciphertextB64: string,
): Promise<string> {
  const payload = await decryptJson<RevisionLabelPlainPayload>(
    vaultKey,
    base64ToBytes(ciphertextB64),
    aadRevisionLabel(noteId, revisionId),
  )
  if (payload.v !== 1) throw new Error(`Unsupported revision label payload version: ${payload.v}`)
  return payload.label
}
