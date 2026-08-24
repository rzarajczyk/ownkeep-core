import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachmentPreviewBlob,
  imageBlobForDisplay,
  normalizeMimeType,
  prepareAttachmentPayload,
  sniffImageMime,
} from './imageMime'

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const GIF = new TextEncoder().encode('GIF89a')
const WEBP = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
)
const BMP = Uint8Array.of(0x42, 0x4d, 0x00, 0x00)

function ftyp(major: string, compat: string[] = []): Uint8Array {
  const size = 16 + compat.length * 4
  const bytes = new Uint8Array(size)
  new DataView(bytes.buffer).setUint32(0, size)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  bytes.set(new TextEncoder().encode(major), 8)
  let offset = 16
  for (const brand of compat) {
    bytes.set(new TextEncoder().encode(brand), offset)
    offset += 4
  }
  return bytes
}

describe('imageMime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sniffs common image formats from magic bytes', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(BMP)).toBe('image/bmp')
    expect(sniffImageMime(ftyp('heic', ['mif1']))).toBe('image/heic')
    expect(sniffImageMime(ftyp('mif1', ['heic']))).toBe('image/heic')
    expect(sniffImageMime(ftyp('avif', ['mif1']))).toBe('image/avif')
    expect(sniffImageMime(new Uint8Array([0, 1, 2, 3]))).toBeNull()
  })

  it('normalizes aliases and infers mime from filename', () => {
    expect(normalizeMimeType('image/jpg')).toBe('image/jpeg')
    expect(normalizeMimeType('image/pjpeg')).toBe('image/jpeg')
    expect(normalizeMimeType('image/x-png')).toBe('image/png')
    expect(normalizeMimeType('', 'photo.HEIC')).toBe('image/heic')
    expect(normalizeMimeType('application/octet-stream', 'shot.webp')).toBe('image/webp')
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf')
  })

  it('prefers sniffed mime when creating a display blob', () => {
    const jpegAsPng = imageBlobForDisplay(JPEG, 'image/png')
    expect(jpegAsPng.type).toBe('image/jpeg')
    const heic = imageBlobForDisplay(ftyp('heic'), 'image/jpg')
    expect(heic.type).toBe('image/heic')
    const labelled = imageBlobForDisplay(new Uint8Array([1, 2, 3]), 'image/jpg')
    expect(labelled.type).toBe('image/jpeg')
    const preview = attachmentPreviewBlob({
      id: 'att',
      kind: 'IMAGE',
      originalFilename: 'photo.jpg',
      mimeType: 'image/png',
      sizeBytes: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      url: '/attachments/att',
      thumbnail: { mimeType: 'image/jpeg', bytes: JPEG },
    })
    expect(preview?.type).toBe('image/jpeg')
  })

  it('keeps jpeg/png bytes on upload and rewrites android-style mime aliases', async () => {
    const prepared = await prepareAttachmentPayload('IMG_0001.JPG', 'image/jpg', JPEG)
    expect(prepared).toEqual({
      originalFilename: 'IMG_0001.JPG',
      mimeType: 'image/jpeg',
      kind: 'IMAGE',
      bytes: JPEG,
    })
  })

  it('keeps heic when the browser cannot decode it', async () => {
    const heic = ftyp('heic', ['mif1'])
    const prepared = await prepareAttachmentPayload('IMG_1234.HEIC', '', heic)
    expect(prepared.kind).toBe('IMAGE')
    expect(prepared.mimeType).toBe('image/heic')
    expect(prepared.bytes).toBe(heic)
  })

  it('transcodes heic to jpeg when createImageBitmap succeeds', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close })),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([jpeg], { type: 'image/jpeg' }))
    })

    const prepared = await prepareAttachmentPayload('IMG_1234.HEIC', '', ftyp('heic', ['mif1']))
    expect(prepared.mimeType).toBe('image/jpeg')
    expect(prepared.originalFilename).toBe('IMG_1234.jpg')
    expect(prepared.kind).toBe('IMAGE')
    expect([...prepared.bytes]).toEqual([...jpeg])
    expect(prepared.thumbnail?.mimeType).toBe('image/jpeg')
    expect(prepared.thumbnail && [...prepared.thumbnail.bytes]).toEqual([...jpeg])
    expect(close).toHaveBeenCalledTimes(2)
  })
})
