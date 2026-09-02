import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, User, VaultInfo } from '../types'
import { DeviceUnlockError } from './deviceUnlock'
import { RestoredUserRecovery, VaultSetup, VaultUnlock } from './VaultGate'

const {
  completeRecovery,
  rewrapVaultForPassword,
  setupVault,
  unlockWithRecovery,
  unlockWithPassword,
  installPasswordWrap,
  unlockWithDevice,
  vaultState,
} = vi.hoisted(() => ({
  completeRecovery: vi.fn(),
  rewrapVaultForPassword: vi.fn(),
  setupVault: vi.fn(),
  unlockWithRecovery: vi.fn(),
  unlockWithPassword: vi.fn(),
  installPasswordWrap: vi.fn(),
  unlockWithDevice: vi.fn(),
  vaultState: {} as Record<string, unknown>,
}))

vi.mock('../api', () => ({
  api: { completeRecovery },
}))

vi.mock('../crypto/vault', () => ({
  rewrapVaultForPassword,
}))

vi.mock('./VaultContext', () => ({
  useVault: () => ({
    unlockMode: 'password',
    deviceUnlockAvailability: 'available',
    deviceUnlockEnrolled: false,
    setupVault,
    unlockWithRecovery,
    unlockWithPassword,
    unlockWithDevice,
    installPasswordWrap,
    ...vaultState,
  }),
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

const unlockUser: User = {
  id: 3,
  email: 'unlock@example.com',
  role: 'USER',
  vault: {
    ...vault,
    wrappedVaultKey: 'password-wrap',
    needsRecoveryUnlock: false,
  },
}

describe('VaultUnlock', () => {
  beforeEach(() => {
    for (const key of Object.keys(vaultState)) delete vaultState[key]
    unlockWithPassword.mockReset()
    unlockWithPassword.mockResolvedValue(undefined)
    unlockWithDevice.mockReset()
    unlockWithDevice.mockResolvedValue(undefined)
    installPasswordWrap.mockReset()
  })

  it('renders the unlock form when there is no password hint', async () => {
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={vi.fn()}
      />,
    )

    expect(
      await screen.findByRole('heading', { name: 'Unlock your workspace' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument()
  })

  it('unlocks with password and calls onReady', async () => {
    const user = userEvent.setup()
    const onReady = vi.fn()
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={onReady}
      />,
    )

    await user.type(screen.getByLabelText('Password'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
    expect(unlockWithPassword).toHaveBeenCalledWith('correct-password', unlockUser.vault)
  })

  it('shows an error when password unlock fails', async () => {
    const user = userEvent.setup()
    unlockWithPassword.mockRejectedValue(new Error('bad password'))
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password')
  })

  it('offers explicit device unlock without prompting on render', async () => {
    vaultState.unlockMode = 'device-verification'
    vaultState.deviceUnlockEnrolled = true
    const browser = userEvent.setup()
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Unlock with this device' })).toBeVisible()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(unlockWithDevice).not.toHaveBeenCalled()

    await browser.click(screen.getByRole('button', { name: 'Use password instead' }))
    expect(screen.getByLabelText('Password')).toBeVisible()
  })

  it('unlocks with the enrolled device and calls onReady', async () => {
    vaultState.unlockMode = 'device-verification'
    vaultState.deviceUnlockEnrolled = true
    const browser = userEvent.setup()
    const onReady = vi.fn()
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={onReady}
      />,
    )

    await browser.click(screen.getByRole('button', { name: 'Unlock with this device' }))

    await waitFor(() => expect(unlockWithDevice).toHaveBeenCalledOnce())
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('shows the password immediately when enrolled device unlock is unavailable', () => {
    vaultState.unlockMode = 'device-verification'
    vaultState.deviceUnlockAvailability = 'unsupported'
    vaultState.deviceUnlockEnrolled = true
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={vi.fn()}
      />,
    )

    expect(screen.getByText(/device unlock is unavailable/i)).toBeVisible()
    expect(screen.getByLabelText('Password')).toBeVisible()
    expect(unlockWithDevice).not.toHaveBeenCalled()
  })

  it('falls back to the password form after a device unlock failure', async () => {
    vaultState.unlockMode = 'device-verification'
    vaultState.deviceUnlockEnrolled = true
    unlockWithDevice.mockRejectedValue(new DeviceUnlockError('failed', 'corrupt wrap'))
    const browser = userEvent.setup()
    render(
      <VaultUnlock
        user={unlockUser}
        passwordHint={null}
        onLogout={vi.fn()}
        onReady={vi.fn()}
      />,
    )

    await browser.click(screen.getByRole('button', { name: 'Unlock with this device' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Device verification failed')
    expect(screen.getByLabelText('Password')).toBeVisible()
  })
})
