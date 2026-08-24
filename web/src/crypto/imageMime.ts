import type { Attachment, AttachmentKind, AttachmentThumbnail } from '../types'
import { bytesToBlob } from './aead'
import { inferAttachmentKind } from './attachmentCodec'

const JPEG_QUALITY = 0.92
/** Long-edge preview size; 2× a typical card/editor width. */
export const THUMBNAIL_MAX_EDGE = 720
export const THUMBNAIL_MAX_BYTES = 48 * 1024
const THUMBNAIL_FALLBACK_MAX_BYTES = 64 * 1024

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-jpeg': 'image/jpeg',
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  heics: 'image/heic-sequence',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

/** Formats every current Safari/Chrome (desktop + Android) build can paint in <img>. */
const UNIVERSAL_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/svg+xml',
])

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function ftypBrands(bytes: Uint8Array): string[] | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  const end = boxSize >= 16 && boxSize <= bytes.length ? boxSize : Math.min(bytes.length, 64)
  const brands = [ascii(bytes, 8, 4)]
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(ascii(bytes, offset, 4))
  }
  return brands
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 6) {
    const header = ascii(bytes, 0, 6)
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  const brands = ftypBrands(bytes)
  if (brands) {
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'image/avif'
    if (
      brands.some((brand) =>
        /^(heic|heix|heim|heis|hevc|hevx|heif|mif1|msf1)$/.test(brand),
      )
    ) {
      return 'image/heic'
    }
  }
  return null
}

function mimeFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_MIME[filename.slice(dot + 1).toLowerCase()] ?? null
}

export function normalizeMimeType(mimeType: string, filename?: string): string {
  const raw = mimeType.trim().toLowerCase()
  if (raw && raw !== 'application/octet-stream') return MIME_ALIASES[raw] ?? raw
  return mimeFromFilename(filename ?? '') ?? (raw || 'application/octet-stream')
}

export function imageBlobForDisplay(bytes: Uint8Array, declaredMime = ''): Blob {
  const type = sniffImageMime(bytes) ?? normalizeMimeType(declaredMime)
  return bytesToBlob(bytes, type)
}

export function attachmentPreviewBlob(attachment: Attachment): Blob | null {
  const thumbnail = attachment.thumbnail
  if (attachment.kind !== 'IMAGE' || !thumbnail?.bytes.length) return null
  return imageBlobForDisplay(thumbnail.bytes, thumbnail.mimeType)
}

function withJpegExtension(filename: string): string {
  const replaced = filename.replace(/\.[a-z0-9]+$/i, '.jpg')
  return replaced === filename ? `${filename}.jpg` : replaced
}

async function rasterizeToJpeg(bytes: Uint8Array, sourceMime: string): Promise<Uint8Array> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('Image conversion is not available')
  }
  const bitmap = await createImageBitmap(bytesToBlob(bytes, sourceMime))
  try {
    return await encodeJpegFromBitmap(bitmap, Math.max(bitmap.width, bitmap.height), JPEG_QUALITY)
  } finally {
    bitmap.close()
  }
}

async function encodeJpegFromBitmap(
  bitmap: ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<Uint8Array> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  return canvasEncodeJpeg(width, height, (ctx) => {
    ctx.drawImage(bitmap, 0, 0, width, height)
  }, quality)
}

export async function generateImageThumbnail(
  bytes: Uint8Array,
  sourceMime: string,
): Promise<AttachmentThumbnail | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(bytesToBlob(bytes, sourceMime))
  } catch {
    return null
  }
  try {
    const attempts = [
      { edge: THUMBNAIL_MAX_EDGE, quality: 0.82 },
      { edge: THUMBNAIL_MAX_EDGE, quality: 0.72 },
      { edge: 640, quality: 0.7 },
      { edge: 480, quality: 0.65 },
    ]
    let best: Uint8Array | null = null
    for (const attempt of attempts) {
      const encoded = await encodeJpegFromBitmap(bitmap, attempt.edge, attempt.quality)
      if (sniffImageMime(encoded) !== 'image/jpeg') continue
      best = encoded
      if (encoded.length <= THUMBNAIL_MAX_BYTES) {
        return { mimeType: 'image/jpeg', bytes: encoded }
      }
    }
    if (best && best.length <= THUMBNAIL_FALLBACK_MAX_BYTES) {
      return { mimeType: 'image/jpeg', bytes: best }
    }
    return null
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

async function canvasEncodeJpeg(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  quality = JPEG_QUALITY,
): Promise<Uint8Array> {
  if (typeof document === 'undefined') throw new Error('Canvas is not available')
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  draw(ctx)
  const out = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode JPEG'))),
      'image/jpeg',
      quality,
    )
  })
  return new Uint8Array(await out.arrayBuffer())
}

export async function prepareAttachmentPayload(
  filename: string,
  declaredMime: string,
  bytes: Uint8Array,
): Promise<{
  originalFilename: string
  mimeType: string
  kind: AttachmentKind
  bytes: Uint8Array
  thumbnail?: AttachmentThumbnail
}> {
  const sniffed = sniffImageMime(bytes)
  const mimeType = sniffed ?? normalizeMimeType(declaredMime, filename)
  const kind = inferAttachmentKind(mimeType)
  let originalFilename = filename
  let outMime = mimeType
  let outKind = kind
  let outBytes = bytes
  if (kind === 'IMAGE' && !UNIVERSAL_IMAGE_MIMES.has(mimeType)) {
    try {
      outBytes = await rasterizeToJpeg(bytes, mimeType)
      originalFilename = withJpegExtension(filename)
      outMime = 'image/jpeg'
      outKind = 'IMAGE'
    } catch {
      // Keep the original bytes when this browser cannot transcode.
    }
  }
  const thumbnail =
    outKind === 'IMAGE'
      ? ((await generateImageThumbnail(outBytes, outMime)) ?? undefined)
      : undefined
  return {
    originalFilename,
    mimeType: outMime,
    kind: outKind,
    bytes: outBytes,
    ...(thumbnail ? { thumbnail } : {}),
  }
}
