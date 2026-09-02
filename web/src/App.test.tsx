import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession, User, VaultInfo } from './types'
import App from './App'

const api = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  onUnauthorized: vi.fn(),
  setToken: vi.fn(),
}))

vi.mock('./api', () => ({ api }))

vi.mock('./Login', () => ({
  Login: ({
    onLogin,
  }: {
    onLogin: (email: string, password: string, signal: AbortSignal) => Promise<void>
  }) => (
    <button
      type="button"
      onClick={() => void onLogin('restored@example.com', 'temporary-code', new AbortController().signal)}
    >
      Test sign in
    </button>
  ),
}))

vi.mock('./AppShell', () => ({
  AppShell: ({ user }: { user: User }) => <div>Workspace for {user.email}</div>,
}))

vi.mock('./vault/VaultContext', () => ({
  clearVaultSession: vi.fn(),
  VaultProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useVault: () => ({ isUnlocked: true, lock: vi.fn() }),
  vaultNeedsSetup: () => false,
}))

vi.mock('./vault/VaultGate', () => ({
  RestoredUserRecovery: ({
    user,
    onComplete,
  }: {
    user: User
    onComplete: (session: AuthSession) => void
  }) => (
    <section>
      <h1>Recovery for {user.email}</h1>
      <button type="button" onClick={() => onComplete(normalSession)}>
        Finish recovery
      </button>
    </section>
  ),
  VaultSetup: () => <div>Vault setup</div>,
  VaultUnlock: () => <div>Vault unlock</div>,
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
const user: User = { id: 2, email: 'restored@example.com', role: 'USER', vault }
const recoverySession: AuthSession = {
  token: 'recovery-token',
  expiresAt: '2099-01-01T00:00:00Z',
  user,
  recoveryRequired: true,
}
const normalSession: AuthSession = {
  token: 'normal-token',
  expiresAt: '2099-01-01T00:00:00Z',
  user: {
    ...user,
    vault: { ...vault, wrappedVaultKey: 'password-wrap', needsRecoveryUnlock: false },
  },
  recoveryRequired: false,
}

describe('recovery auth routing', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    api.login.mockResolvedValue(recoverySession)
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('restores a recovery session without calling /me', async () => {
    localStorage.setItem('ownkeep.auth', JSON.stringify(recoverySession))

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Recovery for restored@example.com' })).toBeVisible()
    expect(api.setToken).toHaveBeenCalledWith('recovery-token')
    expect(api.me).not.toHaveBeenCalled()
  })

  it('routes temporary-code login to recovery and replaces the stored session on completion', async () => {
    const browser = userEvent.setup()
    render(<App />)

    await browser.click(screen.getByRole('button', { name: 'Test sign in' }))
    expect(await screen.findByRole('heading', { name: 'Recovery for restored@example.com' })).toBeVisible()
    expect(localStorage.getItem('ownkeep.auth')).not.toContain('temporary-code')
    expect(api.me).not.toHaveBeenCalled()

    await browser.click(screen.getByRole('button', { name: 'Finish recovery' }))

    expect(await screen.findByText('Workspace for restored@example.com')).toBeVisible()
    await waitFor(() => expect(api.setToken).toHaveBeenLastCalledWith('normal-token'))
    expect(JSON.parse(localStorage.getItem('ownkeep.auth') ?? '{}')).toEqual(normalSession)
  })
})
