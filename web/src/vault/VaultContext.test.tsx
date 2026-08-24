import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeVault } from '../crypto/vault'
import type { VaultInfo } from '../types'
import { VaultProvider, useVault } from './VaultContext'
import { restoreVaultKey, writeLockBehavior } from './vaultPersist'

vi.mock('../api', () => ({
  api: {
    initializeVault: vi.fn(),
    updateVaultWrap: vi.fn(),
  },
}))

const password = 'correct horse battery'
let vault: VaultInfo

function Probe() {
  const {
    isUnlocked,
    isRestoring,
    lockBehavior,
    setLockBehavior,
    unlockWithPassword,
    lock,
  } = useVault()
  if (isRestoring) return <p>Restoring vault</p>
  return (
    <div>
      <p>unlocked:{String(isUnlocked)}</p>
      <p>behavior:{lockBehavior}</p>
      <button type="button" onClick={() => void unlockWithPassword(password, vault)}>
        Unlock
      </button>
      <button type="button" onClick={() => void setLockBehavior('until-logout')}>
        Keep unlocked
      </button>
      <button type="button" onClick={() => void setLockBehavior('lock-on-reload')}>
        Lock on reload
      </button>
      <button type="button" onClick={() => lock()}>
        Lock now
      </button>
    </div>
  )
}

describe('VaultProvider persistence', () => {
  beforeAll(async () => {
    const init = await initializeVault(password)
    vault = {
      kdfSalt: init.kdfSalt,
      kdfParams: init.kdfParams,
      wrappedVaultKey: init.wrappedVaultKey,
      wrappedVaultKeyRecovery: init.wrappedVaultKeyRecovery,
      hasRecoveryKey: true,
      initialized: true,
      needsRecoveryUnlock: false,
    }
  })

  beforeEach(() => {
    indexedDB = new IDBFactory()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('stays locked across remounts by default', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('unlocked:true')).toBeVisible()
    unmount()

    render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
    expect(await restoreVaultKey(9)).toBeNull()
  })

  it('restores the vault key after remount when until-logout is enabled', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(screen.getByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Keep unlocked' }))
    await waitFor(() => expect(screen.getByText('behavior:until-logout')).toBeVisible())
    unmount()

    render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:true')).toBeVisible()
  })

  it('does not restore after lock() even if the preference remains until-logout', async () => {
    const browser = userEvent.setup()
    writeLockBehavior(9, 'until-logout')
    const { unmount } = render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).not.toBeNull())
    await browser.click(screen.getByRole('button', { name: 'Lock now' }))
    expect(await screen.findByText('unlocked:false')).toBeVisible()
    unmount()

    render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
  })

  it('drops the stored wrap when switching back to lock-on-reload', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(screen.getByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Keep unlocked' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).not.toBeNull())
    await browser.click(screen.getByRole('button', { name: 'Lock on reload' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).toBeNull())
    expect(screen.getByText('unlocked:true')).toBeVisible()
    unmount()

    render(
      <VaultProvider userId={9}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
  })
})
