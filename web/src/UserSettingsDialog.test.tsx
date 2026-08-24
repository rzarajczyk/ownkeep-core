import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { UserSettingsDialog } from './UserSettingsDialog'
import { VaultProvider } from './vault/VaultContext'
import { readLockBehavior } from './vault/vaultPersist'

const api = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
}))

vi.mock('./api', () => ({ api }))

describe('UserSettingsDialog account deletion', () => {
  const onAccountDeleted = vi.fn()

  beforeEach(() => {
    applyLanguagePreference('en')
    indexedDB = new IDBFactory()
    localStorage.clear()
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.clearAllMocks()
    api.deleteAccount.mockResolvedValue(undefined)
  })

  function renderDialog() {
    return render(
      <VaultProvider userId={1}>
        <UserSettingsDialog
          onClose={vi.fn()}
          onPasswordChanged={vi.fn()}
          onAccountDeleted={onAccountDeleted}
        />
      </VaultProvider>,
    )
  }

  it('switches to the account section and explains the retention period', async () => {
    const browser = userEvent.setup()
    renderDialog()

    expect(screen.getByRole('radio', { name: /lock the vault on page reload/i })).toBeVisible()
    await browser.click(screen.getByRole('button', { name: 'Account' }))

    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeVisible()
    expect(screen.getByText(/disabled immediately/i)).toBeVisible()
    expect(screen.getByText(/kept for 60 days/i)).toBeVisible()
    expect(screen.getByText(/administrator can restore/i)).toBeVisible()
    expect(screen.getByText(/restore code to unlock your notes/i)).toBeVisible()
    expect(screen.getByText(/cannot be restored/i)).toBeVisible()
  })

  it('lets the user choose Polish from the language section', async () => {
    const browser = userEvent.setup()
    renderDialog()

    await browser.click(screen.getByRole('button', { name: 'Language' }))
    expect(screen.getByText(/choose the app language/i)).toBeVisible()
    await browser.selectOptions(screen.getByLabelText('Language'), 'pl')
    expect(screen.getByRole('heading', { name: 'Ustawienia konta' })).toBeVisible()
    expect(screen.getByLabelText('Język')).toHaveValue('pl')
  })

  it('requires a password before deleting the account', async () => {
    const browser = userEvent.setup()
    renderDialog()
    await browser.click(screen.getByRole('button', { name: 'Account' }))

    await browser.click(screen.getByRole('button', { name: 'Delete account' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password to delete your account.')
    expect(api.deleteAccount).not.toHaveBeenCalled()
  })

  it('deletes the account after confirmation and ends the session', async () => {
    const browser = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDialog()
    await browser.click(screen.getByRole('button', { name: 'Account' }))
    await browser.type(screen.getByLabelText('Password'), 'correct-password')

    await browser.click(screen.getByRole('button', { name: 'Delete account' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/restore code to unlock your notes/i))
    await waitFor(() => expect(api.deleteAccount).toHaveBeenCalledWith('correct-password'))
    expect(onAccountDeleted).toHaveBeenCalledOnce()
  })
})

describe('UserSettingsDialog vault lock', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    indexedDB = new IDBFactory()
    localStorage.clear()
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
  })

  function renderDialog() {
    return render(
      <VaultProvider userId={1}>
        <UserSettingsDialog
          onClose={vi.fn()}
          onPasswordChanged={vi.fn()}
          onAccountDeleted={vi.fn()}
        />
      </VaultProvider>,
    )
  }

  it('defaults to lock on reload and hides until-logout threats', () => {
    renderDialog()

    expect(screen.getByRole('radio', { name: /lock the vault on page reload/i })).toBeChecked()
    expect(
      screen.getByRole('radio', { name: /keep the vault unlocked until i log out/i }),
    ).not.toBeChecked()
    expect(screen.queryByText('Security threats')).not.toBeInTheDocument()
  })

  it('saves until-logout as a per-user preference and shows the threats', async () => {
    const browser = userEvent.setup()
    renderDialog()

    await browser.click(screen.getByRole('radio', { name: /keep the vault unlocked until i log out/i }))

    await waitFor(() => expect(readLockBehavior(1)).toBe('until-logout'))
    expect(screen.getByRole('radio', { name: /keep the vault unlocked until i log out/i })).toBeChecked()
    expect(screen.getByText('Security threats')).toBeVisible()
    expect(screen.getByText(/physical access/i)).toBeVisible()
    expect(screen.getByText(/page attacks \(xss\)/i)).toBeVisible()
    expect(screen.getByText(/browser extensions/i)).toBeVisible()
    expect(screen.getByText(/malware and disk access/i)).toBeVisible()
    expect(screen.getByText(/shared and public computers/i)).toBeVisible()
    expect(screen.getByText(/closing the tab is not enough/i)).toBeVisible()
  })

  it('keeps password change on its own tab', async () => {
    const browser = userEvent.setup()
    renderDialog()

    expect(screen.queryByText(/change your password/i)).not.toBeInTheDocument()
    await browser.click(screen.getByRole('button', { name: 'Password' }))
    expect(screen.getByText(/change your password/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Update password' })).toBeVisible()
  })
})
