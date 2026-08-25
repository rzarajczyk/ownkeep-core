import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { BackupRestoreDialog } from './BackupRestoreDialog'
import { LocalRepository } from './offline/repository'

const runBackupImport = vi.hoisted(() => vi.fn())

vi.mock('./backup/runImport', () => ({
  runBackupImport,
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({ vaultKey: new Uint8Array(32) }),
}))

describe('BackupRestoreDialog', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.clearAllMocks()
    runBackupImport.mockResolvedValue({ imported: 1, skipped: 0, warnings: [] })
  })

  it('asks for an import mode before showing the file picker and warns that backups are unencrypted', async () => {
    const browser = userEvent.setup()
    render(
      <BackupRestoreDialog
        repo={new LocalRepository(1)}
        pauseSync={vi.fn()}
        resumeSync={vi.fn()}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    expect(screen.getByText(/Backup files are unencrypted/)).toBeVisible()
    expect(screen.getByRole('radio', { name: /Replace my vault/i })).toBeVisible()
    expect(screen.getByRole('radio', { name: /Add notes to the current vault/i })).toBeVisible()
    expect(screen.queryByLabelText('OwnKeep backup ZIP')).not.toBeInTheDocument()

    await browser.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByLabelText('OwnKeep backup ZIP')).toBeVisible()
    expect(screen.getByText(/Backup files are unencrypted/)).toBeVisible()
  })
})
