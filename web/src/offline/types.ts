export type SyncStatusKind = 'offline' | 'synced' | 'syncing' | 'pending' | 'error'

export interface SyncStatus {
  kind: SyncStatusKind
  pendingCount: number
  lastError: string | null
  lastSyncedAt: string | null
}

export interface StoredNoteRecord {
  id: string
  wire: import('../types').EncryptedNoteWire
  /** True until the first successful server create/update for this local upsert. */
  neverSynced: boolean
}

export interface OutboxUpsertOp {
  id: string
  type: 'upsertNote'
  noteId: string
  payload: import('../types').EncryptedNoteWrite
  /** Incremented whenever a newer mutation replaces this operation in place. */
  generation: number
  /** Opening snapshot uploaded before the first mutation to preserve history. */
  baselineRevision?: import('../types').CreateNoteRevisionRequest
  createdAt: string
  updatedAt: string
}

export type OutboxOp = OutboxUpsertOp

export interface SyncCursor {
  updatedAfter?: string
  afterId?: string
}

export interface StoredVaultCache {
  userId: number
  vault: import('../types').VaultInfo
  updatedAt: string
}

export interface StoredLabelCache {
  wires: import('../types').EncryptedLabelWire[]
  updatedAt: string
}
