import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { randomBytes } from '../crypto/aead'
import { applyLanguagePreference } from '../i18n'
import { LocalRepository } from '../offline/repository'
import type { Note } from '../types'
import { exportBackupZip } from './exportBackup'
import { BACKUP_FORMAT, parseBackupEntries } from './format'

const api = vi.hoisted(() => ({
  listLabels: vi.fn(),
  notes: vi.fn(),
  attachmentCipherBlob: vi.fn(),
}))

const notesCipher = vi.hoisted(() => ({
  decryptLabels: vi.fn(),
  fromWire: vi.fn(),
  getCachedNoteKey: vi.fn(),
}))

vi.mock('../api', () => ({ api }))

vi.mock('../notesCipher', () => notesCipher)

vi.mock('../crypto/attachmentCodec', () => ({
  decryptAttachmentBytes: vi.fn(async (_key: Uint8Array, _id: string, bytes: Uint8Array) => bytes),
}))

function sampleNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    type: 'TEXT',
    title: 'Hello',
    contentRaw: 'World',
    contentRendered: '',
    backgroundColor: '#fff475',
    archived: false,
    pinned: true,
    labels: ['Work'],
    labelIds: ['label-work'],
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    clientUpdatedAt: '2026-01-03T00:00:00.000Z',
    version: 1,
    items: [],
    attachments: [
      {
        id: 'att-1',
        kind: 'IMAGE',
        originalFilename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 4,
        createdAt: '2026-01-02T00:00:00.000Z',
        url: '/attachments/att-1',
      },
    ],
    ...overrides,
  }
}

describe('exportBackupZip', () => {
  const vaultKey = randomBytes(32)

  beforeEach(() => {
    indexedDB = new IDBFactory()
    applyLanguagePreference('en')
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-25T12:00:00'))
    api.listLabels.mockResolvedValue([
      { id: 'label-work', ciphertext: 'work-cipher', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    api.notes.mockResolvedValue({
      items: [
        {
          id: 'note-1',
          type: 'TEXT',
          backgroundColor: '#fff475',
          archived: false,
          pinned: true,
          wrappedNoteKey: 'wrap',
          ciphertext: 'cipher',
          labelIds: ['label-work'],
          attachments: [],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          version: 1,
        },
      ],
      deletedIds: [],
      nextUpdatedAfter: null,
      nextAfterId: null,
      hasMore: false,
    })
    notesCipher.decryptLabels.mockResolvedValue(new Map([['label-work', 'Work']]))
    notesCipher.fromWire.mockImplementation(async (wire: { id: string }) =>
      sampleNote({ id: wire.id }),
    )
    notesCipher.getCachedNoteKey.mockReturnValue(new Uint8Array(32))
    api.attachmentCipherBlob.mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds an ownkeep.backup zip from local notes and labels', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    await repo.putSyncedNotes(
      [
        {
          id: 'note-1',
          type: 'TEXT',
          backgroundColor: '#fff475',
          archived: false,
          pinned: true,
          wrappedNoteKey: 'wrap',
          ciphertext: 'cipher',
          labelIds: ['label-work'],
          attachments: [],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          version: 1,
        },
      ],
      [],
    )
    const percents: number[] = []
    const result = await exportBackupZip({
      vaultKey,
      repo,
      onProgress: (percent) => percents.push(percent),
    })

    expect(result.filename).toBe('ownkeep-backup-2026-08-25.zip')
    expect(result.noteCount).toBe(1)
    expect(result.warnings).toEqual([])
    expect(percents.at(-1)).toBe(100)
    const parsed = parseBackupEntries(unzipSync(new Uint8Array(await result.blob.arrayBuffer())))
    expect(parsed.manifest.format).toBe(BACKUP_FORMAT)
    expect(parsed.labels).toEqual([
      { id: 'label-work', name: 'Work', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(parsed.notes[0]).toEqual(
      expect.objectContaining({
        id: 'note-1',
        title: 'Hello',
        contentRaw: 'World',
        pinned: true,
        labelIds: ['label-work'],
      }),
    )
    expect(parsed.attachmentBytes['att-1']).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('fetches every server page and overlays pending local changes', async () => {
    const repo = new LocalRepository(crypto.getRandomValues(new Uint32Array(1))[0]!)
    const pending = {
      id: 'note-1',
      type: 'TEXT' as const,
      backgroundColor: '#fff475',
      archived: false,
      pinned: true,
      wrappedNoteKey: 'local-wrap',
      ciphertext: 'pending-cipher',
      labelIds: ['label-work'],
      attachments: [],
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      version: 1,
    }
    await repo.upsertLocalNote(pending, pending)
    api.notes
      .mockResolvedValueOnce({
        items: [{ ...pending, ciphertext: 'server-cipher' }],
        deletedIds: [],
        nextUpdatedAfter: '2026-01-03T00:00:00.000Z',
        nextAfterId: 'note-1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ ...pending, id: 'note-2', ciphertext: 'second-page-cipher' }],
        deletedIds: [],
        nextUpdatedAfter: null,
        nextAfterId: null,
        hasMore: false,
      })

    const result = await exportBackupZip({ vaultKey, repo, onProgress: () => undefined })

    expect(result.noteCount).toBe(2)
    expect(api.notes).toHaveBeenNthCalledWith(2, {
      limit: 100,
      updatedAfter: '2026-01-03T00:00:00.000Z',
      afterId: 'note-1',
    })
    expect(notesCipher.fromWire).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'note-1', ciphertext: 'pending-cipher' }),
      vaultKey,
      expect.any(Map),
    )
  })
})
