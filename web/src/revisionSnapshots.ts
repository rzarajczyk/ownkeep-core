import {
  buildRevisionPayload,
  decryptRevisionPayload,
  encryptRevisionPayload,
  type RevisionAttachmentPayload,
  type RevisionPlainPayload,
} from './crypto/revisionCodec'
import { wrapNoteKey, unwrapNoteKey } from './crypto/noteCodec'
import type { CreateNoteRevisionRequest, Note, NoteRevisionDetail } from './types'

export async function buildEncryptedRevision(
  note: Note,
  vaultKey: Uint8Array,
  noteKey: Uint8Array,
  options?: { revisionId?: string },
): Promise<CreateNoteRevisionRequest> {
  const revisionId = options?.revisionId ?? crypto.randomUUID()
  const attachments: RevisionAttachmentPayload[] = note.attachments.map((attachment) => ({
    id: attachment.id,
    originalFilename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    sizeBytes: attachment.sizeBytes,
  }))
  const payload = buildRevisionPayload({
    title: note.title,
    contentRaw: note.contentRaw,
    items: note.items,
    type: note.type,
    backgroundColor: note.backgroundColor,
    archived: note.archived,
    pinned: note.pinned,
    labelIds: note.labelIds,
    attachments,
  })
  return {
    id: revisionId,
    sourceVersion: note.version,
    wrappedNoteKey: await wrapNoteKey(vaultKey, note.id, noteKey),
    snapshotCiphertext: await encryptRevisionPayload(note.id, revisionId, noteKey, payload),
  }
}

export async function decryptRevisionDetail(
  noteId: string,
  detail: NoteRevisionDetail,
  vaultKey: Uint8Array,
): Promise<{ noteKey: Uint8Array; payload: RevisionPlainPayload }> {
  const noteKey = await unwrapNoteKey(vaultKey, noteId, detail.wrappedNoteKey)
  const payload = await decryptRevisionPayload(
    noteId,
    detail.id,
    noteKey,
    detail.snapshotCiphertext,
  )
  return { noteKey, payload }
}
