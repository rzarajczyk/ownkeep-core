import { describe, expect, it } from 'vitest'
import type { EncryptedNoteWire, EncryptedNoteWrite } from '../types'
import { LocalRepository } from './repository'

function wire(ciphertext: string, mutationId: string, version = 1): EncryptedNoteWire {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'TEXT',
    backgroundColor: '#ffffff',
    archived: false,
    pinned: false,
    wrappedNoteKey: `wrap-${mutationId}`,
    ciphertext,
    labelIds: [],
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    clientMutationId: mutationId,
    version,
  }
}

function write(ciphertext: string, mutationId: string): EncryptedNoteWrite {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'TEXT',
    wrappedNoteKey: `wrap-${mutationId}`,
    ciphertext,
    version: 1,
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
    const stored = await repo.getNote('11111111-1111-4111-8111-111111111111')
    expect(pending?.payload.ciphertext).toBe('cipher-b')
    expect(pending?.payload.version).toBe(2)
    expect(stored?.wire.ciphertext).toBe('cipher-b')
    expect(stored?.wire.version).toBe(2)
  })
})
