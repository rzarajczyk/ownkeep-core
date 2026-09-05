import { describe, expect, it } from 'vitest'
import type { EncryptedNoteWire, EncryptedNoteWrite } from '../types'
import { LocalRepository } from './repository'

const NOTE_ID = '11111111-1111-4111-8111-111111111111'

function wire(
  ciphertext: string,
  mutationId: string,
  version = 1,
  extras?: Partial<EncryptedNoteWire>,
): EncryptedNoteWire {
  return {
    id: NOTE_ID,
    type: 'TEXT',
    backgroundColor: '#ffffff',
    archived: false,
    pinned: false,
    wrappedNoteKey: `wrap-${mutationId}`,
    ciphertext,
    labelIds: [],
    attachments: extras?.attachments ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    clientMutationId: mutationId,
    version,
    ...extras,
  }
}

function write(
  ciphertext: string,
  mutationId: string,
  version = 1,
): EncryptedNoteWrite {
  return {
    id: NOTE_ID,
    type: 'TEXT',
    wrappedNoteKey: `wrap-${mutationId}`,
    ciphertext,
    version,
    clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    clientMutationId: mutationId,
  }
}

describe('LocalRepository outbox acknowledgement', () => {
  it('keeps a newer coalesced mutation pending when an older push completes', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    const [inFlight] = await repo.listOutbox()

    await repo.upsertLocalNote(wire('cipher-b', 'mutation-b'), write('cipher-b', 'mutation-b'))
    await repo.acknowledgeOutboxOp(inFlight!, wire('cipher-a', 'mutation-a', 2))

    const [pending] = await repo.listOutbox()
    const stored = await repo.getNote(NOTE_ID)
    expect(pending?.payload.ciphertext).toBe('cipher-b')
    expect(pending?.payload.version).toBe(2)
    expect(stored?.wire.ciphertext).toBe('cipher-b')
    expect(stored?.wire.version).toBe(2)
  })

  it('does not rebase a newer coalesced mutation after a remote-winning conflict', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    const [inFlight] = await repo.listOutbox()

    await repo.upsertLocalNote(wire('cipher-b', 'mutation-b'), write('cipher-b', 'mutation-b'))
    const remote = wire('cipher-remote', 'remote-mutation', 8, {
      attachments: [
        {
          id: 'att-1',
          metaCiphertext: 'meta',
          sizeBytes: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
          url: '/attachments/att-1',
        },
      ],
      clientUpdatedAt: '2026-01-01T00:05:00.000Z',
    })
    await repo.acknowledgeOutboxOp(inFlight!, remote, { rebaseNewerMutation: false })

    const [pending] = await repo.listOutbox()
    const stored = await repo.getNote(NOTE_ID)
    expect(pending?.payload.ciphertext).toBe('cipher-b')
    expect(pending?.payload.version).toBe(1)
    expect(pending?.payload.clientMutationId).toBe('mutation-b')
    expect(stored?.wire.ciphertext).toBe('cipher-b')
    expect(stored?.wire.version).toBe(1)
    expect(stored?.wire.attachments).toEqual([])
  })

  it('stores the remote winner when acknowledging without a newer coalesced mutation', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    const [inFlight] = await repo.listOutbox()
    const remote = wire('cipher-remote', 'remote-mutation', 8)

    await repo.acknowledgeOutboxOp(inFlight!, remote, { rebaseNewerMutation: false })

    expect(await repo.listOutbox()).toEqual([])
    const stored = await repo.getNote(NOTE_ID)
    expect(stored?.wire.ciphertext).toBe('cipher-remote')
    expect(stored?.wire.version).toBe(8)
  })

  it('rebases a newer coalesced mutation after a local-winning conflict', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    const [inFlight] = await repo.listOutbox()

    await repo.upsertLocalNote(wire('cipher-b', 'mutation-b'), write('cipher-b', 'mutation-b'))
    const localWinner = wire('cipher-a', 'mutation-a', 8)
    await repo.acknowledgeOutboxOp(inFlight!, localWinner, { rebaseNewerMutation: true })

    const [pending] = await repo.listOutbox()
    const stored = await repo.getNote(NOTE_ID)
    expect(pending?.payload.ciphertext).toBe('cipher-b')
    expect(pending?.payload.version).toBe(8)
    expect(stored?.wire.ciphertext).toBe('cipher-b')
    expect(stored?.wire.version).toBe(8)
  })
})

describe('LocalRepository sync helpers', () => {
  it('persists repaired outbox payloads without overwriting a newer generation', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-stale', 'mutation-a'), {
      ...write('cipher-stale', 'mutation-a'),
      labelIds: ['valid-label', 'deleted-label'],
    })
    const [original] = await repo.listOutbox()
    const repaired = {
      ...original!,
      payload: {
        ...original!.payload,
        ciphertext: 'cipher-repaired',
        labelIds: ['valid-label'],
      },
    }

    expect(await repo.replaceOutboxPayloadIfCurrent(repaired)).toBe(true)
    expect((await repo.listOutbox())[0]?.payload.ciphertext).toBe('cipher-repaired')
    expect((await repo.getNote(NOTE_ID))?.wire.labelIds).toEqual(['valid-label'])

    await repo.upsertLocalNote(
      wire('cipher-newer', 'mutation-b'),
      write('cipher-newer', 'mutation-b'),
    )
    expect(await repo.replaceOutboxPayloadIfCurrent(repaired)).toBe(false)
    expect((await repo.listOutbox())[0]?.payload.ciphertext).toBe('cipher-newer')
  })

  it('queues independent full-note batch updates and coalesces later changes per note', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const secondId = '22222222-2222-4222-8222-222222222222'
    await repo.upsertLocalNote(
      wire('cipher-a', 'mutation-a', 1, { backgroundColor: '#fff475' }),
      { ...write('cipher-a', 'mutation-a'), backgroundColor: '#fff475' },
    )
    await repo.upsertLocalNote(
      {
        ...wire('cipher-b', 'mutation-b', 1, { archived: true }),
        id: secondId,
      },
      {
        ...write('cipher-b', 'mutation-b'),
        id: secondId,
        archived: true,
      },
    )

    expect(await repo.pendingNoteIds()).toEqual(new Set([NOTE_ID, secondId]))
    expect(await repo.listOutbox()).toHaveLength(2)

    await repo.upsertLocalNote(
      wire('cipher-a-label', 'mutation-a-label', 1, {
        backgroundColor: '#fff475',
        labelIds: ['label-1'],
      }),
      {
        ...write('cipher-a-label', 'mutation-a-label'),
        backgroundColor: '#fff475',
        labelIds: ['label-1'],
      },
    )

    const ops = await repo.listOutbox()
    expect(ops).toHaveLength(2)
    const first = ops.find((op) => op.noteId === NOTE_ID)
    expect(first?.payload.ciphertext).toBe('cipher-a-label')
    expect(first?.payload.labelIds).toEqual(['label-1'])
    expect(first?.generation).toBe(2)
  })

  it('marks neverSynced and coalesces outbox to one op', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'), {
      neverSynced: true,
    })
    expect((await repo.getNote(NOTE_ID))?.neverSynced).toBe(true)

    await repo.upsertLocalNote(wire('cipher-b', 'mutation-b'), write('cipher-b', 'mutation-b'))
    const ops = await repo.listOutbox()
    expect(ops).toHaveLength(1)
    expect(ops[0]?.type).toBe('upsertNote')
    if (ops[0]?.type === 'upsertNote') {
      expect(ops[0].payload.ciphertext).toBe('cipher-b')
      expect(ops[0].generation).toBe(2)
    }
    expect((await repo.getNote(NOTE_ID))?.neverSynced).toBe(true)
  })

  it('round-trips cached vault info', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const vault = {
      kdfSalt: 'salt',
      kdfParams: { alg: 'argon2id' as const, m: 65536, t: 3, p: 1 },
      wrappedVaultKey: 'wrap',
      wrappedVaultKeyRecovery: 'recovery-wrap',
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    }
    await repo.cacheVault(vault)
    expect(await repo.getCachedVault()).toEqual(vault)
  })

  it('putSyncedNotes inserts wires and deletes tombstones', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const keepId = '22222222-2222-4222-8222-222222222222'
    const dropId = '33333333-3333-4333-8333-333333333333'
    await repo.putSyncedNotes(
      [
        { ...wire('keep', 'keep-m'), id: keepId },
        { ...wire('drop', 'drop-m'), id: dropId },
      ],
      [],
    )
    await repo.putSyncedNotes([{ ...wire('keep-2', 'keep-m-2', 2), id: keepId }], [dropId])

    const notes = await repo.listNotes()
    expect(notes.map((note) => note.id).sort()).toEqual([keepId])
    expect(notes[0]?.wire.ciphertext).toBe('keep-2')
    expect(notes[0]?.neverSynced).toBe(false)
  })

  it('clearNotesAndLabels drops notes and outbox but keeps the vault cache', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const vault = {
      kdfSalt: 'aa',
      kdfParams: { alg: 'argon2id' as const, m: 65536, t: 3, p: 1 },
      wrappedVaultKey: 'wrap',
      wrappedVaultKeyRecovery: 'recovery-wrap',
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    }
    await repo.cacheVault(vault)
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    await repo.clearNotesAndLabels()
    expect(await repo.listNotes()).toEqual([])
    expect(await repo.listOutbox()).toEqual([])
    expect(await repo.getCachedVault()).toEqual(vault)
  })

  it('pendingNoteIds includes outbox notes', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    expect(await repo.pendingNoteIds()).toEqual(new Set())
    await repo.upsertLocalNote(wire('cipher-a', 'mutation-a'), write('cipher-a', 'mutation-a'))
    expect(await repo.pendingNoteIds()).toEqual(new Set([NOTE_ID]))
  })

  it('returns only notes with pending outbox writes', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const syncedId = '22222222-2222-4222-8222-222222222222'
    await repo.putSyncedNotes([{ ...wire('synced', 'synced-mutation'), id: syncedId }], [])
    await repo.upsertLocalNote(wire('pending', 'pending-mutation'), write('pending', 'pending-mutation'))

    expect(await repo.listPendingNotes()).toEqual([
      expect.objectContaining({ id: NOTE_ID, ciphertext: 'pending' }),
    ])
  })
})
