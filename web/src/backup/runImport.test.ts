import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from '../crypto/aead'
import { applyLanguagePreference } from '../i18n'
import { LocalRepository } from '../offline/repository'
import { BACKUP_FORMAT, BACKUP_VERSION, packBackupZip, type BackupArchive } from './format'
import { importBackupZip } from './importBackup'
import { runBackupImport } from './runImport'
import { MAX_ZIP_BYTES } from './limits'

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
        if (wire.id === 'import-id') map.set(wire.id, 'Backup import 2026-08-25')
      }
      return map
    }),
  }
})

const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xdb])

function backupFile(overrides?: Partial<BackupArchive>): File {
  const archive: BackupArchive = {
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-08-25T10:00:00.000Z',
    },
    labels: [{ id: 'label-work', name: 'Work', createdAt: '2026-01-01T00:00:00.000Z' }],
    notes: [
      {
        id: 'note-1',
        type: 'TEXT',
        title: 'Hello',
        contentRaw: 'World',
        backgroundColor: '#ffffff',
        archived: false,
        pinned: false,
        createdAt: '2026-01-02T00:00:00.000Z',
        clientUpdatedAt: '2026-01-03T00:00:00.000Z',
        labelIds: ['label-work'],
        items: [],
        attachments: [
          {
            id: 'att-1',
            originalFilename: 'photo.jpg',
            mimeType: 'image/jpeg',
            kind: 'IMAGE',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    ],
    attachmentBytes: { 'att-1': photo },
    ...overrides,
  }
  const bytes = packBackupZip(archive)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new File([copy], 'ownkeep-backup.zip', { type: 'application/zip' })
}

describe('importBackupZip', () => {
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
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      clientUpdatedAt: payload.clientUpdatedAt,
      clientMutationId: payload.clientMutationId ?? null,
      version: 1,
    }))
    api.uploadAttachment.mockResolvedValue({
      id: 'att',
      metaCiphertext: 'meta',
      sizeBytes: 4,
      createdAt: '2026-08-25T00:00:00.000Z',
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
          createdAt: '2026-08-25T00:00:00.000Z',
          url: '/attachments/att',
        },
      ],
      version: 2,
    }))
  })

  it('imports notes, labels, and attachments from an OwnKeep backup', async () => {
    const repo = new LocalRepository(1)
    const result = await importBackupZip({
      file: backupFile(),
      vaultKey,
      repo,
      existingLabels: new Map(),
      onProgress: () => undefined,
    })
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect(api.createLabel).toHaveBeenCalledOnce()
    expect(api.createNote).toHaveBeenCalledOnce()
    expect(api.createNote.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        type: 'TEXT',
        clientUpdatedAt: '2026-01-03T00:00:00.000Z',
      }),
    )
    expect(api.uploadAttachment).toHaveBeenCalledOnce()
  })

  it('rejects a Takeout zip', async () => {
    const encoded = zipSync({
      'Takeout/Keep/Note.json': new TextEncoder().encode(
        JSON.stringify({ title: 'Hello', textContent: 'World', isPinned: false }),
      ),
    })
    const file = new File([encoded], 'keep.zip', { type: 'application/zip' })
    const repo = new LocalRepository(1)
    await expect(
      importBackupZip({
        file,
        vaultKey,
        repo,
        existingLabels: new Map(),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/not an OwnKeep backup/)
  })

  it('refuses a ZIP larger than the backup limit', async () => {
    const file = new File(['x'], 'backup.zip', { type: 'application/zip' })
    Object.defineProperty(file, 'size', { value: MAX_ZIP_BYTES + 1 })
    await expect(
      importBackupZip({
        file,
        vaultKey,
        repo: new LocalRepository(1),
        existingLabels: new Map(),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/200 MiB/)
  })
})

describe('runBackupImport', () => {
  const vaultKey = randomBytes(32)
  const pauseSync = vi.fn()
  const resumeSync = vi.fn()

  beforeEach(() => {
    applyLanguagePreference('en')
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-25T12:00:00'))
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
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      clientUpdatedAt: payload.clientUpdatedAt,
      clientMutationId: payload.clientMutationId ?? null,
      version: 1,
    }))
    api.uploadAttachment.mockResolvedValue({
      id: 'att',
      metaCiphertext: 'meta',
      sizeBytes: 4,
      createdAt: '2026-08-25T00:00:00.000Z',
      url: '/attachments/att',
    })
    api.note.mockImplementation(async (id: string) => ({
      ...(await api.createNote.mock.results.at(-1)?.value),
      id,
      attachments: [],
      version: 2,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replace wipes existing notes and does not create a batch label', async () => {
    await runBackupImport({
      file: backupFile(),
      vaultKey,
      mode: 'replace',
      repo: new LocalRepository(1),
      pauseSync,
      resumeSync,
      onProgress: () => undefined,
    })
    expect(api.deleteNote).toHaveBeenCalledWith('old-note')
    expect(api.deleteLabel).toHaveBeenCalledWith('work-id')
    expect(api.createNote.mock.calls[0]![0].labelIds).toHaveLength(1)
  })

  it('add reuses Work and attaches Backup import 2026-08-25', async () => {
    await runBackupImport({
      file: backupFile(),
      vaultKey,
      mode: 'add',
      repo: new LocalRepository(1),
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
})
