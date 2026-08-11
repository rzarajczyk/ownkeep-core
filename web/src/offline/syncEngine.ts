import { api, ApiError } from '../api'
import type { EncryptedNoteWire, EncryptedNoteWrite } from '../types'
import { buildConflictRevisionSnapshots } from './conflictSnapshots'
import { isNewerMutation } from './lww'
import { LocalRepository } from './repository'
import type { OutboxUpsertOp, SyncStatus } from './types'

const LOCK_NAME = 'ownkeep-sync-engine'

export type SyncEngineListener = (status: SyncStatus) => void

export class SyncEngine {
  private running = false
  private timer: number | null = null
  private listeners = new Set<SyncEngineListener>()
  private lastError: string | null = null
  private lastSyncedAt: string | null = null
  private syncing = false
  private readonly repo: LocalRepository
  private onStoreChanged: (() => void) | null = null
  private vaultKey: Uint8Array | null = null

  constructor(repo: LocalRepository, onStoreChanged?: () => void) {
    this.repo = repo
    this.onStoreChanged = onStoreChanged ?? null
  }

  setVaultKey(vaultKey: Uint8Array | null) {
    this.vaultKey = vaultKey
  }

  subscribe(listener: SyncEngineListener): () => void {
    this.listeners.add(listener)
    void this.emit()
    return () => this.listeners.delete(listener)
  }

  start() {
    if (this.running) return
    this.running = true
    const kick = () => void this.sync()
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick()
    })
    this.timer = window.setInterval(kick, 30_000)
    kick()
    ;(this as { _cleanup?: () => void })._cleanup = () => {
      window.removeEventListener('online', kick)
      if (this.timer != null) window.clearInterval(this.timer)
    }
  }

  stop() {
    this.running = false
    ;(this as { _cleanup?: () => void })._cleanup?.()
  }

  kick() {
    void this.sync()
  }

  private async emit() {
    const pendingCount = await this.repo.pendingCount()
    const status: SyncStatus = {
      kind: !navigator.onLine
        ? 'offline'
        : this.syncing
          ? 'syncing'
          : this.lastError
            ? 'error'
            : pendingCount > 0
              ? 'pending'
              : 'synced',
      pendingCount,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
    }
    for (const listener of this.listeners) listener(status)
  }

  async sync(): Promise<void> {
    if (!this.running || !navigator.onLine) {
      await this.emit()
      return
    }
    const locks = navigator.locks
    if (locks?.request) {
      await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return
        await this.runLocked()
      })
    } else {
      await this.runLocked()
    }
  }

  private async runLocked() {
    if (this.syncing) return
    this.syncing = true
    await this.emit()
    try {
      await this.pushOutbox()
      await this.pull()
      this.lastError = null
      this.lastSyncedAt = new Date().toISOString()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'connection_failed') {
        this.lastError = error.message
      } else if (error instanceof ApiError && error.status === 401) {
        this.lastError = error.message
      } else {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.syncing = false
      await this.emit()
    }
  }

  private async pushOutbox() {
    const ops = await this.repo.listOutbox()
    for (const op of ops) {
      if (op.type !== 'upsertNote') continue
      // Re-read op in case a newer coalesced payload replaced it mid-loop.
      const current = (await this.repo.listOutbox()).find(
        (entry): entry is OutboxUpsertOp => entry.id === op.id,
      )
      if (!current) continue
      await this.pushUpsert(current)
    }
  }

  private async pushUpsert(op: OutboxUpsertOp) {
    const stored = await this.repo.getNote(op.noteId)
    const payload = op.payload
    try {
      if (op.baselineRevision && !stored?.neverSynced) {
        try {
          await api.createNoteRevision(op.noteId, op.baselineRevision)
        } catch (error) {
          // A remote write may have advanced the note before this device reconnected.
          // The conflict protocol below preserves both resulting snapshots instead.
          if (!(error instanceof ApiError && error.code === 'version_conflict')) throw error
        }
      }
      let wire: EncryptedNoteWire
      if (stored?.neverSynced) {
        wire = await api.createNote(payload)
      } else {
        wire = await api.updateNote(op.noteId, payload)
      }
      await this.repo.acknowledgeOutboxOp(op, wire)
      this.onStoreChanged?.()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'note_exists') {
        const wire = await api.note(op.noteId)
        await this.repo.acknowledgeOutboxOp(op, wire)
        this.onStoreChanged?.()
        return
      }
      if (error instanceof ApiError && error.code === 'version_conflict') {
        await this.resolveConflict(op)
        return
      }
      if (error instanceof ApiError && error.code === 'note_not_found') {
        await this.repo.dropOutboxOpAndNote(op)
        this.onStoreChanged?.()
        return
      }
      throw error
    }
  }

  private async resolveConflict(op: OutboxUpsertOp) {
    const payload = op.payload
    if (!payload.wrappedNoteKey || !payload.ciphertext || payload.version == null) {
      throw new Error('Cannot resolve conflict without ciphertext and version')
    }
    if (!payload.clientUpdatedAt || !payload.clientMutationId) {
      throw new Error('Cannot resolve conflict without clientUpdatedAt/clientMutationId')
    }
    if (!this.vaultKey) {
      throw new Error('Cannot resolve conflict while vault is locked')
    }
    const remote = await api.note(op.noteId)
    const localRevisionId = crypto.randomUUID()
    const remoteRevisionId = crypto.randomUUID()
    const snapshots = await buildConflictRevisionSnapshots(
      op.noteId,
      this.vaultKey,
      payload,
      remote,
      localRevisionId,
      remoteRevisionId,
    )
    const result = await api.conflictResolve(op.noteId, {
      // Keep the rejected version so the server executes LWW + revision capture.
      version: payload.version,
      localRevisionId,
      remoteRevisionId,
      type: payload.type,
      backgroundColor: payload.backgroundColor ?? 'default',
      archived: payload.archived ?? false,
      pinned: payload.pinned ?? false,
      wrappedNoteKey: payload.wrappedNoteKey,
      ciphertext: payload.ciphertext,
      localSnapshotCiphertext: snapshots.localSnapshotCiphertext,
      remoteSnapshotCiphertext: snapshots.remoteSnapshotCiphertext,
      labelIds: payload.labelIds,
      clientUpdatedAt: payload.clientUpdatedAt,
      clientMutationId: payload.clientMutationId,
    })
    await this.repo.acknowledgeOutboxOp(op, result.note)
    this.onStoreChanged?.()
  }

  private async pull() {
    let cursor = await this.repo.getCursor()
    let hasMore = true
    let changed = false
    while (hasMore) {
      const page = await api.notes({
        limit: 100,
        updatedAfter: cursor.updatedAfter,
        afterId: cursor.afterId,
      })
      const pending = await this.repo.pendingNoteIds()
      const applicable = page.items.filter((wire) => !pending.has(wire.id))
      const toApply: EncryptedNoteWire[] = []
      for (const wire of applicable) {
        const local = await this.repo.getNote(wire.id)
        // Apply when server version advanced (covers attachment metadata) or LWW clock wins.
        if (
          !local ||
          wire.version > local.wire.version ||
          isNewerMutation(wire, local.wire)
        ) {
          toApply.push(wire)
        }
      }
      const deleted = page.deletedIds.filter((id) => !pending.has(id))
      if (toApply.length > 0 || deleted.length > 0) changed = true
      await this.repo.putSyncedNotes(toApply, deleted)
      hasMore = page.hasMore
      const next = {
        updatedAfter: page.nextUpdatedAfter ?? cursor.updatedAfter,
        afterId: page.nextAfterId ?? cursor.afterId,
      }
      if (
        hasMore &&
        next.updatedAfter === cursor.updatedAfter &&
        next.afterId === cursor.afterId
      ) {
        break
      }
      cursor = next
      await this.repo.setCursor(cursor)
    }
    if (changed) this.onStoreChanged?.()
  }
}

/** Build a full wire snapshot from a write + previous wire for IDB storage. */
export function wireFromWrite(
  write: EncryptedNoteWrite,
  previous: EncryptedNoteWire | undefined,
  noteId: string,
): EncryptedNoteWire {
  const now = new Date().toISOString()
  return {
    id: noteId,
    type: write.type,
    backgroundColor: write.backgroundColor ?? previous?.backgroundColor ?? 'default',
    archived: write.archived ?? previous?.archived ?? false,
    pinned: write.pinned ?? previous?.pinned ?? false,
    wrappedNoteKey: write.wrappedNoteKey ?? previous?.wrappedNoteKey ?? '',
    ciphertext: write.ciphertext ?? previous?.ciphertext ?? '',
    labelIds: write.labelIds ?? previous?.labelIds ?? [],
    attachments: previous?.attachments ?? [],
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    clientUpdatedAt: write.clientUpdatedAt ?? now,
    clientMutationId: write.clientMutationId ?? previous?.clientMutationId ?? null,
    version: write.version ?? previous?.version ?? 0,
  }
}
