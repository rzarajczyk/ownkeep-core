import type { Attachment, AttachmentKind, AttachmentThumbnail } from '../types'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBlob,
  decryptAesGcm,
  decryptJson,
  encryptAesGcm,
  encryptJson,
} from './aead'
import { aadAttachment, aadAttachmentMeta, aadAttachmentThumb } from './keys'

/** Filename/mime/kind only — thumbnails are a separate encrypted blob. */
export const ATTACHMENT_META_MAX_BYTES = 16_384

export interface AttachmentMetaInput {
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
}

interface AttachmentMetaWire {
  v: 1
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
  thumbnail?: { mimeType: string; data: string }
}

export interface AttachmentMetaPayload {
  v: 1
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
  thumbnail?: AttachmentThumbnail
}

function parseThumbnail(
  raw: AttachmentMetaWire['thumbnail'],
): AttachmentThumbnail | undefined {
  if (!raw?.data || !raw.mimeType) return undefined
  try {
    const bytes = base64ToBytes(raw.data)
    if (bytes.length === 0) return undefined
    return { mimeType: raw.mimeType, bytes }
  } catch {
    return undefined
  }
}

export async function encryptAttachmentMeta(
  noteKey: Uint8Array,
  attachmentId: string,
  meta: AttachmentMetaInput,
): Promise<string> {
  const wire: AttachmentMetaWire = {
    v: 1,
    originalFilename: meta.originalFilename,
    mimeType: meta.mimeType,
    kind: meta.kind,
  }
  const blob = await encryptJson(noteKey, wire, aadAttachmentMeta(attachmentId))
  if (blob.length > ATTACHMENT_META_MAX_BYTES) {
    throw new Error('Attachment metadata is too large')
  }
  return bytesToBase64(blob)
}

export async function decryptAttachmentMeta(
  noteKey: Uint8Array,
  attachmentId: string,
  metaCiphertextB64: string,
): Promise<AttachmentMetaPayload> {
  const payload = await decryptJson<AttachmentMetaWire>(
    noteKey,
    base64ToBytes(metaCiphertextB64),
    aadAttachmentMeta(attachmentId),
  )
  if (payload.v !== 1) throw new Error(`Unsupported attachment meta version: ${payload.v}`)
  const thumbnail = parseThumbnail(payload.thumbnail)
  return {
    v: 1,
    originalFilename: payload.originalFilename,
    mimeType: payload.mimeType,
    kind: payload.kind,
    ...(thumbnail ? { thumbnail } : {}),
  }
}

export function fieldsFromAttachmentMeta(
  meta: AttachmentMetaPayload,
): Pick<Attachment, 'kind' | 'originalFilename' | 'mimeType' | 'thumbnail'> {
  const thumbnail = meta.thumbnail
  return {
    kind: meta.kind ?? inferAttachmentKind(meta.mimeType),
    originalFilename: meta.originalFilename,
    mimeType: meta.mimeType,
    ...(thumbnail ? { thumbnail } : {}),
  }
}

export async function encryptAttachmentBytes(
  noteKey: Uint8Array,
  attachmentId: string,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return encryptAesGcm(noteKey, bytes, aadAttachment(attachmentId))
}

export async function decryptAttachmentBytes(
  noteKey: Uint8Array,
  attachmentId: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptAesGcm(noteKey, ciphertext, aadAttachment(attachmentId))
}

export async function encryptAttachmentThumbnail(
  noteKey: Uint8Array,
  attachmentId: string,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return encryptAesGcm(noteKey, bytes, aadAttachmentThumb(attachmentId))
}

export async function encryptOptionalThumbnailPart(
  noteKey: Uint8Array,
  attachmentId: string,
  thumbnail: AttachmentThumbnail | undefined,
): Promise<Blob | undefined> {
  if (!thumbnail?.bytes.length) return undefined
  return bytesToBlob(await encryptAttachmentThumbnail(noteKey, attachmentId, thumbnail.bytes))
}

export async function decryptAttachmentThumbnail(
  noteKey: Uint8Array,
  attachmentId: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptAesGcm(noteKey, ciphertext, aadAttachmentThumb(attachmentId))
}

export async function resolveAttachmentThumbnail(
  noteKey: Uint8Array,
  attachmentId: string,
  thumbnailCiphertextB64: string | null | undefined,
  fallback?: AttachmentThumbnail,
): Promise<AttachmentThumbnail | undefined> {
  if (thumbnailCiphertextB64) {
    try {
      const bytes = await decryptAttachmentThumbnail(
        noteKey,
        attachmentId,
        base64ToBytes(thumbnailCiphertextB64),
      )
      if (bytes.length > 0) return { mimeType: 'image/jpeg', bytes }
    } catch {
      // Fall back to a thumbnail embedded in legacy meta ciphertext.
    }
  }
  return fallback
}

export function inferAttachmentKind(mimeType: string): AttachmentKind {
  const normalized = mimeType.trim().toLowerCase()
  return normalized.startsWith('image/') ? 'IMAGE' : 'FILE'
}
