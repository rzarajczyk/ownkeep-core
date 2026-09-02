import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeVault } from '../crypto/vault'
import type { VaultInfo } from '../types'
import { VaultProvider, useVault } from './VaultContext'
import { restoreVaultKey, writeUnlockMode } from './vaultPersist'

const deviceUnlock = vi.hoisted(() => ({
  checkDeviceUnlockAvailability: vi.fn(),
  clearDeviceUnlockEnrollment: vi.fn(),
  enrollDeviceUnlock: vi.fn(),
  hasDeviceUnlockEnrollment: vi.fn(),
  unlockVaultWithDevice: vi.fn(),
}))

vi.mock('../api', () => ({
  api: {
    initializeVault: vi.fn(),
    updateVaultWrap: vi.fn(),
  },
}))

vi.mock('./deviceUnlock', () => deviceUnlock)

const password = 'correct horse battery'
let vault: VaultInfo
const providerUser = { id: 9, email: 'vault@example.com' }

function Probe() {
  const {
    isUnlocked,
    isRestoring,
    unlockMode,
    deviceUnlockEnrolled,
    setUnlockMode,
    unlockWithPassword,
    unlockWithDevice,
    clearLocalVaultAccess,
    lock,
  } = useVault()
  if (isRestoring) return <p>Restoring vault</p>
  return (
    <div>
      <p>unlocked:{String(isUnlocked)}</p>
      <p>mode:{unlockMode}</p>
      <p>device-enrolled:{String(deviceUnlockEnrolled)}</p>
      <button type="button" onClick={() => void unlockWithPassword(password, vault)}>
        Unlock
      </button>
      <button type="button" onClick={() => void setUnlockMode('keep-unlocked').catch(() => undefined)}>
        Keep unlocked
      </button>
      <button type="button" onClick={() => void setUnlockMode('password').catch(() => undefined)}>
        Lock on reload
      </button>
      <button type="button" onClick={() => void setUnlockMode('device-verification').catch(() => undefined)}>
        Use device
      </button>
      <button type="button" onClick={() => void unlockWithDevice().catch(() => undefined)}>
        Device unlock
      </button>
      <button type="button" onClick={() => lock()}>
        Lock now
      </button>
      <button type="button" onClick={() => void clearLocalVaultAccess()}>
        Clear local access
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
    deviceUnlock.checkDeviceUnlockAvailability.mockReset()
    deviceUnlock.checkDeviceUnlockAvailability.mockResolvedValue('available')
    deviceUnlock.clearDeviceUnlockEnrollment.mockReset()
    deviceUnlock.clearDeviceUnlockEnrollment.mockResolvedValue(undefined)
    deviceUnlock.enrollDeviceUnlock.mockReset()
    deviceUnlock.enrollDeviceUnlock.mockResolvedValue(undefined)
    deviceUnlock.hasDeviceUnlockEnrollment.mockReset()
    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(false)
    deviceUnlock.unlockVaultWithDevice.mockReset()
    deviceUnlock.unlockVaultWithDevice.mockResolvedValue(new Uint8Array(32).fill(4))
  })

  afterEach(() => {
    cleanup()
  })

  it('stays locked across remounts by default', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('unlocked:true')).toBeVisible()
    unmount()

    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
    expect(await restoreVaultKey(9)).toBeNull()
  })

  it('restores the vault key after remount when until-logout is enabled', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Keep unlocked' }))
    await waitFor(
      () => expect(screen.getByText('mode:keep-unlocked')).toBeVisible(),
      { timeout: 5_000 },
    )
    unmount()

    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:true')).toBeVisible()
  })

  it('does not restore after lock() even if the preference remains until-logout', async () => {
    const browser = userEvent.setup()
    writeUnlockMode(9, 'keep-unlocked')
    const { unmount } = render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).not.toBeNull())
    await browser.click(screen.getByRole('button', { name: 'Lock now' }))
    expect(await screen.findByText('unlocked:false')).toBeVisible()
    unmount()

    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
  })

  it('drops the stored wrap when switching back to lock-on-reload', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Keep unlocked' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).not.toBeNull())
    await browser.click(screen.getByRole('button', { name: 'Lock on reload' }))
    await waitFor(async () => expect(await restoreVaultKey(9)).toBeNull())
    expect(screen.getByText('unlocked:true')).toBeVisible()
    unmount()

    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
  })

  it('enrolls device mode explicitly and never prompts during remount', async () => {
    const browser = userEvent.setup()
    const { unmount } = render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Use device' }))

    await waitFor(() => expect(deviceUnlock.enrollDeviceUnlock).toHaveBeenCalledOnce())
    expect(
      await screen.findByText('mode:device-verification', undefined, { timeout: 5_000 }),
    ).toBeVisible()
    unmount()

    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(true)
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    expect(await screen.findByText('unlocked:false')).toBeVisible()
    expect(deviceUnlock.unlockVaultWithDevice).not.toHaveBeenCalled()

    await browser.click(screen.getByRole('button', { name: 'Device unlock' }))
    expect(await screen.findByText('unlocked:true')).toBeVisible()
  })

  it('does not commit device mode when enrollment storage fails', async () => {
    const browser = userEvent.setup()
    deviceUnlock.enrollDeviceUnlock.mockRejectedValue(new Error('storage failed'))
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Use device' }))

    await waitFor(() => expect(deviceUnlock.enrollDeviceUnlock).toHaveBeenCalledOnce())
    expect(screen.getByText('mode:password')).toBeVisible()
  })

  it('locks memory without deleting device enrollment', async () => {
    const browser = userEvent.setup()
    writeUnlockMode(9, 'device-verification')
    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(true)
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )
    await browser.click(await screen.findByRole('button', { name: 'Device unlock' }))
    await browser.click(screen.getByRole('button', { name: 'Lock now' }))

    expect(await screen.findByText('unlocked:false')).toBeVisible()
    expect(deviceUnlock.clearDeviceUnlockEnrollment).not.toHaveBeenCalled()
  })

  it('marks a failed device record unusable so it can be re-enrolled', async () => {
    const browser = userEvent.setup()
    writeUnlockMode(9, 'device-verification')
    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(true)
    deviceUnlock.unlockVaultWithDevice.mockRejectedValue({ code: 'failed' })
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )

    expect(await screen.findByText('device-enrolled:true')).toBeVisible()
    await browser.click(screen.getByRole('button', { name: 'Device unlock' }))

    expect(await screen.findByText('device-enrolled:false')).toBeVisible()
  })

  it('removes device enrollment when switching back to password mode', async () => {
    const browser = userEvent.setup()
    writeUnlockMode(9, 'device-verification')
    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(true)
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )

    await browser.click(await screen.findByRole('button', { name: 'Lock on reload' }))

    await waitFor(() => expect(screen.getByText('mode:password')).toBeVisible())
    expect(deviceUnlock.clearDeviceUnlockEnrollment).toHaveBeenCalledWith(9)
  })

  it('clears enrollment and preferences for account deletion cleanup', async () => {
    const browser = userEvent.setup()
    writeUnlockMode(9, 'device-verification')
    deviceUnlock.hasDeviceUnlockEnrollment.mockResolvedValue(true)
    render(
      <VaultProvider user={providerUser}>
        <Probe />
      </VaultProvider>,
    )

    await browser.click(await screen.findByRole('button', { name: 'Clear local access' }))

    await waitFor(() => expect(screen.getByText('mode:password')).toBeVisible())
    expect(deviceUnlock.clearDeviceUnlockEnrollment).toHaveBeenCalledWith(9)
    expect(localStorage.getItem('ownkeep.vaultUnlockMode')).toBeNull()
  })
})
