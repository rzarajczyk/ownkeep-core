import type {
  CreateNoteRevisionRequest,
  EncryptedLabelWire,
  EncryptedNoteWire,
  EncryptedNoteWrite,
  VaultInfo,
} from '../types'
import type {
  OutboxOp,
  OutboxUpsertOp,
  StoredLabelCache,
  StoredNoteRecord,
  StoredVaultCache,
  SyncCursor,
} from './types'

const DB_PREFIX = 'ownkeep-offline-v1'

function dbName(userId: number) {
  return `${DB_PREFIX}-${userId}`
}

function openDb(userId: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(userId), 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault')
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('labels')) db.createObjectStore('labels')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
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

export class LocalRepository {
  private readonly userId: number

  constructor(userId: number) {
    this.userId = userId
  }

  private open() {
    return openDb(this.userId)
  }

  async cacheVault(vault: VaultInfo): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('vault', 'readwrite')
    const record: StoredVaultCache = {
      userId: this.userId,
      vault,
      updatedAt: new Date().toISOString(),
    }
    tx.objectStore('vault').put(record, 'current')
    await txDone(tx)
    db.close()
  }

  async getCachedVault(): Promise<VaultInfo | null> {
    const db = await this.open()
    const tx = db.transaction('vault', 'readonly')
    const record = await req<StoredVaultCache | undefined>(tx.objectStore('vault').get('current'))
    db.close()
    return record?.vault ?? null
  }

  async cacheLabels(wires: EncryptedLabelWire[]): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('labels', 'readwrite')
    const record: StoredLabelCache = { wires, updatedAt: new Date().toISOString() }
    tx.objectStore('labels').put(record, 'current')
    await txDone(tx)
    db.close()
  }

  async getCachedLabels(): Promise<EncryptedLabelWire[]> {
    const db = await this.open()
    const tx = db.transaction('labels', 'readonly')
    const record = await req<StoredLabelCache | undefined>(tx.objectStore('labels').get('current'))
    db.close()
    return record?.wires ?? []
  }

  async getCursor(): Promise<SyncCursor> {
    const db = await this.open()
    const tx = db.transaction('meta', 'readonly')
    const cursor = await req<SyncCursor | undefined>(tx.objectStore('meta').get('cursor'))
    db.close()
    return cursor ?? {}
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put(cursor, 'cursor')
    await txDone(tx)
    db.close()
  }

  async listNotes(): Promise<StoredNoteRecord[]> {
    const db = await this.open()
    const tx = db.transaction('notes', 'readonly')
    const notes = await req<StoredNoteRecord[]>(tx.objectStore('notes').getAll())
    db.close()
    return notes
  }

  async listPendingNotes(): Promise<EncryptedNoteWire[]> {
    const db = await this.open()
    try {
      // Read payloads and their pending status together, before sync can acknowledge them.
      const tx = db.transaction(['notes', 'outbox'], 'readonly')
      const [ops, records] = await Promise.all([
        req<OutboxOp[]>(tx.objectStore('outbox').getAll()),
        req<StoredNoteRecord[]>(tx.objectStore('notes').getAll()),
      ])
      const ids = new Set(ops.map((op) => op.noteId))
      return records.filter((record) => ids.has(record.id)).map((record) => record.wire)
    } finally {
      db.close()
    }
  }

  async getNote(id: string): Promise<StoredNoteRecord | undefined> {
    const db = await this.open()
    const tx = db.transaction('notes', 'readonly')
    const note = await req<StoredNoteRecord | undefined>(tx.objectStore('notes').get(id))
    db.close()
    return note
  }

  async putSyncedNotes(wires: EncryptedNoteWire[], deletedIds: string[]): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox'], 'readwrite')
    const notes = tx.objectStore('notes')
    const outbox = tx.objectStore('outbox')
    const pending = await req<OutboxOp[]>(outbox.getAll())
    const pendingByNote = new Set(
      pending.filter((op): op is OutboxUpsertOp => op.type === 'upsertNote').map((op) => op.noteId),
    )
    for (const id of deletedIds) {
      if (!pendingByNote.has(id)) notes.delete(id)
    }
    for (const wire of wires) {
      if (pendingByNote.has(wire.id)) continue
      notes.put({ id: wire.id, wire, neverSynced: false } satisfies StoredNoteRecord)
    }
    await txDone(tx)
    db.close()
  }

  /**
   * Atomically write note ciphertext + coalesce outbox upsert for the note.
   */
  async upsertLocalNote(
    wire: EncryptedNoteWire,
    write: EncryptedNoteWrite,
    options?: {
      neverSynced?: boolean
      baselineRevision?: CreateNoteRevisionRequest | null
    },
  ): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox'], 'readwrite')
    const notes = tx.objectStore('notes')
    const outbox = tx.objectStore('outbox')
    const existing = await req<StoredNoteRecord | undefined>(notes.get(wire.id))
    const neverSynced = options?.neverSynced ?? existing?.neverSynced ?? false
    notes.put({ id: wire.id, wire, neverSynced } satisfies StoredNoteRecord)

    const ops = await req<OutboxOp[]>(outbox.getAll())
    const existingOp = ops.find(
      (op): op is OutboxUpsertOp => op.type === 'upsertNote' && op.noteId === wire.id,
    )
    const now = new Date().toISOString()
    if (existingOp) {
      outbox.put({
        ...existingOp,
        payload: { ...existingOp.payload, ...write, id: wire.id },
        generation: (existingOp.generation ?? 1) + 1,
        baselineRevision: existingOp.baselineRevision ?? options?.baselineRevision ?? undefined,
        updatedAt: now,
      } satisfies OutboxUpsertOp)
    } else {
      outbox.put({
        id: crypto.randomUUID(),
        type: 'upsertNote',
        noteId: wire.id,
        payload: { ...write, id: wire.id },
        generation: 1,
        baselineRevision: options?.baselineRevision ?? undefined,
        createdAt: now,
        updatedAt: now,
      } satisfies OutboxUpsertOp)
    }
    await txDone(tx)
    db.close()
  }

  /**
   * Persist a repaired payload only while it is still the current generation.
   * This prevents recovery work from overwriting a newer coalesced edit.
   */
  async replaceOutboxPayloadIfCurrent(op: OutboxUpsertOp): Promise<boolean> {
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox'], 'readwrite')
    const notes = tx.objectStore('notes')
    const outbox = tx.objectStore('outbox')
    const current = await req<OutboxUpsertOp | undefined>(outbox.get(op.id))
    if (!current || current.generation !== op.generation) {
      await txDone(tx)
      db.close()
      return false
    }

    outbox.put({ ...current, payload: op.payload } satisfies OutboxUpsertOp)
    const stored = await req<StoredNoteRecord | undefined>(notes.get(op.noteId))
    if (stored) {
      notes.put({
        ...stored,
        wire: {
          ...stored.wire,
          wrappedNoteKey: op.payload.wrappedNoteKey ?? stored.wire.wrappedNoteKey,
          ciphertext: op.payload.ciphertext ?? stored.wire.ciphertext,
          labelIds: op.payload.labelIds ?? stored.wire.labelIds,
          clientUpdatedAt: op.payload.clientUpdatedAt ?? stored.wire.clientUpdatedAt,
          clientMutationId: op.payload.clientMutationId ?? stored.wire.clientMutationId,
        },
      } satisfies StoredNoteRecord)
    }
    await txDone(tx)
    db.close()
    return true
  }

  /**
   * Acknowledge a specific outbox op after a successful push.
   * Does not discard a newer pending mutation for the same note.
   *
   * When rebaseNewerMutation is false (remote-winning conflict), leave any newer
   * coalesced op and local wire untouched so the next push re-conflicts under LWW.
   */
  async acknowledgeOutboxOp(
    op: OutboxUpsertOp,
    wire: EncryptedNoteWire,
    options?: { rebaseNewerMutation?: boolean },
  ): Promise<void> {
    const rebaseNewerMutation = options?.rebaseNewerMutation !== false
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox'], 'readwrite')
    const notes = tx.objectStore('notes')
    const outbox = tx.objectStore('outbox')
    const current = await req<OutboxUpsertOp | undefined>(outbox.get(op.id))
    const acknowledgedGeneration = op.generation ?? 1
    const currentGeneration = current?.generation ?? 1
    if (current && currentGeneration === acknowledgedGeneration) {
      outbox.delete(op.id)
    } else if (current && rebaseNewerMutation) {
      outbox.put({
        ...current,
        payload: { ...current.payload, version: wire.version },
      } satisfies OutboxUpsertOp)
    }
    const remaining = (await req<OutboxOp[]>(outbox.getAll())).filter(
      (entry): entry is OutboxUpsertOp =>
        entry.type === 'upsertNote' && entry.noteId === op.noteId,
    )
    const existing = await req<StoredNoteRecord | undefined>(notes.get(op.noteId))
    if (remaining.length === 0) {
      notes.put({ id: wire.id, wire, neverSynced: false } satisfies StoredNoteRecord)
    } else if (rebaseNewerMutation) {
      for (const rem of remaining) {
        outbox.put({
          ...rem,
          payload: { ...rem.payload, version: wire.version },
        } satisfies OutboxUpsertOp)
      }
      if (existing) {
        notes.put({
          id: existing.id,
          neverSynced: false,
          wire: {
            ...existing.wire,
            version: wire.version,
            attachments: wire.attachments,
          },
        } satisfies StoredNoteRecord)
      } else {
        notes.put({ id: wire.id, wire, neverSynced: false } satisfies StoredNoteRecord)
      }
    }
    await txDone(tx)
    db.close()
  }

  async dropOutboxOpAndNote(op: OutboxUpsertOp): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox'], 'readwrite')
    tx.objectStore('outbox').delete(op.id)
    const remaining = (await req<OutboxOp[]>(tx.objectStore('outbox').getAll())).some(
      (entry) => entry.type === 'upsertNote' && entry.noteId === op.noteId,
    )
    if (!remaining) tx.objectStore('notes').delete(op.noteId)
    await txDone(tx)
    db.close()
  }

  async listOutbox(): Promise<OutboxOp[]> {
    const db = await this.open()
    const tx = db.transaction('outbox', 'readonly')
    const ops = await req<OutboxOp[]>(tx.objectStore('outbox').getAll())
    db.close()
    return ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async pendingNoteIds(): Promise<Set<string>> {
    const ops = await this.listOutbox()
    return new Set(
      ops.filter((op): op is OutboxUpsertOp => op.type === 'upsertNote').map((op) => op.noteId),
    )
  }

  async pendingCount(): Promise<number> {
    return (await this.listOutbox()).length
  }

  async clearOutbox(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction('outbox', 'readwrite')
    tx.objectStore('outbox').clear()
    await txDone(tx)
    db.close()
  }

  /** Drop notes, outbox, label cache, and sync cursor. Keep the cached vault wrap. */
  async clearNotesAndLabels(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['notes', 'outbox', 'labels', 'meta'], 'readwrite')
    tx.objectStore('notes').clear()
    tx.objectStore('outbox').clear()
    tx.objectStore('labels').clear()
    tx.objectStore('meta').delete('cursor')
    await txDone(tx)
    db.close()
  }

  async clearAll(): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(['meta', 'vault', 'notes', 'outbox', 'labels'], 'readwrite')
    tx.objectStore('meta').clear()
    tx.objectStore('vault').clear()
    tx.objectStore('notes').clear()
    tx.objectStore('outbox').clear()
    tx.objectStore('labels').clear()
    await txDone(tx)
    db.close()
  }
}

export async function clearUserOfflineData(userId: number): Promise<void> {
  await new LocalRepository(userId).clearAll()
}
