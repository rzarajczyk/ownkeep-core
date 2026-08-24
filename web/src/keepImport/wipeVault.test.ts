import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from '../i18n'
import { LocalRepository } from '../offline/repository'
import { wipeVaultContent } from './wipeVault'

const api = vi.hoisted(() => ({
  notes: vi.fn(),
  listLabels: vi.fn(),
  deleteNote: vi.fn(),
  deleteLabel: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api }
})

describe('wipeVaultContent', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    vi.clearAllMocks()
    api.deleteNote.mockResolvedValue(undefined)
    api.deleteLabel.mockResolvedValue(undefined)
  })

  it('deletes notes and labels then clears local notes without the vault cache', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.cacheVault({
      kdfSalt: 'aa',
      kdfParams: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
      wrappedVaultKey: 'bb',
      wrappedVaultKeyRecovery: 'cc',
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    })
    api.notes.mockResolvedValueOnce({
      items: [{ id: 'note-1' }, { id: 'note-2' }],
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
    api.listLabels.mockResolvedValue([{ id: 'label-1', ciphertext: 'x', createdAt: '2026-01-01T00:00:00.000Z' }])

    await wipeVaultContent(repo, () => undefined)

    expect(api.deleteNote).toHaveBeenCalledTimes(2)
    expect(api.deleteLabel).toHaveBeenCalledWith('label-1')
    expect(await repo.listNotes()).toEqual([])
    expect(await repo.getCachedVault()).not.toBeNull()
  })
})
