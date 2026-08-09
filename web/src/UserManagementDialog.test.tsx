import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedUser, User, VaultInfo } from './types'
import { UserManagementDialog } from './UserManagementDialog'

const api = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  listUsers: vi.fn(),
  permanentlyDeleteUser: vi.fn(),
  resendUserVerification: vi.fn(),
  resendVerification: vi.fn(),
  resetUserPassword: vi.fn(),
  restoreUser: vi.fn(),
}))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { api, ApiError: actual.ApiError }
})

const vault: VaultInfo = {
  kdfSalt: 'salt',
  kdfParams: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
  wrappedVaultKey: 'wrap',
  wrappedVaultKeyRecovery: 'recovery-wrap',
  hasRecoveryKey: true,
  initialized: true,
  needsRecoveryUnlock: false,
}
const currentUser: User = { id: 1, email: 'admin@example.com', role: 'ADMIN', vault }
const managedUsers: ManagedUser[] = [
  {
    id: 3,
    email: 'deleted@example.com',
    role: 'USER',
    enabled: false,
    emailVerified: true,
    recoveryPending: false,
    canRestore: true,
    deletedAt: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 4,
    email: 'lost-key@example.com',
    role: 'USER',
    enabled: false,
    emailVerified: true,
    recoveryPending: false,
    canRestore: false,
    deletedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 2,
    email: 'active@example.com',
    role: 'USER',
    enabled: true,
    emailVerified: true,
    recoveryPending: false,
    canRestore: true,
  },
  {
    id: 5,
    email: 'pending@example.com',
    role: 'USER',
    enabled: true,
    emailVerified: false,
    recoveryPending: false,
    canRestore: true,
  },
  {
    id: 1,
    email: 'admin@example.com',
    role: 'ADMIN',
    enabled: true,
    emailVerified: true,
    recoveryPending: false,
    canRestore: true,
  },
]

function renderDialog() {
  return render(<UserManagementDialog currentUser={currentUser} onClose={vi.fn()} />)
}

describe('UserManagementDialog deleted users', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    vi.clearAllMocks()
    api.listUsers.mockResolvedValue(managedUsers)
    api.deleteUser.mockImplementation(async (id: number) => {
      const user = managedUsers.find((entry) => entry.id === id)!
      return {
        ...user,
        enabled: false,
        recoveryPending: false,
        canRestore: user.id === 2,
      }
    })
    api.permanentlyDeleteUser.mockResolvedValue(undefined)
    api.resendUserVerification.mockResolvedValue(undefined)
  })

  it('groups deleted users after active users and explains unavailable restore', async () => {
    renderDialog()

    const activeList = await screen.findByRole('list', { name: 'Active users' })
    const deletedHeading = screen.getByRole('heading', { name: 'Deleted users' })
    expect(
      activeList.compareDocumentPosition(deletedHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    const unavailable = screen.getByRole('button', { name: 'Restore', description: /no recovery key/i })
    expect(unavailable).toBeDisabled()
    expect(screen.getByText(/restore unavailable: this account has no recovery key/i)).toBeVisible()
  })

  it('treats legacy summaries without enabled metadata as active', async () => {
    api.listUsers.mockResolvedValueOnce([
      { id: 1, email: 'admin@example.com', role: 'ADMIN' } as ManagedUser,
    ])

    renderDialog()

    const activeList = await screen.findByRole('list', { name: 'Active users' })
    expect(within(activeList).getByText('admin@example.com')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Deleted users' })).not.toBeInTheDocument()
  })

  it('moves a soft-deleted account into the deleted group instead of removing it', async () => {
    const browser = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDialog()
    await screen.findByText('active@example.com')

    await browser.click(screen.getByRole('button', { name: 'Delete active@example.com' }))

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/disabled immediately[\s\S]*restore code[\s\S]*60 days[\s\S]*cannot be restored/i),
    )
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith(2))
    const deletedGroup = screen.getByRole('heading', { name: 'Deleted users' }).closest('section')
    expect(within(deletedGroup!).getByText('active@example.com')).toBeInTheDocument()
    expect(screen.getByText(/active@example.com was moved to deleted users/i)).toBeVisible()
  })

  it('restores an account, marks recovery pending, and reveals the temporary password', async () => {
    const browser = userEvent.setup()
    const restored: ManagedUser = {
      ...managedUsers[0],
      enabled: true,
      recoveryPending: true,
    }
    api.restoreUser.mockResolvedValue({
      user: restored,
      temporaryPassword: 'one-time-code',
    })
    renderDialog()
    await screen.findByText('deleted@example.com')

    const deletedGroup = screen.getByRole('heading', { name: 'Deleted users' }).closest('section')
    const restoreButton = within(deletedGroup!)
      .getAllByRole('button', { name: 'Restore' })
      .find((button) => !button.hasAttribute('disabled'))
    await browser.click(restoreButton!)

    expect(await screen.findByText('one-time-code')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy temporary password' })).toBeVisible()
    const activeList = screen.getByRole('list', { name: 'Active users' })
    expect(within(activeList).getByText('deleted@example.com')).toBeInTheDocument()
    expect(within(activeList).getByText('Recovery pending')).toBeVisible()
  })

  it('permanently deletes only after irreversible confirmation', async () => {
    const browser = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDialog()
    await screen.findByText('deleted@example.com')

    await browser.click(screen.getByRole('button', { name: 'Permanently delete deleted@example.com' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/skips.*retention.*irreversible/i))
    await waitFor(() => expect(api.permanentlyDeleteUser).toHaveBeenCalledWith(3))
    expect(screen.queryByText('deleted@example.com')).not.toBeInTheDocument()
  })

  it('shows the retention countdown and permanent deletion date for deleted accounts', async () => {
    renderDialog()

    await screen.findByText('deleted@example.com')

    const row = screen.getByText('deleted@example.com').closest('li')
    expect(within(row!).getByText(/permanently deletes in 42 days/i)).toBeVisible()
    expect(within(row!).getByText(/restore is available only until then/i)).toBeVisible()
  })

  it('shows verification status and resends for pending users', async () => {
    const browser = userEvent.setup()
    renderDialog()
    await screen.findByText('pending@example.com')

    expect(screen.getByText('Pending')).toBeVisible()
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0)

    await browser.click(screen.getByRole('button', { name: 'Resend verification' }))
    await waitFor(() => expect(api.resendUserVerification).toHaveBeenCalledWith(5))
    expect(screen.getByText(/Verification email sent to pending@example.com/i)).toBeVisible()
  })

  it('shows the backend duplicate-email warning without a recovery prompt', async () => {
    const browser = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm')
    api.createUser.mockRejectedValue(new Error('A user with this email already exists.'))
    renderDialog()
    await screen.findByText('active@example.com')

    await browser.click(screen.getByRole('button', { name: 'Add user' }))
    await browser.type(screen.getByLabelText('Email'), 'deleted@example.com')
    await browser.type(screen.getByLabelText('Temporary password'), 'temporary')
    await browser.click(screen.getByRole('button', { name: 'Create user' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A user with this email already exists.',
    )
    expect(confirm).not.toHaveBeenCalled()
  })
})
