import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '../crypto/aead'
import { applyLanguagePreference } from '../i18n'
import { LocalRepository } from '../offline/repository'
import { runKeepImport } from './runImport'

const api = vi.hoisted(() => ({
  notes: vi.fn(),
  listLabels: vi.fn(),
  deleteNote: vi.fn(),
  deleteLabel: vi.fn(),
  createLabel: vi.fn(),
  createNote: vi.fn(),
  uploadAttachment: vi.fn(),
  note: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api }
})

vi.mock('../notesCipher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notesCipher')>()
  return {
    ...actual,
    decryptLabels: vi.fn(async (_key: Uint8Array, wires: Array<{ id: string }>) => {
      const map = new Map<string, string>()
      for (const wire of wires) {
        if (wire.id === 'work-id') map.set(wire.id, 'Work')
        if (wire.id === 'import-id') map.set(wire.id, 'Google Keep import 2026-08-24')
      }
      return map
    }),
  }
})

function keepZip(entries: Record<string, unknown>): File {
  const encoded: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) {
    encoded[path] = new TextEncoder().encode(JSON.stringify(value))
  }
  const bytes = zipSync(encoded)
  return new File([bytes], 'keep.zip', { type: 'application/zip' })
}

describe('runKeepImport', () => {
  const vaultKey = randomBytes(32)
  const pauseSync = vi.fn()
  const resumeSync = vi.fn()

  beforeEach(() => {
    applyLanguagePreference('en')
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-24T12:00:00'))
    api.notes.mockResolvedValue({
      items: [{ id: 'old-note' }],
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
    api.listLabels.mockResolvedValue([
      { id: 'work-id', ciphertext: 'work-cipher', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    api.deleteNote.mockResolvedValue(undefined)
    api.deleteLabel.mockResolvedValue(undefined)
    api.createLabel.mockImplementation(async () => ({
      id: crypto.randomUUID(),
      ciphertext: 'label-cipher',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    api.createNote.mockImplementation(async (payload) => ({
      id: payload.id,
      type: payload.type,
      backgroundColor: payload.backgroundColor ?? '#ffffff',
      archived: false,
      pinned: false,
      wrappedNoteKey: payload.wrappedNoteKey,
      ciphertext: payload.ciphertext,
      labelIds: payload.labelIds ?? [],
      attachments: [],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      clientUpdatedAt: payload.clientUpdatedAt,
      clientMutationId: payload.clientMutationId ?? null,
      version: 1,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function repo() {
    return new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
  }

  it('replace wipes existing notes and does not create a batch label', async () => {
    const file = keepZip({
      'Takeout/Keep/Note.json': {
        title: 'Hello',
        textContent: 'World',
        isPinned: false,
      },
    })
    await runKeepImport({
      file,
      vaultKey,
      mode: 'replace',
      repo: repo(),
      pauseSync,
      resumeSync,
      onProgress: () => undefined,
    })

    expect(pauseSync).toHaveBeenCalled()
    expect(resumeSync).toHaveBeenCalled()
    expect(api.deleteNote).toHaveBeenCalledWith('old-note')
    expect(api.deleteLabel).toHaveBeenCalledWith('work-id')
    expect(api.createLabel).not.toHaveBeenCalled()
    expect(api.createNote.mock.calls[0]![0].labelIds).toEqual([])
  })

  it('add reuses Work and attaches Google Keep import 2026-08-24', async () => {
    const file = keepZip({
      'Takeout/Keep/Note.json': {
        title: 'Hello',
        textContent: 'World',
        labels: [{ name: 'Work' }],
        isPinned: false,
      },
    })
    await runKeepImport({
      file,
      vaultKey,
      mode: 'add',
      repo: repo(),
      pauseSync,
      resumeSync,
      onProgress: () => undefined,
    })

    expect(api.deleteNote).not.toHaveBeenCalled()
    expect(api.createLabel).toHaveBeenCalledOnce()
    expect(api.createNote.mock.calls[0]![0].labelIds).toEqual([
      expect.any(String),
      'work-id',
    ])
  })

  it('add uses (2) when the dated import label already exists', async () => {
    api.listLabels.mockResolvedValue([
      { id: 'work-id', ciphertext: 'work-cipher', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'import-id', ciphertext: 'import-cipher', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    const file = keepZip({
      'Takeout/Keep/Note.json': {
        title: 'Hello',
        textContent: 'World',
        isPinned: false,
      },
    })
    await runKeepImport({
      file,
      vaultKey,
      mode: 'add',
      repo: repo(),
      pauseSync,
      resumeSync,
      onProgress: () => undefined,
    })

    expect(api.createLabel).toHaveBeenCalledOnce()
    const createdId = (await api.createLabel.mock.results[0]!.value).id
    expect(api.createNote.mock.calls[0]![0].labelIds).toEqual([createdId])
  })
})
