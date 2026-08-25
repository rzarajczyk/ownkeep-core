import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_ROOT,
  BACKUP_VERSION,
  BackupFormatError,
  looksLikeOwnKeepBackup,
  packBackupZip,
  parseBackupEntries,
  type BackupArchive,
} from './format'

const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xdb])

function sampleArchive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
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
        backgroundColor: '#fff475',
        archived: false,
        pinned: true,
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
}

describe('ownkeep.backup format', () => {
  it('round-trips notes, labels, and attachment bytes', () => {
    const packed = packBackupZip(sampleArchive())
    const parsed = parseBackupEntries(unzipSync(packed))

    expect(parsed.manifest).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-08-25T10:00:00.000Z',
    })
    expect(parsed.labels).toEqual(sampleArchive().labels)
    expect(parsed.notes).toEqual(sampleArchive().notes)
    expect(parsed.attachmentBytes['att-1']).toEqual(photo)
    expect(Object.keys(unzipSync(packed))).toEqual(
      expect.arrayContaining([
        `${BACKUP_ROOT}/manifest.json`,
        `${BACKUP_ROOT}/labels.json`,
        `${BACKUP_ROOT}/notes/note-1.json`,
        `${BACKUP_ROOT}/attachments/att-1`,
      ]),
    )
  })

  it('rejects a zip without an OwnKeep manifest', () => {
    expect(() => parseBackupEntries({ 'Takeout/Keep/Note.json': new Uint8Array([0x7b, 0x7d]) })).toThrow(
      BackupFormatError,
    )
    expect(looksLikeOwnKeepBackup({ 'Takeout/Keep/Note.json': new Uint8Array([0x7b, 0x7d]) })).toBe(false)
    expect(looksLikeOwnKeepBackup(unzipSync(packBackupZip(sampleArchive())))).toBe(true)
  })

  it('rejects an unsupported format version', () => {
    const packed = packBackupZip(sampleArchive())
    const entries = unzipSync(packed)
    entries[`${BACKUP_ROOT}/manifest.json`] = new TextEncoder().encode(
      JSON.stringify({ format: BACKUP_FORMAT, version: 2, exportedAt: '2026-08-25T10:00:00.000Z' }),
    )
    try {
      parseBackupEntries(entries)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BackupFormatError)
      expect((error as BackupFormatError).code).toBe('unsupportedVersion')
      expect((error as BackupFormatError).version).toBe(2)
    }
  })
})
