import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { KeepImportDialog } from './KeepImportDialog'
import { LocalRepository } from './offline/repository'

const runKeepImport = vi.hoisted(() => vi.fn())

vi.mock('./keepImport/runImport', () => ({
  runKeepImport,
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({ vaultKey: new Uint8Array(32) }),
}))

describe('KeepImportDialog', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.clearAllMocks()
    runKeepImport.mockResolvedValue({ imported: 1, skipped: 0, warnings: [] })
  })

  it('asks for an import mode before showing the file picker', async () => {
    const browser = userEvent.setup()
    render(
      <KeepImportDialog
        repo={new LocalRepository(1)}
        pauseSync={vi.fn()}
        resumeSync={vi.fn()}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    )

    expect(screen.getByRole('radio', { name: /Replace my vault/i })).toBeVisible()
    expect(screen.getByRole('radio', { name: /Add notes to the current vault/i })).toBeVisible()
    expect(screen.queryByLabelText('Google Keep Takeout ZIP')).not.toBeInTheDocument()

    await browser.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByLabelText('Google Keep Takeout ZIP')).toBeVisible()
  })
})
