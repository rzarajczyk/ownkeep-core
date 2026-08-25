import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { BackupDialog } from './BackupDialog'
import { LocalRepository } from './offline/repository'

const exportBackupZip = vi.hoisted(() => vi.fn())
const downloadNoteFile = vi.hoisted(() => vi.fn())

vi.mock('./backup/exportBackup', () => ({
  exportBackupZip,
}))

vi.mock('./export/download', () => ({
  downloadNoteFile,
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({ vaultKey: new Uint8Array(32) }),
}))

describe('BackupDialog', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.clearAllMocks()
    exportBackupZip.mockImplementation(async ({ onProgress }: { onProgress: (percent: number) => void }) => {
      onProgress(40)
      onProgress(100)
      return {
        blob: new Blob(['zip']),
        filename: 'ownkeep-backup-2026-08-25.zip',
        noteCount: 2,
        warnings: [],
      }
    })
  })

  it('warns that backup files are unencrypted and shows progress while exporting', async () => {
    const browser = userEvent.setup()
    const onCompleted = vi.fn()
    render(
      <BackupDialog repo={new LocalRepository(1)} onClose={vi.fn()} onCompleted={onCompleted} />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/unencrypted/i)
    await browser.click(screen.getByRole('button', { name: 'Download backup' }))

    expect(exportBackupZip).toHaveBeenCalledOnce()
    expect(downloadNoteFile).toHaveBeenCalledWith(
      'ownkeep-backup-2026-08-25.zip',
      expect.any(Blob),
    )
    expect(onCompleted).toHaveBeenCalledOnce()
    expect(screen.getByText(/Backup is ready/)).toBeVisible()
    expect(screen.getByText(/2 notes/)).toBeVisible()
  })
})
