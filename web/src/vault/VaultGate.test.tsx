import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, User, VaultInfo } from '../types'
import { RestoredUserRecovery, VaultSetup } from './VaultGate'

const { completeRecovery, rewrapVaultForPassword, setupVault, unlockWithRecovery } = vi.hoisted(() => ({
  completeRecovery: vi.fn(),
  rewrapVaultForPassword: vi.fn(),
  setupVault: vi.fn(),
  unlockWithRecovery: vi.fn(),
}))

vi.mock('../api', () => ({
  api: { completeRecovery },
}))

vi.mock('../crypto/vault', () => ({
  rewrapVaultForPassword,
}))

vi.mock('./VaultContext', () => ({
  useVault: () => ({ setupVault, unlockWithRecovery }),
}))

const vault: VaultInfo = {
  kdfSalt: 'salt',
  kdfParams: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
  wrappedVaultKey: null,
  wrappedVaultKeyRecovery: 'recovery-wrap',
  hasRecoveryKey: true,
  initialized: true,
  needsRecoveryUnlock: true,
}
const restoredUser: User = { id: 2, email: 'restored@example.com', role: 'USER', vault }
const normalSession: AuthSession = {
  token: 'normal-token',
  expiresAt: '2099-01-01T00:00:00Z',
  user: {
    ...restoredUser,
    vault: { ...vault, wrappedVaultKey: 'new-wrap', needsRecoveryUnlock: false },
  },
  recoveryRequired: false,
}

describe('VaultSetup', () => {
  beforeEach(() => {
    setupVault.mockReset()
    setupVault.mockResolvedValue('recovery-key-value')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:recovery-key'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('warns that the recovery key is shown once and downloads it', async () => {
    const user = userEvent.setup()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<VaultSetup passwordHint="password" onReady={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Save your recovery key' })).toBeInTheDocument()
    expect(screen.getByText(/won[’']t be able to see this key again/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('recovery-key-value')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Download key as file' }))

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery-key')
  })

  it('continues after the user confirms saving the key', async () => {
    const user = userEvent.setup()
    const onReady = vi.fn()

    render(<VaultSetup passwordHint="password" onReady={onReady} />)
    await screen.findByRole('heading', { name: 'Save your recovery key' })
    await user.click(screen.getByRole('button', { name: 'I saved it — continue' }))

    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
  })
})

describe('RestoredUserRecovery', () => {
  beforeEach(() => {
    unlockWithRecovery.mockReset()
    unlockWithRecovery.mockResolvedValue(new Uint8Array([1, 2, 3]))
    rewrapVaultForPassword.mockReset()
    rewrapVaultForPassword.mockResolvedValue('new-password-wrap')
    completeRecovery.mockReset()
    completeRecovery.mockResolvedValue(normalSession)
  })

  it('unwraps locally and sends no recovery key to the API', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(
      <RestoredUserRecovery
        user={restoredUser}
        onComplete={onComplete}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Recovery key'), 'browser-only-key')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Confirm new password'), 'new-password')
    await user.click(screen.getByRole('button', { name: 'Recover account' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(normalSession))
    expect(unlockWithRecovery).toHaveBeenCalledWith('browser-only-key', vault)
    expect(rewrapVaultForPassword).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      'new-password',
      vault,
    )
    expect(completeRecovery).toHaveBeenCalledWith('new-password', 'new-password-wrap')
    expect(completeRecovery.mock.calls.flat()).not.toContain('browser-only-key')
  })

  it('requires matching new passwords before running crypto', async () => {
    const user = userEvent.setup()
    render(
      <RestoredUserRecovery
        user={restoredUser}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Recovery key'), 'browser-only-key')
    await user.type(screen.getByLabelText('New password'), 'first-password')
    await user.type(screen.getByLabelText('Confirm new password'), 'different-password')
    await user.click(screen.getByRole('button', { name: 'Recover account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match')
    expect(unlockWithRecovery).not.toHaveBeenCalled()
    expect(completeRecovery).not.toHaveBeenCalled()
  })
})
