export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || !height) return null
  return { width, height }
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]!
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
      if (!width || !height) return null
      return { width, height }
    }
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2
      continue
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (length < 2) break
    i += 2 + length
  }
  return null
}

export function imageDisplaySize(
  mimeType: string,
  bytes: Uint8Array,
): { widthIn: number; heightIn: number } {
  const size =
    mimeType === 'image/png'
      ? pngSize(bytes)
      : mimeType === 'image/jpeg' || mimeType === 'image/jpg'
        ? jpegSize(bytes)
        : null
  const width = size?.width ?? 800
  const height = size?.height ?? 600
  const maxIn = 6
  const widthIn = Math.min(maxIn, Math.max(1, width / 96))
  return { widthIn, heightIn: widthIn * (height / width) }
}

function rasterizeToPng(bytes: Uint8Array, mimeType: string): Promise<{ mimeType: 'image/png'; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      reject(new Error('Canvas is not available'))
      return
    }
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
      type: mimeType,
    })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, image.naturalWidth)
        canvas.height = Math.max(1, image.naturalHeight)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas is not available')
        ctx.drawImage(image, 0, 0)
        canvas.toBlob((out) => {
          URL.revokeObjectURL(url)
          if (!out) {
            reject(new Error('Could not convert image'))
            return
          }
          void out.arrayBuffer().then((buffer) => {
            resolve({ mimeType: 'image/png', bytes: new Uint8Array(buffer) })
          }, reject)
        }, 'image/png')
      } catch (reason) {
        URL.revokeObjectURL(url)
        reject(reason)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not decode image'))
    }
    image.src = url
  })
}

export async function ensurePngOrJpeg(
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ mimeType: 'image/png' | 'image/jpeg'; bytes: Uint8Array } | null> {
  const lower = mimeType.toLowerCase()
  if (lower === 'image/png') return { mimeType: 'image/png', bytes }
  if (lower === 'image/jpeg' || lower === 'image/jpg') return { mimeType: 'image/jpeg', bytes }
  try {
    return await rasterizeToPng(bytes, mimeType)
  } catch {
    return null
  }
}
