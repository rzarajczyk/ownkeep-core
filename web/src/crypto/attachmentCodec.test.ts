import { describe, expect, it } from 'vitest'
import { randomBytes } from './aead'
import {
  decryptAttachmentBytes,
  decryptAttachmentMeta,
  encryptAttachmentBytes,
  encryptAttachmentMeta,
  inferAttachmentKind,
} from './attachmentCodec'

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
    expect(await decryptAttachmentMeta(noteKey, attachmentId, metaCipher)).toEqual({
      v: 1,
      ...meta,
    })

    const plain = new TextEncoder().encode('attachment-bytes')
    const cipher = await encryptAttachmentBytes(noteKey, attachmentId, plain)
    const out = await decryptAttachmentBytes(noteKey, attachmentId, cipher)
    expect(new TextDecoder().decode(out)).toBe('attachment-bytes')
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
  })

  it('infers IMAGE vs FILE from mime type', () => {
    expect(inferAttachmentKind('image/png')).toBe('IMAGE')
    expect(inferAttachmentKind('image/jpeg')).toBe('IMAGE')
    expect(inferAttachmentKind('application/pdf')).toBe('FILE')
    expect(inferAttachmentKind('text/plain')).toBe('FILE')
  })
})
