import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { UserSettingsDialog } from './UserSettingsDialog'
import { VaultProvider } from './vault/VaultContext'

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
      <VaultProvider user={{ id: 1, email: 'user@example.com' }}>
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

    expect(screen.getByText(/change your password/i)).toBeVisible()
    await browser.click(screen.getByRole('button', { name: 'Account' }))

    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeVisible()
    expect(screen.getByText(/disabled immediately/i)).toBeVisible()
    expect(screen.getByText(/kept for 60 days/i)).toBeVisible()
    expect(screen.getByText(/administrator can restore/i)).toBeVisible()
    expect(screen.getByText(/restore code to unlock your notes/i)).toBeVisible()
    expect(screen.getByText(/cannot be restored/i)).toBeVisible()
  })

  it('contains only user-account settings', () => {
    renderDialog()

    expect(screen.queryByRole('button', { name: 'Language' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Password' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Account' })).toBeVisible()
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
    await waitFor(() => expect(onAccountDeleted).toHaveBeenCalledOnce())
  })
})
