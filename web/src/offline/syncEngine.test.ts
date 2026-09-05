import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EncryptedNoteWire } from '../types'
import { LocalRepository } from './repository'
import { SyncEngine } from './syncEngine'
import type { OutboxUpsertOp } from './types'

const api = vi.hoisted(() => ({
  note: vi.fn(),
  notes: vi.fn(),
  conflictResolve: vi.fn(),
  createNoteRevision: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  listLabels: vi.fn(),
}))

const ApiError = vi.hoisted(() => {
  return class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
})

vi.mock('../api', () => ({
  api,
  ApiError,
}))

const noteCodec = vi.hoisted(() => ({
  unwrapNoteKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  decryptNotePayload: vi.fn().mockResolvedValue({
    v: 1,
    title: 'Queued note',
    contentRaw: 'Body',
    items: [],
    labelIds: ['valid-label', 'deleted-label'],
  }),
  encryptNotePayload: vi.fn().mockResolvedValue('sanitized-ciphertext'),
}))

vi.mock('../crypto/noteCodec', () => noteCodec)

vi.mock('./conflictSnapshots', () => ({
  buildConflictRevisionSnapshots: vi.fn().mockResolvedValue({
    localSnapshotCiphertext: 'local-snapshot',
    remoteSnapshotCiphertext: 'remote-snapshot',
  }),
}))

function remoteWire(version = 7): EncryptedNoteWire {
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
    version,
  }
}

describe('SyncEngine conflict resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it('removes deleted label IDs and re-encrypts before retrying a rejected outbox write', async () => {
    const remote = {
      ...remoteWire(8),
      ciphertext: 'sanitized-ciphertext',
      labelIds: ['valid-label'],
    }
    api.listLabels.mockResolvedValue([
      {
        id: 'valid-label',
        ciphertext: 'encrypted-label',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    api.updateNote
      .mockRejectedValueOnce(new ApiError('invalid labels', 400, 'invalid_labels'))
      .mockResolvedValueOnce(remote)
    const acknowledgeOutboxOp = vi.fn()
    const replaceOutboxPayloadIfCurrent = vi.fn().mockResolvedValue(true)
    const repo = {
      getNote: vi.fn().mockResolvedValue({ id: remote.id, wire: remote, neverSynced: false }),
      acknowledgeOutboxOp,
      replaceOutboxPayloadIfCurrent,
    } as unknown as LocalRepository
    const engine = new SyncEngine(repo)
    engine.setVaultKey(new Uint8Array(32))
    const op: OutboxUpsertOp = {
      id: 'operation-with-deleted-label',
      type: 'upsertNote',
      noteId: remote.id,
      generation: 1,
      payload: {
        id: remote.id,
        version: 7,
        type: 'TEXT',
        wrappedNoteKey: 'local-wrap',
        ciphertext: 'local-cipher',
        labelIds: ['valid-label', 'deleted-label'],
        clientUpdatedAt: '2026-01-01T00:02:00.000Z',
        clientMutationId: 'local-mutation',
      },
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    }

    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(op)

    expect(api.updateNote).toHaveBeenNthCalledWith(
      2,
      remote.id,
      expect.objectContaining({
        labelIds: ['valid-label'],
        ciphertext: 'sanitized-ciphertext',
      }),
    )
    expect(noteCodec.encryptNotePayload).toHaveBeenCalledWith(
      remote.id,
      expect.any(Uint8Array),
      expect.objectContaining({ labelIds: ['valid-label'] }),
    )
    expect(replaceOutboxPayloadIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          labelIds: ['valid-label'],
          ciphertext: 'sanitized-ciphertext',
        }),
      }),
    )
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
    expect(acknowledgeOutboxOp).toHaveBeenCalledWith(op, remote, {
      rebaseNewerMutation: false,
    })
  })

  it('rebases newer mutations when the local side wins a conflict', async () => {
    const remote = remoteWire()
    const localWinner = { ...remote, ciphertext: 'local-cipher', version: 8 }
    api.note.mockResolvedValue(remote)
    api.conflictResolve.mockResolvedValue({
      note: localWinner,
      winner: 'local',
      localRevision: null,
      remoteRevision: null,
    })
    const acknowledgeOutboxOp = vi.fn()
    const repo = { acknowledgeOutboxOp } as unknown as LocalRepository
    const engine = new SyncEngine(repo)
    engine.setVaultKey(new Uint8Array(32))
    const op: OutboxUpsertOp = {
      id: 'operation-local-win',
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

    expect(acknowledgeOutboxOp).toHaveBeenCalledWith(op, localWinner, {
      rebaseNewerMutation: true,
    })
  })

  it('re-conflicts a coalesced follow-up that was preserved after a remote win', async () => {
    const noteId = '11111111-1111-4111-8111-111111111111'
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(
      {
        id: noteId,
        type: 'TEXT',
        backgroundColor: '#ffffff',
        archived: false,
        pinned: false,
        wrappedNoteKey: 'wrap-a',
        ciphertext: 'cipher-a',
        labelIds: [],
        attachments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        clientUpdatedAt: '2026-01-01T00:00:00.000Z',
        clientMutationId: 'mutation-a',
        version: 3,
      },
      {
        id: noteId,
        type: 'TEXT',
        wrappedNoteKey: 'wrap-a',
        ciphertext: 'cipher-a',
        version: 3,
        clientUpdatedAt: '2026-01-01T00:00:00.000Z',
        clientMutationId: 'mutation-a',
      },
    )
    const [inFlight] = await repo.listOutbox()
    await repo.upsertLocalNote(
      {
        id: noteId,
        type: 'TEXT',
        backgroundColor: '#ffffff',
        archived: false,
        pinned: false,
        wrappedNoteKey: 'wrap-b',
        ciphertext: 'cipher-b',
        labelIds: [],
        attachments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:30.000Z',
        clientUpdatedAt: '2026-01-01T00:00:30.000Z',
        clientMutationId: 'mutation-b',
        version: 3,
      },
      {
        id: noteId,
        type: 'TEXT',
        wrappedNoteKey: 'wrap-b',
        ciphertext: 'cipher-b',
        version: 3,
        clientUpdatedAt: '2026-01-01T00:00:30.000Z',
        clientMutationId: 'mutation-b',
      },
    )

    const remote = remoteWire(8)
    await repo.acknowledgeOutboxOp(inFlight!, remote, { rebaseNewerMutation: false })
    const [pending] = await repo.listOutbox()
    expect(pending?.payload.version).toBe(3)
    expect(pending?.payload.ciphertext).toBe('cipher-b')

    api.updateNote.mockRejectedValue(new ApiError('conflict', 409, 'version_conflict'))
    api.note.mockResolvedValue(remote)
    api.conflictResolve.mockResolvedValue({
      note: remote,
      winner: 'remote',
      localRevision: null,
      remoteRevision: null,
    })

    const engine = new SyncEngine(repo)
    engine.setVaultKey(new Uint8Array(32))
    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(pending!)

    expect(api.updateNote).toHaveBeenCalledWith(
      noteId,
      expect.objectContaining({ version: 3, ciphertext: 'cipher-b' }),
    )
    expect(api.conflictResolve).toHaveBeenCalledWith(
      noteId,
      expect.objectContaining({ version: 3, ciphertext: 'cipher-b' }),
    )
  })
})

describe('SyncEngine batch outbox push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pushes and acknowledges every independently queued note update', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const noteIds = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]
    for (const [index, id] of noteIds.entries()) {
      const queued = {
        ...remoteWire(1),
        id,
        backgroundColor: '#fff475',
        ciphertext: `batch-cipher-${index}`,
        clientMutationId: `batch-mutation-${index}`,
      }
      await repo.putSyncedNotes([queued], [])
      await repo.upsertLocalNote(queued, {
        id,
        type: 'TEXT',
        backgroundColor: '#fff475',
        archived: false,
        pinned: false,
        wrappedNoteKey: queued.wrappedNoteKey,
        ciphertext: queued.ciphertext,
        labelIds: [],
        version: 1,
        clientUpdatedAt: queued.clientUpdatedAt,
        clientMutationId: queued.clientMutationId,
      })
    }
    api.updateNote.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
      ...remoteWire(2),
      id,
      type: payload.type ?? 'TEXT',
      backgroundColor: payload.backgroundColor ?? '#ffffff',
      archived: payload.archived ?? false,
      pinned: payload.pinned ?? false,
      wrappedNoteKey: payload.wrappedNoteKey ?? 'wrap',
      ciphertext: payload.ciphertext ?? 'cipher',
      labelIds: payload.labelIds ?? [],
      clientUpdatedAt: payload.clientUpdatedAt ?? '2026-01-01T00:02:00.000Z',
      clientMutationId: payload.clientMutationId ?? null,
    }))

    const engine = new SyncEngine(repo)
    await (
      engine as unknown as { pushOutbox(): Promise<void> }
    ).pushOutbox()

    expect(api.updateNote).toHaveBeenCalledTimes(2)
    expect(api.updateNote).toHaveBeenCalledWith(
      noteIds[0],
      expect.objectContaining({ backgroundColor: '#fff475', ciphertext: 'batch-cipher-0' }),
    )
    expect(api.updateNote).toHaveBeenCalledWith(
      noteIds[1],
      expect.objectContaining({ backgroundColor: '#fff475', ciphertext: 'batch-cipher-1' }),
    )
    expect(await repo.listOutbox()).toEqual([])
  })
})

describe('SyncEngine pull', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('applies synced wires, removes tombstones, skips pending ids, and advances cursor', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const applyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pendingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const deleteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    await repo.putSyncedNotes(
      [
        {
          ...remoteWire(1),
          id: deleteId,
          ciphertext: 'to-delete',
        },
      ],
      [],
    )
    await repo.upsertLocalNote(
      {
        ...remoteWire(2),
        id: pendingId,
        ciphertext: 'local-pending',
        clientMutationId: 'pending-mutation',
      },
      {
        id: pendingId,
        type: 'TEXT',
        wrappedNoteKey: 'pending-wrap',
        ciphertext: 'local-pending',
        version: 2,
        clientUpdatedAt: '2026-01-01T00:02:00.000Z',
        clientMutationId: 'pending-mutation',
      },
    )

    const applied = {
      ...remoteWire(5),
      id: applyId,
      ciphertext: 'synced-cipher',
      updatedAt: '2026-01-02T00:00:00.000Z',
      clientUpdatedAt: '2026-01-02T00:00:00.000Z',
      clientMutationId: 'synced-mutation',
    }
    const pendingRemote = {
      ...remoteWire(9),
      id: pendingId,
      ciphertext: 'should-not-overwrite',
      clientMutationId: 'server-pending',
    }

    api.notes.mockResolvedValue({
      items: [applied, pendingRemote],
      deletedIds: [deleteId],
      nextUpdatedAfter: '2026-01-02T00:00:00.000Z',
      nextAfterId: applyId,
      hasMore: false,
    })

    const engine = new SyncEngine(repo)
    await (engine as unknown as { pull(): Promise<void> }).pull()

    const notes = await repo.listNotes()
    const byId = new Map(notes.map((note) => [note.id, note]))
    expect(byId.get(applyId)?.wire.ciphertext).toBe('synced-cipher')
    expect(byId.get(pendingId)?.wire.ciphertext).toBe('local-pending')
    expect(byId.has(deleteId)).toBe(false)
    expect(await repo.getCursor()).toEqual({
      updatedAfter: '2026-01-02T00:00:00.000Z',
      afterId: applyId,
    })
    expect(api.notes).toHaveBeenCalledWith({
      limit: 100,
      updatedAfter: undefined,
      afterId: undefined,
    })
  })

  it('uses createNote for neverSynced notes on push', async () => {
    const noteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const created = {
      ...remoteWire(1),
      id: noteId,
      ciphertext: 'created-cipher',
      clientMutationId: 'create-mutation',
    }
    api.createNote.mockResolvedValue(created)

    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(
      {
        ...remoteWire(0),
        id: noteId,
        ciphertext: 'local-cipher',
        version: 0,
        clientMutationId: 'create-mutation',
      },
      {
        id: noteId,
        type: 'TEXT',
        wrappedNoteKey: 'local-wrap',
        ciphertext: 'local-cipher',
        version: 0,
        clientUpdatedAt: '2026-01-01T00:02:00.000Z',
        clientMutationId: 'create-mutation',
      },
      { neverSynced: true },
    )
    const [op] = await repo.listOutbox()
    const engine = new SyncEngine(repo)
    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(op as OutboxUpsertOp)

    expect(api.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: 'local-cipher' }),
    )
    expect(api.updateNote).not.toHaveBeenCalled()
    expect(await repo.listOutbox()).toEqual([])
    expect((await repo.getNote(noteId))?.neverSynced).toBe(false)
  })

  it('resolves a create retry as a conflict when the server has a different mutation', async () => {
    const noteId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const local = {
      ...remoteWire(0),
      id: noteId,
      ciphertext: 'newer-local-cipher',
      clientUpdatedAt: '2026-01-01T00:03:00.000Z',
      clientMutationId: 'newer-local-mutation',
    }
    await repo.upsertLocalNote(local, local, { neverSynced: true })
    const [op] = await repo.listOutbox()
    const remote = {
      ...remoteWire(0),
      id: noteId,
      ciphertext: 'first-create-cipher',
      clientUpdatedAt: '2026-01-01T00:02:00.000Z',
      clientMutationId: 'first-create-mutation',
    }
    const localWinner = { ...local, version: 1 }
    api.createNote.mockRejectedValue(new ApiError('already exists', 409, 'note_exists'))
    api.note.mockResolvedValue(remote)
    api.conflictResolve.mockResolvedValue({
      note: localWinner,
      winner: 'local',
      localRevision: null,
      remoteRevision: null,
    })

    const engine = new SyncEngine(repo)
    engine.setVaultKey(new Uint8Array(32))
    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(op as OutboxUpsertOp)

    expect(api.conflictResolve).toHaveBeenCalledWith(
      noteId,
      expect.objectContaining({ version: -1, ciphertext: 'newer-local-cipher' }),
    )
    expect((await repo.getNote(noteId))?.wire.ciphertext).toBe('newer-local-cipher')
    expect(await repo.listOutbox()).toEqual([])
  })

  it('acknowledges a create retry when the server has the same mutation', async () => {
    const noteId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const local = {
      ...remoteWire(0),
      id: noteId,
      clientMutationId: 'same-create-mutation',
    }
    await repo.upsertLocalNote(local, local, { neverSynced: true })
    const [op] = await repo.listOutbox()
    api.createNote.mockRejectedValue(new ApiError('already exists', 409, 'note_exists'))
    api.note.mockResolvedValue({ ...local, version: 1 })

    const engine = new SyncEngine(repo)
    await (
      engine as unknown as { pushUpsert(operation: OutboxUpsertOp): Promise<void> }
    ).pushUpsert(op as OutboxUpsertOp)

    expect(api.conflictResolve).not.toHaveBeenCalled()
    expect(await repo.listOutbox()).toEqual([])
    expect((await repo.getNote(noteId))?.neverSynced).toBe(false)
  })

  it('does not pull while paused', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    api.notes.mockResolvedValue({
      items: [],
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
    const engine = new SyncEngine(repo)
    engine.start()
    engine.pause()
    api.notes.mockClear()
    await engine.sync()
    expect(api.notes).not.toHaveBeenCalled()
    engine.stop()
  })
})
