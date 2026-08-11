import { describe, expect, it } from 'vitest'
import { randomBytes } from '../crypto/aead'
import { generateNoteKey } from '../crypto/keys'
import {
  buildNotePayload,
  encryptNotePayload,
  unwrapNoteKey,
  wrapNoteKey,
} from '../crypto/noteCodec'
import { decryptRevisionPayload } from '../crypto/revisionCodec'
import type { EncryptedNoteWire, EncryptedNoteWrite } from '../types'
import { buildConflictRevisionSnapshots } from './conflictSnapshots'

async function encryptWrite(
  vaultKey: Uint8Array,
  noteId: string,
  title: string,
  contentRaw: string,
): Promise<{ write: EncryptedNoteWrite; noteKey: Uint8Array }> {
  const noteKey = generateNoteKey()
  const ciphertext = await encryptNotePayload(
    noteId,
    noteKey,
    buildNotePayload({
      title,
      contentRaw,
      items: [],
      labelIds: [],
      type: 'TEXT',
    }),
  )
  return {
    noteKey,
    write: {
      id: noteId,
      type: 'TEXT',
      backgroundColor: 'default',
      archived: false,
      pinned: false,
      version: 3,
      wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
      ciphertext,
      labelIds: [],
      clientUpdatedAt: '2026-01-01T00:02:00.000Z',
      clientMutationId: 'local-mutation',
    },
  }
}

async function encryptRemote(
  vaultKey: Uint8Array,
  noteId: string,
  title: string,
  contentRaw: string,
): Promise<{ wire: EncryptedNoteWire; noteKey: Uint8Array }> {
  const noteKey = generateNoteKey()
  const ciphertext = await encryptNotePayload(
    noteId,
    noteKey,
    buildNotePayload({
      title,
      contentRaw,
      items: [],
      labelIds: [],
      type: 'TEXT',
    }),
  )
  return {
    noteKey,
    wire: {
      id: noteId,
      type: 'TEXT',
      backgroundColor: 'default',
      archived: false,
      pinned: false,
      wrappedNoteKey: await wrapNoteKey(vaultKey, noteId, noteKey),
      ciphertext,
      labelIds: [],
      attachments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      clientUpdatedAt: '2026-01-01T00:01:00.000Z',
      clientMutationId: 'remote-mutation',
      version: 4,
    },
  }
}

describe('buildConflictRevisionSnapshots', () => {
  it('builds decryptable local and remote revision snapshots', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const localRevisionId = crypto.randomUUID()
    const remoteRevisionId = crypto.randomUUID()
    const { write: local } = await encryptWrite(vaultKey, noteId, 'Local title', 'Local body')
    const { wire: remote } = await encryptRemote(vaultKey, noteId, 'Remote title', 'Remote body')

    const snapshots = await buildConflictRevisionSnapshots(
      noteId,
      vaultKey,
      local,
      remote,
      localRevisionId,
      remoteRevisionId,
    )

    const localKey = await unwrapNoteKey(vaultKey, noteId, local.wrappedNoteKey!)
    const remoteKey = await unwrapNoteKey(vaultKey, noteId, remote.wrappedNoteKey)
    const localPlain = await decryptRevisionPayload(
      noteId,
      localRevisionId,
      localKey,
      snapshots.localSnapshotCiphertext,
    )
    const remotePlain = await decryptRevisionPayload(
      noteId,
      remoteRevisionId,
      remoteKey,
      snapshots.remoteSnapshotCiphertext,
    )

    expect(localPlain.title).toBe('Local title')
    expect(localPlain.contentRaw).toBe('Local body')
    expect(remotePlain.title).toBe('Remote title')
    expect(remotePlain.contentRaw).toBe('Remote body')
  })

  it('throws when local write is missing ciphertext', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const { wire: remote } = await encryptRemote(vaultKey, noteId, 'Remote', 'Body')
    await expect(
      buildConflictRevisionSnapshots(
        noteId,
        vaultKey,
        {
          type: 'TEXT',
          version: 1,
          wrappedNoteKey: 'wrap',
        },
        remote,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/missing ciphertext/i)
  })
})
