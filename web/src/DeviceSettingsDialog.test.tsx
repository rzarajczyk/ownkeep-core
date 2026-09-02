import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceSettingsDialog } from './DeviceSettingsDialog'
import { applyLanguagePreference } from './i18n'
import type { DeviceUnlockAvailability } from './vault/VaultContext'

const vault = vi.hoisted(() => ({
  deviceUnlockAvailability: 'available' as DeviceUnlockAvailability,
  deviceUnlockEnrolled: false,
  setUnlockMode: vi.fn(),
  unlockMode: 'password' as 'password' | 'device-verification' | 'keep-unlocked',
}))

vi.mock('./vault/VaultContext', () => ({
  useVault: () => vault,
}))

describe('DeviceSettingsDialog', () => {
  beforeEach(() => {
    applyLanguagePreference('en')
    localStorage.clear()
    vault.deviceUnlockAvailability = 'available'
    vault.deviceUnlockEnrolled = false
    vault.unlockMode = 'password'
    vault.setUnlockMode.mockReset()
    vault.setUnlockMode.mockResolvedValue(undefined)
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
  })

  it('shows the three per-browser unlock modes and enrolls explicitly', async () => {
    const browser = userEvent.setup()
    render(<DeviceSettingsDialog onClose={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /ask for my password/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /unlock with this device/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /keep the vault unlocked/i })).not.toBeChecked()
    expect(vault.setUnlockMode).not.toHaveBeenCalled()

    await browser.click(screen.getByRole('radio', { name: /unlock with this device/i }))
    expect(vault.setUnlockMode).toHaveBeenCalledWith('device-verification')
  })

  it('disables device enrollment when the browser is unsupported', () => {
    vault.deviceUnlockAvailability = 'unsupported'
    render(<DeviceSettingsDialog onClose={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /unlock with this device/i })).toBeDisabled()
    expect(screen.getByText(/does not support secure WebAuthn PRF unlock/i)).toBeVisible()
  })

  it('shows the keep-unlocked threat explanation only when selected', () => {
    vault.unlockMode = 'keep-unlocked'
    render(<DeviceSettingsDialog onClose={vi.fn()} />)

    expect(screen.getByText('Security threats')).toBeVisible()
    expect(screen.getByText(/physical access/i)).toBeVisible()
    expect(screen.getByText(/browser extensions/i)).toBeVisible()
  })

  it('allows a missing device enrollment to be set up again', async () => {
    vault.unlockMode = 'device-verification'
    const browser = userEvent.setup()
    render(<DeviceSettingsDialog onClose={vi.fn()} />)

    expect(screen.getByText(/record is missing or no longer usable/i)).toBeVisible()
    await browser.click(screen.getByRole('button', { name: 'Set up device unlock again' }))

    expect(vault.setUnlockMode).toHaveBeenCalledWith('device-verification')
  })

  it('owns the browser language preference', async () => {
    const browser = userEvent.setup()
    render(<DeviceSettingsDialog onClose={vi.fn()} />)

    await browser.click(screen.getByRole('button', { name: 'Language' }))
    await browser.selectOptions(screen.getByLabelText('Language'), 'pl')

    expect(screen.getByRole('heading', { name: 'Ustawienia urządzenia' })).toBeVisible()
    expect(screen.getByLabelText('Język')).toHaveValue('pl')
  })
})
