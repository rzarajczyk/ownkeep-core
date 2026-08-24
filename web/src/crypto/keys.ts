import { decryptAesGcm, encryptAesGcm, randomBytes } from './aead'

export function generateVaultKey(): Uint8Array {
  return randomBytes(32)
}

export function generateNoteKey(): Uint8Array {
  return randomBytes(32)
}

export function generateRecoveryKey(): Uint8Array {
  return randomBytes(32)
}

export async function wrapKey(
  wrappingKey: Uint8Array,
  keyToWrap: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  return encryptAesGcm(wrappingKey, keyToWrap, aad)
}

export async function unwrapKey(
  wrappingKey: Uint8Array,
  wrapped: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await decryptAesGcm(wrappingKey, wrapped, aad)
  if (key.length !== 32) throw new Error('Unwrapped key has unexpected length')
  return key
}

export const AAD_VAULT = 'ok.vault.v1'
export const AAD_RECOVERY = 'ok.vault.recovery.v1'
export function aadNote(noteId: string) {
  return `ok.note.v1:${noteId}`
}
export function aadNoteKey(noteId: string) {
  return `ok.notekey.v1:${noteId}`
}
export function aadAttachment(attachmentId: string) {
  return `ok.att.v1:${attachmentId}`
}
export function aadAttachmentMeta(attachmentId: string) {
  return `ok.attmeta.v1:${attachmentId}`
}
export function aadAttachmentThumb(attachmentId: string) {
  return `ok.attthumb.v1:${attachmentId}`
}
export const AAD_LABEL = 'ok.label.v1'
export function aadRevision(noteId: string, revisionId: string) {
  return `ok.revision.v1:${noteId}:${revisionId}`
}
export function aadRevisionLabel(noteId: string, revisionId: string) {
  return `ok.revlabel.v1:${noteId}:${revisionId}`
}
