import { beforeEach, describe, expect, it } from 'vitest'
import { bytesToBase64, randomBytes } from './crypto/aead'
import {
  encryptAttachmentMeta,
  encryptAttachmentThumbnail,
} from './crypto/attachmentCodec'
import { clearNoteKeyCache, fromWire, getCachedNoteKey, toWire } from './notesCipher'
import type { EncryptedNoteWire } from './types'

function asWire(
  noteId: string,
  write: Awaited<ReturnType<typeof toWire>>,
): EncryptedNoteWire {
  return {
    id: noteId,
    type: write.type,
    backgroundColor: write.backgroundColor ?? 'default',
    archived: write.archived ?? false,
    pinned: write.pinned ?? false,
    wrappedNoteKey: write.wrappedNoteKey!,
    ciphertext: write.ciphertext!,
    labelIds: write.labelIds ?? [],
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientUpdatedAt: write.clientUpdatedAt,
    clientMutationId: write.clientMutationId ?? null,
    version: write.version ?? 1,
  }
}

describe('notesCipher', () => {
  beforeEach(() => {
    clearNoteKeyCache()
  })

  it('round-trips a TEXT note with a vault key', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const write = await toWire(
      noteId,
      {
        type: 'TEXT',
        title: 'Hello',
        contentRaw: 'Body text',
        items: [],
        labelIds: [],
        backgroundColor: 'default',
        archived: false,
        pinned: true,
        version: 1,
      },
      vaultKey,
    )
    expect(write.ciphertext).toBeTruthy()
    expect(write.wrappedNoteKey).toBeTruthy()

    const note = await fromWire(asWire(noteId, write), vaultKey, new Map())
    expect(note.title).toBe('Hello')
    expect(note.contentRaw).toBe('Body text')
    expect(note.type).toBe('TEXT')
    expect(note.pinned).toBe(true)
  })

  it('round-trips a LIST note with checklist items', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const items = [
      {
        id: crypto.randomUUID(),
        text: 'Milk',
        checked: false,
        sortOrder: 0,
        indent: 0,
        textRendered: '',
      },
      {
        id: crypto.randomUUID(),
        text: 'Eggs',
        checked: true,
        sortOrder: 1,
        indent: 0,
        textRendered: '',
      },
    ]
    const write = await toWire(
      noteId,
      {
        type: 'LIST',
        title: 'Groceries',
        contentRaw: '',
        items,
        labelIds: [],
        backgroundColor: 'default',
        archived: false,
        pinned: false,
        version: 1,
      },
      vaultKey,
    )
    const note = await fromWire(asWire(noteId, write), vaultKey, new Map())
    expect(note.type).toBe('LIST')
    expect(note.title).toBe('Groceries')
    expect(note.items).toHaveLength(2)
    expect(note.items[0]?.text).toBe('Milk')
    expect(note.items[1]?.checked).toBe(true)
  })

  it('omits ciphertext for metadataOnly writes', async () => {
    const vaultKey = randomBytes(32)
    const write = await toWire(
      crypto.randomUUID(),
      {
        type: 'TEXT',
        title: 'Ignored',
        contentRaw: 'Ignored',
        items: [],
        labelIds: ['label-1'],
        backgroundColor: '#fff59d',
        archived: true,
        pinned: false,
        version: 4,
        metadataOnly: true,
      },
      vaultKey,
    )
    expect(write.ciphertext).toBeUndefined()
    expect(write.wrappedNoteKey).toBeUndefined()
    expect(write.archived).toBe(true)
    expect(write.backgroundColor).toBe('#fff59d')
    expect(write.labelIds).toEqual(['label-1'])
  })

  it('fails decrypt with the wrong vault key', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const write = await toWire(
      noteId,
      {
        type: 'TEXT',
        title: 'Secret',
        contentRaw: 'Hidden',
        items: [],
        labelIds: [],
        backgroundColor: 'default',
        archived: false,
        pinned: false,
        version: 1,
      },
      vaultKey,
    )
    clearNoteKeyCache()
    await expect(fromWire(asWire(noteId, write), randomBytes(32), new Map())).rejects.toThrow()
  })

  it('decrypts attachment thumbnails from a dedicated ciphertext field', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const write = await toWire(
      noteId,
      {
        type: 'TEXT',
        title: 'Photo',
        contentRaw: 'See attachment',
        items: [],
        labelIds: [],
        backgroundColor: 'default',
        archived: false,
        pinned: false,
        version: 1,
      },
      vaultKey,
    )
    const noteKey = getCachedNoteKey(noteId)
    expect(noteKey).toBeDefined()
    const attachmentId = crypto.randomUUID()
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
    const metaCiphertext = await encryptAttachmentMeta(noteKey!, attachmentId, {
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      kind: 'IMAGE',
    })
    const thumbnailCiphertext = bytesToBase64(
      await encryptAttachmentThumbnail(noteKey!, attachmentId, jpeg),
    )
    const note = await fromWire(
      {
        ...asWire(noteId, write),
        attachments: [
          {
            id: attachmentId,
            metaCiphertext,
            sizeBytes: 12,
            createdAt: '2026-01-01T00:00:00.000Z',
            url: `/attachments/${attachmentId}`,
            thumbnailCiphertext,
          },
        ],
      },
      vaultKey,
      new Map(),
    )
    expect(note.attachments).toHaveLength(1)
    expect(note.attachments[0]?.originalFilename).toBe('photo.jpg')
    expect(note.attachments[0]?.thumbnail?.mimeType).toBe('image/jpeg')
    expect(note.attachments[0]?.thumbnail && [...note.attachments[0].thumbnail.bytes]).toEqual([
      ...jpeg,
    ])
  })
})
