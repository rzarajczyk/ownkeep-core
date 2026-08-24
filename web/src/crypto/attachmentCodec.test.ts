import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, encryptJson, randomBytes } from './aead'
import {
  ATTACHMENT_META_MAX_BYTES,
  decryptAttachmentBytes,
  decryptAttachmentMeta,
  decryptAttachmentThumbnail,
  encryptAttachmentBytes,
  encryptAttachmentMeta,
  encryptAttachmentThumbnail,
  inferAttachmentKind,
  resolveAttachmentThumbnail,
} from './attachmentCodec'
import { aadAttachmentMeta } from './keys'

describe('attachmentCodec', () => {
  it('round-trips attachment meta and bytes', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const meta = {
      originalFilename: 'photo.png',
      mimeType: 'image/png',
      kind: 'IMAGE' as const,
    }
    const metaCipher = await encryptAttachmentMeta(noteKey, attachmentId, meta)
    expect(base64ToBytes(metaCipher).length).toBeLessThanOrEqual(ATTACHMENT_META_MAX_BYTES)
    expect(await decryptAttachmentMeta(noteKey, attachmentId, metaCipher)).toEqual({
      v: 1,
      ...meta,
    })

    const plain = new TextEncoder().encode('attachment-bytes')
    const cipher = await encryptAttachmentBytes(noteKey, attachmentId, plain)
    const out = await decryptAttachmentBytes(noteKey, attachmentId, cipher)
    expect(new TextDecoder().decode(out)).toBe('attachment-bytes')
  })

  it('keeps filename/mime meta well under the size cap without embedding a thumbnail', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const metaCipher = await encryptAttachmentMeta(noteKey, attachmentId, {
      originalFilename: 'photo.png',
      mimeType: 'image/png',
      kind: 'IMAGE',
    })
    expect(base64ToBytes(metaCipher).length).toBeLessThan(1024)
    expect((await decryptAttachmentMeta(noteKey, attachmentId, metaCipher)).thumbnail).toBeUndefined()
  })

  it('round-trips a thumbnail as a separate encrypted blob', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    const cipher = await encryptAttachmentThumbnail(noteKey, attachmentId, jpeg)
    expect(cipher.length).toBeGreaterThanOrEqual(28)
    expect(cipher.length).toBeLessThanOrEqual(96_000)
    const out = await decryptAttachmentThumbnail(noteKey, attachmentId, cipher)
    expect([...out]).toEqual([...jpeg])

    const resolved = await resolveAttachmentThumbnail(
      noteKey,
      attachmentId,
      bytesToBase64(cipher),
    )
    expect(resolved?.mimeType).toBe('image/jpeg')
    expect(resolved && [...resolved.bytes]).toEqual([...jpeg])
  })

  it('decrypts a thumbnail embedded in legacy meta ciphertext', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    const blob = await encryptJson(
      noteKey,
      {
        v: 1,
        originalFilename: 'photo.heic',
        mimeType: 'image/jpeg',
        kind: 'IMAGE',
        thumbnail: { mimeType: 'image/jpeg', data: bytesToBase64(jpeg) },
      },
      aadAttachmentMeta(attachmentId),
    )
    const decrypted = await decryptAttachmentMeta(noteKey, attachmentId, bytesToBase64(blob))
    expect(decrypted.originalFilename).toBe('photo.heic')
    expect(decrypted.thumbnail?.mimeType).toBe('image/jpeg')
    expect(decrypted.thumbnail && [...decrypted.thumbnail.bytes]).toEqual([...jpeg])
  })

  it('falls back to a legacy meta thumbnail when the dedicated blob is missing', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const fallback = { mimeType: 'image/jpeg', bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) }
    const resolved = await resolveAttachmentThumbnail(noteKey, attachmentId, null, fallback)
    expect(resolved).toEqual(fallback)
  })

  it('rejects decrypt when attachmentId AAD does not match', async () => {
    const noteKey = randomBytes(32)
    const attachmentId = crypto.randomUUID()
    const metaCipher = await encryptAttachmentMeta(noteKey, attachmentId, {
      originalFilename: 'doc.pdf',
      mimeType: 'application/pdf',
      kind: 'FILE',
    })
    await expect(
      decryptAttachmentMeta(noteKey, crypto.randomUUID(), metaCipher),
    ).rejects.toThrow()

    const cipher = await encryptAttachmentBytes(
      noteKey,
      attachmentId,
      new TextEncoder().encode('secret'),
    )
    await expect(
      decryptAttachmentBytes(noteKey, crypto.randomUUID(), cipher),
    ).rejects.toThrow()

    const thumb = await encryptAttachmentThumbnail(noteKey, attachmentId, Uint8Array.of(1, 2, 3))
    await expect(
      decryptAttachmentThumbnail(noteKey, crypto.randomUUID(), thumb),
    ).rejects.toThrow()
  })

  it('infers IMAGE vs FILE from mime type', () => {
    expect(inferAttachmentKind('image/png')).toBe('IMAGE')
    expect(inferAttachmentKind('image/jpeg')).toBe('IMAGE')
    expect(inferAttachmentKind('image/jpg')).toBe('IMAGE')
    expect(inferAttachmentKind('image/heic')).toBe('IMAGE')
    expect(inferAttachmentKind('application/pdf')).toBe('FILE')
    expect(inferAttachmentKind('text/plain')).toBe('FILE')
  })
})
