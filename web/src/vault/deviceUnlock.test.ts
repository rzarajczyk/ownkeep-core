import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_UNLOCK_DB,
  DEVICE_UNLOCK_STORE,
  DeviceUnlockError,
  checkDeviceUnlockAvailability,
  clearDeviceUnlockEnrollment,
  enrollDeviceUnlock,
  hasDeviceUnlockEnrollment,
  unlockVaultWithDevice,
} from './deviceUnlock'

const credentialBytes = new Uint8Array([1, 2, 3, 4])
const credentialId = 'AQIDBA'
const prfOutput = new Uint8Array(32).fill(41)

const credentials = {
  create: vi.fn(),
  get: vi.fn(),
}

const publicKeyCredential = {
  getClientCapabilities: vi.fn(),
  isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(),
  signalUnknownCredential: vi.fn(),
}

function credential(options?: {
  id?: string
  rawId?: Uint8Array
  enabled?: boolean
  output?: Uint8Array | null
}): PublicKeyCredential {
  const output = options?.output === undefined ? prfOutput : options.output
  return {
    type: 'public-key',
    id: options?.id ?? credentialId,
    rawId: (options?.rawId ?? credentialBytes).buffer,
    getClientExtensionResults: () => ({
      prf: {
        enabled: options?.enabled ?? true,
        results: output ? { first: output.buffer } : undefined,
      },
    }),
  } as PublicKeyCredential
}

async function readRecord(userId: number): Promise<Record<string, unknown> | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_UNLOCK_DB, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const tx = db.transaction(DEVICE_UNLOCK_STORE, 'readonly')
    const request = tx.objectStore(DEVICE_UNLOCK_STORE).get(userId)
    request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return record
}

async function putRecord(record: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_UNLOCK_DB, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DEVICE_UNLOCK_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(DEVICE_UNLOCK_STORE).put(record)
  })
  db.close()
}

describe('deviceUnlock', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory()
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: credentials,
    })
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      configurable: true,
      value: publicKeyCredential,
    })
    credentials.create.mockReset()
    credentials.get.mockReset()
    publicKeyCredential.getClientCapabilities.mockReset()
    publicKeyCredential.getClientCapabilities.mockResolvedValue({ 'extension:prf': true })
    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockReset()
    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockResolvedValue(true)
    publicKeyCredential.signalUnknownCredential.mockReset()
    publicKeyCredential.signalUnknownCredential.mockResolvedValue(undefined)
    credentials.create.mockResolvedValue(credential())
    credentials.get.mockResolvedValue(credential())
  })

  it('requires a secure context, a platform authenticator, and PRF support', async () => {
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false })
    expect(await checkDeviceUnlockAvailability()).toBe('insecure-context')

    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockResolvedValue(false)
    expect(await checkDeviceUnlockAvailability()).toBe('unsupported')

    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockResolvedValue(true)
    publicKeyCredential.getClientCapabilities.mockResolvedValue({ 'extension:prf': false })
    expect(await checkDeviceUnlockAvailability()).toBe('unsupported')
  })

  it('enrolls and unlocks without persisting plaintext key material', async () => {
    const vaultKey = new Uint8Array(32).map((_, index) => index)
    await enrollDeviceUnlock({ id: 7, email: 'owner@example.com' }, vaultKey)

    expect(await hasDeviceUnlockEnrollment(7)).toBe(true)
    expect(credentials.create).toHaveBeenCalledOnce()
    const creation = credentials.create.mock.calls[0]![0] as CredentialCreationOptions
    expect(creation.publicKey?.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'platform',
      userVerification: 'required',
    })
    expect(creation.publicKey?.attestation).toBe('none')
    expect(creation.publicKey?.hints).toEqual(['client-device'])
    expect(creation.publicKey?.extensions?.prf).toBeTruthy()
    expect(creation.publicKey?.user.name).not.toContain('owner@example.com')

    const record = await readRecord(7)
    expect(record).toMatchObject({ userId: 7, version: 1, credentialId })
    expect(record).not.toHaveProperty('vaultKey')
    expect(record).not.toHaveProperty('prfOutput')
    expect(record).not.toHaveProperty('wrappingKey')
    expect(new Uint8Array(record?.ciphertext as ArrayBuffer)).not.toEqual(vaultKey)

    expect(await unlockVaultWithDevice(7)).toEqual(vaultKey)
    const request = credentials.get.mock.calls[0]![0] as CredentialRequestOptions
    expect(request.publicKey?.userVerification).toBe('required')
    expect(request.publicKey?.hints).toEqual(['client-device'])
    expect(request.publicKey?.allowCredentials?.[0]?.transports).toEqual(['internal'])
  })

  it('uses a follow-up assertion when registration does not return a PRF value', async () => {
    credentials.create.mockResolvedValue(credential({ output: null }))
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )

    expect(credentials.get).toHaveBeenCalledOnce()
    expect(await hasDeviceUnlockEnrollment(7)).toBe(true)
  })

  it('rejects registration when the authenticator ignores PRF', async () => {
    credentials.create.mockResolvedValue(credential({ enabled: false, output: null }))
    await expect(
      enrollDeviceUnlock(
        { id: 7, email: 'owner@example.com' },
        new Uint8Array(32).fill(7),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(await hasDeviceUnlockEnrollment(7)).toBe(false)
  })

  it('rejects enrollment outside a secure context', async () => {
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false })

    await expect(
      enrollDeviceUnlock(
        { id: 7, email: 'owner@example.com' },
        new Uint8Array(32).fill(7),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(credentials.create).not.toHaveBeenCalled()
  })

  it('rejects a different credential and a wrap copied to another user', async () => {
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )
    credentials.get.mockResolvedValue(credential({ rawId: new Uint8Array([9, 9, 9]) }))
    await expect(unlockVaultWithDevice(7)).rejects.toMatchObject({ code: 'failed' })

    credentials.get.mockResolvedValue(credential())
    const record = await readRecord(7)
    expect(record).toBeTruthy()
    await putRecord({ ...record, userId: 8 })
    await expect(unlockVaultWithDevice(8)).rejects.toBeInstanceOf(DeviceUnlockError)
  })

  it('treats a canceled system prompt as a recoverable error', async () => {
    credentials.create.mockRejectedValue(new DOMException('Canceled', 'NotAllowedError'))
    await expect(
      enrollDeviceUnlock(
        { id: 7, email: 'owner@example.com' },
        new Uint8Array(32).fill(7),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('treats a canceled unlock assertion as a recoverable error', async () => {
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )
    credentials.get.mockRejectedValue(new DOMException('Canceled', 'NotAllowedError'))

    await expect(unlockVaultWithDevice(7)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('fails closed when an assertion omits the PRF output', async () => {
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )
    credentials.get.mockResolvedValue(credential({ output: null }))

    await expect(unlockVaultWithDevice(7)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('fails closed when the encrypted record is tampered with', async () => {
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )
    const record = await readRecord(7)
    expect(record).toBeTruthy()
    const ciphertext = new Uint8Array(record?.ciphertext as ArrayBuffer)
    ciphertext[0] = ciphertext[0]! ^ 0xff
    await putRecord({ ...record, ciphertext: ciphertext.buffer })

    await expect(unlockVaultWithDevice(7)).rejects.toMatchObject({ code: 'failed' })
  })

  it('removes the encrypted wrap and best-effort signals the credential provider', async () => {
    await enrollDeviceUnlock(
      { id: 7, email: 'owner@example.com' },
      new Uint8Array(32).fill(7),
    )
    await clearDeviceUnlockEnrollment(7)

    expect(await hasDeviceUnlockEnrollment(7)).toBe(false)
    expect(publicKeyCredential.signalUnknownCredential).toHaveBeenCalledWith({
      rpId: window.location.hostname,
      credentialId,
    })
  })
})
