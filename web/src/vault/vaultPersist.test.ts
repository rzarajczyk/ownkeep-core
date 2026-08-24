import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from '../crypto/aead'
import {
  VAULT_LOCK_PREF_KEY,
  VAULT_PERSIST_DB,
  VAULT_PERSIST_STORE,
  clearPersistedVaultKey,
  clearPersistedVaultKeysExcept,
  persistVaultKey,
  readLockBehavior,
  restoreVaultKey,
  writeLockBehavior,
} from './vaultPersist'

async function readWrap(userId: number) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(VAULT_PERSIST_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(VAULT_PERSIST_STORE)) {
        db.createObjectStore(VAULT_PERSIST_STORE, { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
  })
  const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const tx = db.transaction(VAULT_PERSIST_STORE, 'readonly')
    const request = tx.objectStore(VAULT_PERSIST_STORE).get(userId)
    request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined)
    request.onerror = () => reject(request.error ?? new Error('get failed'))
  })
  db.close()
  return record
}

async function putWrap(record: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(VAULT_PERSIST_DB, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_PERSIST_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('put failed'))
    tx.objectStore(VAULT_PERSIST_STORE).put(record)
  })
  db.close()
}

describe('vaultPersist', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory()
    localStorage.clear()
  })

  it('defaults to lock-on-reload and stores per-user preference', () => {
    expect(readLockBehavior(3)).toBe('lock-on-reload')
    writeLockBehavior(3, 'until-logout')
    writeLockBehavior(8, 'lock-on-reload')
    expect(readLockBehavior(3)).toBe('until-logout')
    expect(readLockBehavior(8)).toBe('lock-on-reload')
    expect(JSON.parse(localStorage.getItem(VAULT_LOCK_PREF_KEY) ?? '{}')).toEqual({
      '3': 'until-logout',
      '8': 'lock-on-reload',
    })
  })

  it('round-trips a vault key without storing extractable wrapping key bytes', async () => {
    const vaultKey = randomBytes(32)
    await persistVaultKey(4, vaultKey)

    const restored = await restoreVaultKey(4)
    expect(restored).toEqual(vaultKey)

    const record = await readWrap(4)
    expect(record?.userId).toBe(4)
    const wrappingKey = record?.wrappingKey as CryptoKey
    expect(wrappingKey).toBeInstanceOf(CryptoKey)
    expect(wrappingKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', wrappingKey)).rejects.toThrow()
  })

  it('does not restore another user id', async () => {
    const vaultKey = randomBytes(32)
    await persistVaultKey(1, vaultKey)
    expect(await restoreVaultKey(2)).toBeNull()
  })

  it('rejects a wrap copied onto a different user id', async () => {
    const vaultKey = randomBytes(32)
    await persistVaultKey(1, vaultKey)
    const record = await readWrap(1)
    expect(record).toBeTruthy()
    await putWrap({ ...record, userId: 2 })
    expect(await restoreVaultKey(2)).toBeNull()
  })

  it('clears the wrap for one user and leaves others', async () => {
    const first = randomBytes(32)
    const second = randomBytes(32)
    await persistVaultKey(1, first)
    await persistVaultKey(2, second)
    await clearPersistedVaultKey(1)
    expect(await restoreVaultKey(1)).toBeNull()
    expect(await restoreVaultKey(2)).toEqual(second)
  })

  it('clears every wrap except the active user', async () => {
    const keep = randomBytes(32)
    await persistVaultKey(1, randomBytes(32))
    await persistVaultKey(2, keep)
    await persistVaultKey(3, randomBytes(32))
    await clearPersistedVaultKeysExcept(2)
    expect(await restoreVaultKey(1)).toBeNull()
    expect(await restoreVaultKey(2)).toEqual(keep)
    expect(await restoreVaultKey(3)).toBeNull()
  })
})
