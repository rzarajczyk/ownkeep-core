import { describe, expect, it } from 'vitest'
import { decryptAesGcm, encryptAesGcm, randomBytes } from './aead'
import { decryptLabelName, encryptLabelName } from './labelCodec'
import {
  buildNotePayload,
  decryptNotePayload,
  encryptNotePayload,
  unwrapNoteKey,
  wrapNoteKey,
} from './noteCodec'
import {
  REVISION_LABEL_MAX_LENGTH,
  buildRevisionPayload,
  decryptRevisionLabel,
  decryptRevisionPayload,
  encryptRevisionLabel,
  encryptRevisionPayload,
} from './revisionCodec'
import { initializeVault, unlockVaultWithPassword, unlockVaultWithRecovery } from './vault'

describe('crypto', () => {
  it('round-trips AES-GCM', async () => {
    const key = randomBytes(32)
    const plain = new TextEncoder().encode('hello vault')
    const blob = await encryptAesGcm(key, plain, 'ok.test')
    const out = await decryptAesGcm(key, blob, 'ok.test')
    expect(new TextDecoder().decode(out)).toBe('hello vault')
  })

  it('initializes and unlocks a vault with password and recovery', async () => {
    const init = await initializeVault('correct horse battery')
    const unlocked = await unlockVaultWithPassword('correct horse battery', {
      kdfSalt: init.kdfSalt,
      kdfParams: init.kdfParams,
      wrappedVaultKey: init.wrappedVaultKey,
      wrappedVaultKeyRecovery: init.wrappedVaultKeyRecovery,
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    })
    expect(unlocked).toEqual(init.vaultKey)
    const viaRecovery = await unlockVaultWithRecovery(init.recoveryKeyBase64, {
      kdfSalt: init.kdfSalt,
      kdfParams: init.kdfParams,
      wrappedVaultKey: null,
      wrappedVaultKeyRecovery: init.wrappedVaultKeyRecovery,
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: true,
    })
    expect(viaRecovery).toEqual(init.vaultKey)
  })

  it('encrypts notes and labels under the vault hierarchy', async () => {
    const vaultKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const noteKey = randomBytes(32)
    const wrapped = await wrapNoteKey(vaultKey, noteId, noteKey)
    const unwrapped = await unwrapNoteKey(vaultKey, noteId, wrapped)
    expect(unwrapped).toEqual(noteKey)
    const payload = buildNotePayload({
      title: 'Hi',
      contentRaw: 'Body',
      items: [],
      labelIds: [],
      type: 'TEXT',
    })
    const cipher = await encryptNotePayload(noteId, noteKey, payload)
    const decrypted = await decryptNotePayload(noteId, noteKey, cipher)
    expect(decrypted.title).toBe('Hi')
    const labelCipher = await encryptLabelName(vaultKey, 'Work')
    expect(await decryptLabelName(vaultKey, labelCipher)).toBe('Work')
  })

  it('encrypts revision snapshots and labels with revision-scoped AAD', async () => {
    const vaultKey = randomBytes(32)
    const noteKey = randomBytes(32)
    const noteId = crypto.randomUUID()
    const revisionId = crypto.randomUUID()
    const payload = buildRevisionPayload({
      title: 'Draft',
      contentRaw: 'Body',
      items: [],
      type: 'TEXT',
      backgroundColor: 'default',
      archived: false,
      pinned: true,
      labelIds: [crypto.randomUUID()],
      attachments: [
        {
          id: crypto.randomUUID(),
          originalFilename: 'photo.png',
          mimeType: 'image/png',
          kind: 'IMAGE',
          sizeBytes: 128,
        },
      ],
    })
    const cipher = await encryptRevisionPayload(noteId, revisionId, noteKey, payload)
    const decrypted = await decryptRevisionPayload(noteId, revisionId, noteKey, cipher)
    expect(decrypted.title).toBe('Draft')
    expect(decrypted.attachments[0]?.originalFilename).toBe('photo.png')

    await expect(decryptRevisionPayload(noteId, crypto.randomUUID(), noteKey, cipher)).rejects.toThrow()
    await expect(decryptRevisionPayload(crypto.randomUUID(), revisionId, noteKey, cipher)).rejects.toThrow()

    const labelCipher = await encryptRevisionLabel(vaultKey, noteId, revisionId, 'Before cleanup')
    expect(await decryptRevisionLabel(vaultKey, noteId, revisionId, labelCipher)).toBe('Before cleanup')
    await expect(
      decryptRevisionLabel(vaultKey, noteId, crypto.randomUUID(), labelCipher),
    ).rejects.toThrow()
    await expect(
      encryptRevisionLabel(vaultKey, noteId, revisionId, 'x'.repeat(REVISION_LABEL_MAX_LENGTH + 1)),
    ).rejects.toThrow(/at most/)
  })
})
