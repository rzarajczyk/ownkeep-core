import { randomBytes } from '../crypto/aead'

export type VaultLockBehavior = 'lock-on-reload' | 'until-logout'

export const VAULT_LOCK_PREF_KEY = 'ownkeep.vaultLockBehavior'
export const VAULT_PERSIST_DB = 'ownkeep-vault-session-v1'
export const VAULT_PERSIST_STORE = 'wraps'
export const VAULT_LOCK_CHANNEL = 'ownkeep.vault.lock'
export const VAULT_LOCK_STORAGE_KEY = 'ownkeep.vaultLockEvent'

const AAD_PREFIX = 'ok.vault.persist.v1:'
const VAULT_KEY_LENGTH = 32

interface PersistedVaultWrap {
  userId: number
  wrappingKey: CryptoKey
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

type LockMessage = { type: 'lock'; userId: number }

const textEncoder = new TextEncoder()

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function persistAad(userId: number) {
  return textEncoder.encode(`${AAD_PREFIX}${userId}`)
}

function isLockBehavior(value: unknown): value is VaultLockBehavior {
  return value === 'lock-on-reload' || value === 'until-logout'
}

function readPreferenceMap(): Record<string, VaultLockBehavior> {
  try {
    const raw = localStorage.getItem(VAULT_LOCK_PREF_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const map: Record<string, VaultLockBehavior> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isLockBehavior(value)) map[key] = value
    }
    return map
  } catch {
    return {}
  }
}

export function readLockBehavior(userId: number): VaultLockBehavior {
  return readPreferenceMap()[String(userId)] ?? 'lock-on-reload'
}

export function writeLockBehavior(userId: number, behavior: VaultLockBehavior) {
  try {
    const map = readPreferenceMap()
    map[String(userId)] = behavior
    localStorage.setItem(VAULT_LOCK_PREF_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private-mode failures; caller treats persist separately
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_PERSIST_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(VAULT_PERSIST_STORE)) {
        db.createObjectStore(VAULT_PERSIST_STORE, { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open vault persist DB'))
  })
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
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

async function generateWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function persistVaultKey(userId: number, vaultKey: Uint8Array): Promise<void> {
  if (vaultKey.length !== VAULT_KEY_LENGTH) throw new Error('Vault key has unexpected length')
  const wrappingKey = await generateWrappingKey()
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(iv), additionalData: persistAad(userId) },
    wrappingKey,
    asBufferSource(vaultKey),
  )
  const record: PersistedVaultWrap = {
    userId,
    wrappingKey,
    iv: asBufferSource(iv),
    ciphertext,
  }
  await withDb(async (db) => {
    const tx = db.transaction(VAULT_PERSIST_STORE, 'readwrite')
    tx.objectStore(VAULT_PERSIST_STORE).put(record)
    await txDone(tx)
  })
}

export async function restoreVaultKey(userId: number): Promise<Uint8Array | null> {
  try {
    const record = await withDb(async (db) => {
      const tx = db.transaction(VAULT_PERSIST_STORE, 'readonly')
      return req(tx.objectStore(VAULT_PERSIST_STORE).get(userId) as IDBRequest<PersistedVaultWrap | undefined>)
    })
    if (!record?.wrappingKey || record.userId !== userId) return null
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: persistAad(userId) },
      record.wrappingKey,
      record.ciphertext,
    )
    const key = new Uint8Array(plaintext)
    if (key.length !== VAULT_KEY_LENGTH) return null
    return key
  } catch {
    return null
  }
}

export async function clearPersistedVaultKey(userId: number): Promise<void> {
  try {
    await withDb(async (db) => {
      const tx = db.transaction(VAULT_PERSIST_STORE, 'readwrite')
      tx.objectStore(VAULT_PERSIST_STORE).delete(userId)
      await txDone(tx)
    })
  } catch {
    // best-effort wipe
  }
}

export async function clearPersistedVaultKeysExcept(userId: number): Promise<void> {
  try {
    await withDb(async (db) => {
      const tx = db.transaction(VAULT_PERSIST_STORE, 'readwrite')
      const store = tx.objectStore(VAULT_PERSIST_STORE)
      const keys = await req(store.getAllKeys())
      for (const key of keys) {
        if (key !== userId) store.delete(key)
      }
      await txDone(tx)
    })
  } catch {
    // best-effort wipe
  }
}

export function publishVaultLocked(userId: number) {
  const message: LockMessage = { type: 'lock', userId }
  try {
    const channel = new BroadcastChannel(VAULT_LOCK_CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch {
    // BroadcastChannel may be missing in some test environments
  }
  try {
    localStorage.setItem(VAULT_LOCK_STORAGE_KEY, JSON.stringify({ userId, at: Date.now() }))
  } catch {
    // ignore
  }
}

export function subscribeVaultLocked(userId: number, onLock: () => void): () => void {
  let channel: BroadcastChannel | null = null
  const onMessage = (event: MessageEvent<LockMessage>) => {
    if (event.data?.type === 'lock' && event.data.userId === userId) onLock()
  }
  try {
    channel = new BroadcastChannel(VAULT_LOCK_CHANNEL)
    channel.addEventListener('message', onMessage)
  } catch {
    channel = null
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== VAULT_LOCK_STORAGE_KEY || !event.newValue) return
    try {
      const payload = JSON.parse(event.newValue) as { userId?: number }
      if (payload.userId === userId) onLock()
    } catch {
      // ignore malformed lock events
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.removeEventListener('message', onMessage)
    channel?.close()
    window.removeEventListener('storage', onStorage)
  }
}
