import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { clearNoteKeyCache } from '../notesCipher'
import type { User, VaultInfo } from '../types'
import {
  initializeVault,
  rewrapVaultForPassword,
  unlockVaultWithPassword,
  unlockVaultWithRecovery,
} from '../crypto/vault'
import { api } from '../api'
import { i18n } from '../i18n'

interface VaultContextValue {
  vaultKey: Uint8Array | null
  isUnlocked: boolean
  unlockWithPassword: (password: string, vault: VaultInfo) => Promise<void>
  unlockWithRecovery: (recoveryKey: string, vault: VaultInfo) => Promise<Uint8Array>
  setupVault: (password: string) => Promise<string>
  rewrapForNewPassword: (newPassword: string, vault: VaultInfo) => Promise<string>
  installPasswordWrap: (wrappedVaultKey: string) => Promise<void>
  lock: () => void
}

const VaultContext = createContext<VaultContextValue | null>(null)

export function VaultProvider({ children }: { children: ReactNode }) {
  const [vaultKey, setVaultKey] = useState<Uint8Array | null>(null)

  const lock = useCallback(() => {
    setVaultKey(null)
    clearNoteKeyCache()
  }, [])

  const unlockWithPassword = useCallback(async (password: string, vault: VaultInfo) => {
    const key = await unlockVaultWithPassword(password, vault)
    setVaultKey(key)
  }, [])

  const unlockWithRecovery = useCallback(async (recoveryKey: string, vault: VaultInfo) => {
    const key = await unlockVaultWithRecovery(recoveryKey, vault)
    setVaultKey(key)
    return key
  }, [])

  const setupVault = useCallback(async (password: string) => {
    const init = await initializeVault(password)
    await api.initializeVault({
      kdfSalt: init.kdfSalt,
      kdfParams: init.kdfParams,
      wrappedVaultKey: init.wrappedVaultKey,
      wrappedVaultKeyRecovery: init.wrappedVaultKeyRecovery,
    })
    setVaultKey(init.vaultKey)
    return init.recoveryKeyBase64
  }, [])

  const rewrapForNewPassword = useCallback(
    async (newPassword: string, vault: VaultInfo) => {
      if (!vaultKey) throw new Error(i18n.t('errors.vaultLocked'))
      return rewrapVaultForPassword(vaultKey, newPassword, vault)
    },
    [vaultKey],
  )

  const installPasswordWrap = useCallback(async (wrappedVaultKey: string) => {
    await api.updateVaultWrap({ wrappedVaultKey })
  }, [])

  const value = useMemo(
    () => ({
      vaultKey,
      isUnlocked: vaultKey !== null,
      unlockWithPassword,
      unlockWithRecovery,
      setupVault,
      rewrapForNewPassword,
      installPasswordWrap,
      lock,
    }),
    [
      vaultKey,
      unlockWithPassword,
      unlockWithRecovery,
      setupVault,
      rewrapForNewPassword,
      installPasswordWrap,
      lock,
    ],
  )

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export function useVault() {
  const ctx = useContext(VaultContext)
  if (!ctx) throw new Error('useVault must be used within VaultProvider')
  return ctx
}

export function vaultNeedsSetup(user: User) {
  return !user.vault.initialized
}

export function vaultNeedsUnlock(user: User) {
  return user.vault.initialized
}
