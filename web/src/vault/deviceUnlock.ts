import { randomBytes } from '../crypto/aead'
import './webauthnTypes'

export type DeviceUnlockAvailability =
  | 'checking'
  | 'available'
  | 'unsupported'
  | 'insecure-context'

export type DeviceUnlockErrorCode =
  | 'cancelled'
  | 'failed'
  | 'not-enrolled'
  | 'unsupported'

export class DeviceUnlockError extends Error {
  readonly code: DeviceUnlockErrorCode

  constructor(code: DeviceUnlockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeviceUnlockError'
    this.code = code
  }
}

export const DEVICE_UNLOCK_DB = 'ownkeep-vault-device-v1'
export const DEVICE_UNLOCK_STORE = 'wraps'

const DEVICE_UNLOCK_VERSION = 1
const VAULT_KEY_LENGTH = 32
const AAD_PREFIX = 'ok.vault.device.v1:'
const HKDF_INFO = new TextEncoder().encode('OwnKeep WebAuthn PRF vault wrap v1')

interface DeviceVaultWrap {
  userId: number
  version: 1
  credentialId: string
  prfInput: ArrayBuffer
  hkdfSalt: ArrayBuffer
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

function asArrayBuffer(value: BufferSource): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0)
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function isPublicKeyCredential(value: Credential | null): value is PublicKeyCredential {
  return value?.type === 'public-key' && 'rawId' in value && 'getClientExtensionResults' in value
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_UNLOCK_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DEVICE_UNLOCK_STORE)) {
        db.createObjectStore(DEVICE_UNLOCK_STORE, { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open device unlock DB'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb()
  try {
    return await fn(db)
  } finally {
    db.close()
  }
}

async function readEnrollment(userId: number): Promise<DeviceVaultWrap | null> {
  try {
    const record = await withDb(async (db) => {
      const tx = db.transaction(DEVICE_UNLOCK_STORE, 'readonly')
      return requestResult(
        tx.objectStore(DEVICE_UNLOCK_STORE).get(userId) as IDBRequest<DeviceVaultWrap | undefined>,
      )
    })
    if (record?.version !== DEVICE_UNLOCK_VERSION || record.userId !== userId) return null
    return record
  } catch {
    return null
  }
}

async function writeEnrollment(record: DeviceVaultWrap): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(DEVICE_UNLOCK_STORE, 'readwrite')
    tx.objectStore(DEVICE_UNLOCK_STORE).put(record)
    await transactionDone(tx)
  })
}

async function deriveWrappingKey(
  prfOutput: BufferSource,
  hkdfSalt: BufferSource,
): Promise<CryptoKey> {
  const rawOutput = asArrayBuffer(prfOutput)
  const material = await crypto.subtle.importKey('raw', rawOutput, 'HKDF', false, ['deriveKey'])
  try {
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: hkdfSalt,
        info: asBufferSource(HKDF_INFO),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    new Uint8Array(rawOutput).fill(0)
  }
}

function wrapAad(userId: number, credentialId: string): Uint8Array {
  return new TextEncoder().encode(`${AAD_PREFIX}${userId}:${credentialId}`)
}

function normalizeError(reason: unknown): DeviceUnlockError {
  if (reason instanceof DeviceUnlockError) return reason
  if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
    return new DeviceUnlockError('cancelled', 'Device verification was canceled', { cause: reason })
  }
  const detail = reason instanceof Error ? `: ${reason.message}` : ''
  return new DeviceUnlockError('failed', `Device verification failed${detail}`, {
    cause: reason instanceof Error ? reason : undefined,
  })
}

async function evaluatePrf(credentialId: string, prfInput: BufferSource): Promise<ArrayBuffer> {
  const credentialBytes = base64UrlToBytes(credentialId)
  const challenge = randomBytes(32)
  let result: Credential | null
  try {
    result = await navigator.credentials.get({
      publicKey: {
        challenge: asBufferSource(challenge),
        hints: ['client-device'],
        allowCredentials: [
          {
            type: 'public-key',
            id: asBufferSource(credentialBytes),
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfInput } } },
      },
    })
  } catch (reason) {
    throw normalizeError(reason)
  } finally {
    challenge.fill(0)
  }
  if (!isPublicKeyCredential(result)) {
    throw new DeviceUnlockError('failed', 'Device returned an invalid credential')
  }
  if (!bytesEqual(new Uint8Array(result.rawId), credentialBytes)) {
    throw new DeviceUnlockError('failed', 'Device returned a different credential')
  }
  const output = result.getClientExtensionResults().prf?.results?.first
  if (!output) {
    throw new DeviceUnlockError('unsupported', 'This credential does not support device unlock')
  }
  return asArrayBuffer(output)
}

export async function checkDeviceUnlockAvailability(): Promise<DeviceUnlockAvailability> {
  if (!globalThis.isSecureContext) return 'insecure-context'
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return 'unsupported'
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    if (!available) return 'unsupported'
    const getCapabilities = PublicKeyCredential.getClientCapabilities
    if (typeof getCapabilities === 'function') {
      const capabilities = await getCapabilities.call(PublicKeyCredential)
      if (capabilities['extension:prf'] === false) return 'unsupported'
    }
    return 'available'
  } catch {
    return 'unsupported'
  }
}

export async function hasDeviceUnlockEnrollment(userId: number): Promise<boolean> {
  return (await readEnrollment(userId)) !== null
}

export async function enrollDeviceUnlock(
  user: { id: number; email: string },
  vaultKey: Uint8Array,
): Promise<void> {
  if (vaultKey.length !== VAULT_KEY_LENGTH) {
    throw new DeviceUnlockError('failed', 'Vault key has an unexpected length')
  }
  const availability = await checkDeviceUnlockAvailability()
  if (availability !== 'available') {
    throw new DeviceUnlockError('unsupported', 'Device verification is unavailable')
  }

  const challenge = randomBytes(32)
  const userHandle = randomBytes(32)
  const prfInput = randomBytes(32)
  const hkdfSalt = randomBytes(32)
  let result: Credential | null
  try {
    result = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'OwnKeep' },
        hints: ['client-device'],
        user: {
          id: asBufferSource(userHandle),
          name: 'ownkeep-vault',
          displayName: 'OwnKeep vault',
        },
        challenge: asBufferSource(challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: 60_000,
        extensions: { prf: { eval: { first: asBufferSource(prfInput) } } },
      },
    })
  } catch (reason) {
    throw normalizeError(reason)
  } finally {
    challenge.fill(0)
    userHandle.fill(0)
  }
  if (!isPublicKeyCredential(result)) {
    throw new DeviceUnlockError('failed', 'Device returned an invalid credential')
  }
  const extension = result.getClientExtensionResults().prf
  if (extension?.enabled !== true) {
    throw new DeviceUnlockError('unsupported', 'This device does not support WebAuthn PRF')
  }
  const credentialId = result.id
  let prfOutput = extension.results?.first
  if (!prfOutput) {
    prfOutput = await evaluatePrf(credentialId, asBufferSource(prfInput))
  }

  const wrappingKey = await deriveWrappingKey(prfOutput, asBufferSource(hkdfSalt))
  const iv = randomBytes(12)
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(iv),
        additionalData: asBufferSource(wrapAad(user.id, credentialId)),
      },
      wrappingKey,
      asBufferSource(vaultKey),
    )
    await writeEnrollment({
      userId: user.id,
      version: DEVICE_UNLOCK_VERSION,
      credentialId,
      prfInput: asBufferSource(prfInput),
      hkdfSalt: asBufferSource(hkdfSalt),
      iv: asBufferSource(iv),
      ciphertext,
    })
  } finally {
    new Uint8Array(asArrayBuffer(prfOutput)).fill(0)
    prfInput.fill(0)
    hkdfSalt.fill(0)
    iv.fill(0)
  }
}

export async function unlockVaultWithDevice(userId: number): Promise<Uint8Array> {
  const record = await readEnrollment(userId)
  if (!record) {
    throw new DeviceUnlockError('not-enrolled', 'Device unlock is not enrolled')
  }
  const prfOutput = await evaluatePrf(record.credentialId, record.prfInput)
  try {
    const wrappingKey = await deriveWrappingKey(prfOutput, record.hkdfSalt)
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: record.iv,
        additionalData: asBufferSource(wrapAad(userId, record.credentialId)),
      },
      wrappingKey,
      record.ciphertext,
    )
    const vaultKey = new Uint8Array(plaintext)
    if (vaultKey.length !== VAULT_KEY_LENGTH) {
      vaultKey.fill(0)
      throw new DeviceUnlockError('failed', 'Vault key has an unexpected length')
    }
    return vaultKey
  } catch (reason) {
    throw normalizeError(reason)
  } finally {
    new Uint8Array(prfOutput).fill(0)
  }
}

export async function clearDeviceUnlockEnrollment(userId: number): Promise<void> {
  const record = await readEnrollment(userId)
  await withDb(async (db) => {
    const tx = db.transaction(DEVICE_UNLOCK_STORE, 'readwrite')
    tx.objectStore(DEVICE_UNLOCK_STORE).delete(userId)
    await transactionDone(tx)
  })

  if (!record || typeof PublicKeyCredential === 'undefined') return
  try {
    await PublicKeyCredential.signalUnknownCredential({
      rpId: window.location.hostname,
      credentialId: record.credentialId,
    })
  } catch {
    // The encrypted wrap is already gone; authenticator cleanup is best-effort.
  }
}
