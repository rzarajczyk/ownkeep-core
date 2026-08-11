import { describe, expect, it, vi } from 'vitest'
import type { EncryptedNoteWire } from '../types'
import type { LocalRepository } from './repository'
import { SyncEngine } from './syncEngine'
import type { OutboxUpsertOp } from './types'

const api = vi.hoisted(() => ({
  note: vi.fn(),
  conflictResolve: vi.fn(),
  createNoteRevision: vi.fn(),
  updateNote: vi.fn(),
}))

vi.mock('../api', () => ({
  api,
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
}))

vi.mock('./conflictSnapshots', () => ({
  buildConflictRevisionSnapshots: vi.fn().mockResolvedValue({
    localSnapshotCiphertext: 'local-snapshot',
    remoteSnapshotCiphertext: 'remote-snapshot',
  }),
}))

function remoteWire(): EncryptedNoteWire {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'TEXT',
    backgroundColor: '#ffffff',
    archived: false,
    pinned: false,
    wrappedNoteKey: 'remote-wrap',
    ciphertext: 'remote-cipher',
    labelIds: [],
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    clientUpdatedAt: '2026-01-01T00:01:00.000Z',
    clientMutationId: 'remote-mutation',
    version: 7,
  }
}

describe('SyncEngine conflict resolution', () => {
  it('uploads a queued baseline before updating an existing note', async () => {
    const calls: string[] = []
    const remote = remoteWire()
    api.createNoteRevision.mockImplementation(async () => {
      calls.push('baseline')
      return { created: true, revision: null }
    })
    api.updateNote.mockImplementation(async () => {
      calls.push('update')
      return remote
    })
    const acknowledgeOutboxOp = vi.fn()
    const repo = {
      getNote: vi.fn().mockResolvedValue({ id: remote.id, wire: remote, neverSynced: false }),
      acknowledgeOutboxOp,
    } as unknown as LocalRepository
    const engine = new SyncEngine(repo)
    const op: OutboxUpsertOp = {
      id: 'operation-with-baseline',
      type: 'upsertNote',
      noteId: remote.id,
      generation: 1,
      baselineRevision: {
        id: '22222222-2222-4222-8222-222222222222',
        sourceVersion: 7,
        wrappedNoteKey: 'baseline-wrap',
        snapshotCiphertext: 'baseline-cipher',
      },
      payload: {
        id: remote.id,
        version: 7,
        type: 'TEXT',
        wrappedNoteKey: 'local-wrap',
        ciphertext: 'local-cipher',
      },
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    }

    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(op)

    expect(calls).toEqual(['baseline', 'update'])
    expect(acknowledgeOutboxOp).toHaveBeenCalledWith(op, remote)
  })

  it('sends the rejected version so the server executes the conflict branch', async () => {
    const remote = remoteWire()
    api.note.mockResolvedValue(remote)
    api.conflictResolve.mockResolvedValue({
      note: remote,
      winner: 'remote',
      localRevision: null,
      remoteRevision: null,
    })
    const acknowledgeOutboxOp = vi.fn()
    const repo = { acknowledgeOutboxOp } as unknown as LocalRepository
    const engine = new SyncEngine(repo)
    engine.setVaultKey(new Uint8Array(32))
    const op: OutboxUpsertOp = {
      id: 'operation-1',
      type: 'upsertNote',
      noteId: remote.id,
      generation: 1,
      payload: {
        id: remote.id,
        type: 'TEXT',
        backgroundColor: '#ffffff',
        archived: false,
        pinned: false,
        wrappedNoteKey: 'local-wrap',
        ciphertext: 'local-cipher',
        labelIds: [],
        version: 3,
        clientUpdatedAt: '2026-01-01T00:02:00.000Z',
        clientMutationId: 'local-mutation',
      },
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    }

    await (
      engine as unknown as { resolveConflict(operation: OutboxUpsertOp): Promise<void> }
    ).resolveConflict(op)

    expect(api.conflictResolve).toHaveBeenCalledWith(
      remote.id,
      expect.objectContaining({ version: 3 }),
    )
    expect(acknowledgeOutboxOp).toHaveBeenCalledWith(op, remote)
  })
})
