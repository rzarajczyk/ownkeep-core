const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Returns nonce||ciphertext||tag as a single blob. */
export async function encryptAesGcm(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes)
  const nonce = randomBytes(12)
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(textEncoder.encode(aad)),
      },
      key,
      asBufferSource(plaintext),
    ),
  )
  const out = new Uint8Array(nonce.length + encrypted.length)
  out.set(nonce, 0)
  out.set(encrypted, nonce.length)
  return out
}

export async function decryptAesGcm(
  keyBytes: Uint8Array,
  blob: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  if (blob.length < 28) throw new Error('Ciphertext too short')
  const nonce = blob.slice(0, 12)
  const ciphertext = blob.slice(12)
  const key = await importAesKey(keyBytes)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asBufferSource(nonce),
      additionalData: asBufferSource(textEncoder.encode(aad)),
    },
    key,
    asBufferSource(ciphertext),
  )
  return new Uint8Array(plaintext)
}

export function bytesToBlob(bytes: Uint8Array, type = 'application/octet-stream'): Blob {
  return new Blob([asBufferSource(bytes)], { type })
}

export async function encryptJson<T>(
  keyBytes: Uint8Array,
  value: T,
  aad: string,
): Promise<Uint8Array> {
  return encryptAesGcm(keyBytes, textEncoder.encode(JSON.stringify(value)), aad)
}

export async function decryptJson<T>(
  keyBytes: Uint8Array,
  blob: Uint8Array,
  aad: string,
): Promise<T> {
  const plaintext = await decryptAesGcm(keyBytes, blob, aad)
  return JSON.parse(textDecoder.decode(plaintext)) as T
}
