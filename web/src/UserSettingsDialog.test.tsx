import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from './i18n'
import { UserSettingsDialog } from './UserSettingsDialog'

const api = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
}))

vi.mock('./api', () => ({ api }))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => ({ rewrapForNewPassword: vi.fn() }),
}))

describe('UserSettingsDialog account deletion', () => {
  const onAccountDeleted = vi.fn()

  beforeEach(() => {
    applyLanguagePreference('en')
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
      <UserSettingsDialog
        onClose={vi.fn()}
        onPasswordChanged={vi.fn()}
        onAccountDeleted={onAccountDeleted}
      />,
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

  it('lets the user choose Polish from the language section', async () => {
    const browser = userEvent.setup()
    renderDialog()

    await browser.click(screen.getByRole('button', { name: 'Language' }))
    expect(screen.getByText(/choose the app language/i)).toBeVisible()
    await browser.selectOptions(screen.getByLabelText('Language'), 'pl')
    expect(screen.getByRole('heading', { name: 'Ustawienia użytkownika' })).toBeVisible()
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
