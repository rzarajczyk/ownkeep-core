import { zipSync, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '../crypto/aead'
import { applyLanguagePreference } from '../i18n'
import { LocalRepository } from '../offline/repository'
import { importKeepZip } from './clientImport'
import { MAX_UNCOMPRESSED_BYTES, MAX_ZIP_BYTES } from './limits'

const api = vi.hoisted(() => ({
  createLabel: vi.fn(),
  createNote: vi.fn(),
  uploadAttachment: vi.fn(),
  note: vi.fn(),
}))

vi.mock('../api', () => ({ api }))

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>()
  return {
    ...actual,
    unzipSync: vi.fn((data: Uint8Array, opts?: Parameters<typeof actual.unzipSync>[1]) =>
      actual.unzipSync(data, opts),
    ),
  }
})

function keepZip(entries: Record<string, unknown>): File {
  const encoded: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(entries)) {
    encoded[path] =
      value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
  }
  const bytes = zipSync(encoded)
  return new File([bytes], 'keep.zip', { type: 'application/zip' })
}

describe('importKeepZip', () => {
  const vaultKey = randomBytes(32)

  beforeEach(() => {
    applyLanguagePreference('en')
    vi.clearAllMocks()
    api.createLabel.mockImplementation(async () => ({
      id: crypto.randomUUID(),
      ciphertext: 'label-cipher',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    api.createNote.mockImplementation(async (payload) => ({
      id: payload.id,
      type: payload.type,
      backgroundColor: payload.backgroundColor ?? '#ffffff',
      archived: payload.archived ?? false,
      pinned: payload.pinned ?? false,
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
    api.uploadAttachment.mockResolvedValue({
      id: 'att',
      metaCiphertext: 'meta',
      sizeBytes: 4,
      createdAt: '2026-08-24T00:00:00.000Z',
      url: '/attachments/att',
    })
    api.note.mockImplementation(async (id: string) => ({
      ...(await api.createNote.mock.results.at(-1)?.value),
      id,
      attachments: [
        {
          id: 'att',
          metaCiphertext: 'meta',
          sizeBytes: 4,
          createdAt: '2026-08-24T00:00:00.000Z',
          url: '/attachments/att',
        },
      ],
      version: 2,
    }))
  })

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('fflate')>('fflate')
    vi.mocked(unzipSync).mockImplementation((data, opts) => actual.unzipSync(data, opts))
  })

  async function importFile(
    file: File,
    extras?: { existingLabels?: Map<string, string>; extraLabelNames?: string[] },
  ) {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const result = await importKeepZip({
      file,
      vaultKey,
      repo,
      existingLabels: extras?.existingLabels ?? new Map(),
      extraLabelNames: extras?.extraLabelNames,
      onProgress: () => undefined,
    })
    return { result, repo }
  }

  it('imports a Keep JSON note and creates labels', async () => {
    const file = keepZip({
      'Takeout/Keep/Shopping.json': {
        title: 'Shopping',
        textContent: 'Buy milk',
        labels: [{ name: 'Errands' }],
        isPinned: false,
        color: 'DEFAULT',
        userEditedTimestampUsec: 1_700_000_000_000_000,
      },
    })
    const { result, repo } = await importFile(file)

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect(api.createLabel).toHaveBeenCalledOnce()
    expect(api.createNote).toHaveBeenCalledOnce()
    expect(api.createNote.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        type: 'TEXT',
        backgroundColor: '#ffffff',
        wrappedNoteKey: expect.any(String),
        ciphertext: expect.any(String),
        clientUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      }),
    )
    expect(await repo.listNotes()).toHaveLength(1)
  })

  it('reuses an existing label and attaches a batch import label', async () => {
    const file = keepZip({
      'Takeout/Keep/Shopping.json': {
        title: 'Shopping',
        textContent: 'Buy milk',
        labels: [{ name: 'Work' }],
        isPinned: false,
      },
    })
    const { result } = await importFile(file, {
      existingLabels: new Map([['work', 'work-id']]),
      extraLabelNames: ['Google Keep import 2026-08-24'],
    })

    expect(result.imported).toBe(1)
    expect(api.createLabel).toHaveBeenCalledOnce()
    expect(api.createNote.mock.calls[0]![0].labelIds).toEqual([
      expect.any(String),
      'work-id',
    ])
    const batchId = await api.createLabel.mock.results[0]!.value
    expect(api.createNote.mock.calls[0]![0].labelIds[0]).toBe(batchId.id)
  })

  it('skips empty Keep notes', async () => {
    const file = keepZip({
      'Takeout/Keep/Empty.json': {
        title: '',
        textContent: '',
        isPinned: false,
      },
    })
    const { result } = await importFile(file)

    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(api.createNote).not.toHaveBeenCalled()
  })

  it('skips trashed notes and imports attachment-only notes', async () => {
    const file = keepZip({
      'Takeout/Keep/Trash.json': {
        title: 'Gone',
        textContent: 'secret',
        isTrashed: true,
      },
      'Takeout/Keep/Photo.json': {
        title: '',
        attachments: [{ filePath: 'photo.jpg' }],
        isPinned: false,
      },
      'Takeout/Keep/photo.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
    })
    const { result } = await importFile(file)

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(api.createNote).toHaveBeenCalledOnce()
    expect(api.uploadAttachment).toHaveBeenCalledOnce()
    expect(api.note).toHaveBeenCalledOnce()
  })

  it('maps Keep RED to the OwnKeep red swatch', async () => {
    const file = keepZip({
      'Takeout/Keep/Red.json': {
        title: 'Red',
        textContent: 'hi',
        color: 'RED',
        isPinned: false,
      },
    })
    await importFile(file)
    expect(api.createNote.mock.calls[0]![0].backgroundColor).toBe('#f28b82')
  })

  it('flattens nested checklist items with indent', async () => {
    const file = keepZip({
      'Takeout/Keep/List.json': {
        title: 'List',
        listContent: [
          { text: 'Parent', isChecked: false, childListItems: [{ text: 'Child', isChecked: true }] },
        ],
        isPinned: false,
      },
    })
    await importFile(file)
    expect(api.createNote.mock.calls[0]![0].type).toBe('LIST')
  })

  it('refuses a ZIP larger than 25 MiB without unzipping', async () => {
    const file = new File(['x'], 'keep.zip', { type: 'application/zip' })
    Object.defineProperty(file, 'size', { value: MAX_ZIP_BYTES + 1 })
    const repo = new LocalRepository(1)
    await expect(
      importKeepZip({
        file,
        vaultKey,
        repo,
        existingLabels: new Map(),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/25 MiB/)
    expect(unzipSync).not.toHaveBeenCalled()
  })

  it('aborts when uncompressed size exceeds 100 MiB', async () => {
    vi.mocked(unzipSync).mockImplementation((_data, opts) => {
      opts?.filter?.({
        name: 'Takeout/Keep/huge.bin',
        size: 10,
        originalSize: MAX_UNCOMPRESSED_BYTES + 1,
        compression: 0,
      })
      return {}
    })
    const file = keepZip({
      'Takeout/Keep/Note.json': { title: 'x', textContent: 'y', isPinned: false },
    })
    const repo = new LocalRepository(1)
    await expect(
      importKeepZip({
        file,
        vaultKey,
        repo,
        existingLabels: new Map(),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/100 MiB/)
  })
})
