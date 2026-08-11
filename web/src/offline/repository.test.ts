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
