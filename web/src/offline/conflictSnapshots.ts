import { decryptAttachmentMeta, inferAttachmentKind } from '../crypto/attachmentCodec'
import { decryptNotePayload, unwrapNoteKey } from '../crypto/noteCodec'
import {
  buildRevisionPayload,
  encryptRevisionPayload,
} from '../crypto/revisionCodec'
import type { EncryptedNoteWire, EncryptedNoteWrite } from '../types'

/** Build revision-format snapshots (correct AAD) from encrypted note wires for conflict-resolve. */
export async function buildConflictRevisionSnapshots(
  noteId: string,
  vaultKey: Uint8Array,
  local: EncryptedNoteWrite,
  remote: EncryptedNoteWire,
  localRevisionId: string,
  remoteRevisionId: string,
): Promise<{ localSnapshotCiphertext: string; remoteSnapshotCiphertext: string }> {
  if (!local.wrappedNoteKey || !local.ciphertext) {
    throw new Error('Local conflict payload missing ciphertext')
  }
  const localKey = await unwrapNoteKey(vaultKey, noteId, local.wrappedNoteKey)
  const remoteKey = await unwrapNoteKey(vaultKey, noteId, remote.wrappedNoteKey)
  const localPlain = await decryptNotePayload(noteId, localKey, local.ciphertext)
  const remotePlain = await decryptNotePayload(noteId, remoteKey, remote.ciphertext)

  const remoteAttachments = []
  for (const att of remote.attachments) {
    try {
      const meta = await decryptAttachmentMeta(remoteKey, att.id, att.metaCiphertext)
      remoteAttachments.push({
        id: att.id,
        originalFilename: meta.originalFilename,
        mimeType: meta.mimeType,
        kind: meta.kind ?? inferAttachmentKind(meta.mimeType),
        sizeBytes: att.sizeBytes,
      })
    } catch {
      // Skip undecryptable attachment metadata in conflict snapshot.
    }
  }

  const withRendered = (
    items: Array<{ id: string; text: string; checked: boolean; sortOrder: number; indent: number }>,
  ) => items.map((item) => ({ ...item, textRendered: '' }))

  const localSnapshotCiphertext = await encryptRevisionPayload(
    noteId,
    localRevisionId,
    localKey,
    buildRevisionPayload({
      title: localPlain.title,
      contentRaw: localPlain.contentRaw,
      items: withRendered(localPlain.items),
      type: local.type,
      backgroundColor: local.backgroundColor ?? remote.backgroundColor,
      archived: local.archived ?? remote.archived,
      pinned: local.pinned ?? remote.pinned,
      labelIds: local.labelIds ?? localPlain.labelIds,
      attachments: remoteAttachments,
    }),
  )
  const remoteSnapshotCiphertext = await encryptRevisionPayload(
    noteId,
    remoteRevisionId,
    remoteKey,
    buildRevisionPayload({
      title: remotePlain.title,
      contentRaw: remotePlain.contentRaw,
      items: withRendered(remotePlain.items),
      type: remote.type,
      backgroundColor: remote.backgroundColor,
      archived: remote.archived,
      pinned: remote.pinned,
      labelIds: remote.labelIds,
      attachments: remoteAttachments,
    }),
  )

  return { localSnapshotCiphertext, remoteSnapshotCiphertext }
}
