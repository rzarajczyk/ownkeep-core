import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import {
  clearPersistedVaultKey,
  clearPersistedVaultKeysExcept,
  persistVaultKey,
  publishVaultLocked,
  readLockBehavior,
  restoreVaultKey,
  subscribeVaultLocked,
  writeLockBehavior,
  type VaultLockBehavior,
} from './vaultPersist'

export type { VaultLockBehavior }

interface VaultContextValue {
  vaultKey: Uint8Array | null
  isUnlocked: boolean
  isRestoring: boolean
  lockBehavior: VaultLockBehavior
  setLockBehavior: (behavior: VaultLockBehavior) => Promise<void>
  unlockWithPassword: (password: string, vault: VaultInfo) => Promise<void>
  unlockWithRecovery: (recoveryKey: string, vault: VaultInfo) => Promise<Uint8Array>
  setupVault: (password: string) => Promise<string>
  rewrapForNewPassword: (newPassword: string, vault: VaultInfo) => Promise<string>
  installPasswordWrap: (wrappedVaultKey: string) => Promise<void>
  lock: () => void
}

const VaultContext = createContext<VaultContextValue | null>(null)

function shouldRestoreOnMount(userId: number | undefined) {
  return userId != null && readLockBehavior(userId) === 'until-logout'
}

export function VaultProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId?: number
}) {
  const [vaultKey, setVaultKey] = useState<Uint8Array | null>(null)
  const [lockBehavior, setLockBehaviorState] = useState<VaultLockBehavior>(() =>
    userId != null ? readLockBehavior(userId) : 'lock-on-reload',
  )
  const [isRestoring, setIsRestoring] = useState(() => shouldRestoreOnMount(userId))

  useEffect(() => {
    setLockBehaviorState(userId != null ? readLockBehavior(userId) : 'lock-on-reload')
    setVaultKey(null)
    clearNoteKeyCache()
    if (userId == null) {
      setIsRestoring(false)
      return
    }
    let cancelled = false
    setIsRestoring(readLockBehavior(userId) === 'until-logout')
    void (async () => {
      try {
        await clearPersistedVaultKeysExcept(userId)
        if (cancelled) return
        if (readLockBehavior(userId) !== 'until-logout') return
        const key = await restoreVaultKey(userId)
        if (cancelled) return
        if (key) setVaultKey(key)
      } finally {
        if (!cancelled) setIsRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(() => {
    if (userId == null) return
    return subscribeVaultLocked(userId, () => {
      setVaultKey(null)
      clearNoteKeyCache()
      void clearPersistedVaultKey(userId)
    })
  }, [userId])

  const persistIfNeeded = useCallback(
    async (key: Uint8Array) => {
      if (userId == null) return
      if (readLockBehavior(userId) !== 'until-logout') return
      await persistVaultKey(userId, key)
    },
    [userId],
  )

  const lock = useCallback(() => {
    setVaultKey(null)
    clearNoteKeyCache()
    if (userId != null) {
      publishVaultLocked(userId)
      void clearPersistedVaultKey(userId)
    }
  }, [userId])

  const setLockBehavior = useCallback(
    async (behavior: VaultLockBehavior) => {
      if (userId == null) {
        setLockBehaviorState(behavior)
        return
      }
      if (behavior === 'until-logout') {
        if (vaultKey) await persistVaultKey(userId, vaultKey)
        writeLockBehavior(userId, behavior)
        setLockBehaviorState(behavior)
        return
      }
      writeLockBehavior(userId, behavior)
      setLockBehaviorState(behavior)
      await clearPersistedVaultKey(userId)
    },
    [userId, vaultKey],
  )

  const unlockWithPassword = useCallback(
    async (password: string, vault: VaultInfo) => {
      const key = await unlockVaultWithPassword(password, vault)
      setVaultKey(key)
      try {
        await persistIfNeeded(key)
      } catch {
        // in-memory unlock still succeeds if persistence fails
      }
    },
    [persistIfNeeded],
  )

  const unlockWithRecovery = useCallback(
    async (recoveryKey: string, vault: VaultInfo) => {
      const key = await unlockVaultWithRecovery(recoveryKey, vault)
      setVaultKey(key)
      try {
        await persistIfNeeded(key)
      } catch {
        // in-memory unlock still succeeds if persistence fails
      }
      return key
    },
    [persistIfNeeded],
  )

  const setupVault = useCallback(
    async (password: string) => {
      const init = await initializeVault(password)
      await api.initializeVault({
        kdfSalt: init.kdfSalt,
        kdfParams: init.kdfParams,
        wrappedVaultKey: init.wrappedVaultKey,
        wrappedVaultKeyRecovery: init.wrappedVaultKeyRecovery,
      })
      setVaultKey(init.vaultKey)
      try {
        await persistIfNeeded(init.vaultKey)
      } catch {
        // in-memory unlock still succeeds if persistence fails
      }
      return init.recoveryKeyBase64
    },
    [persistIfNeeded],
  )

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
      isRestoring,
      lockBehavior,
      setLockBehavior,
      unlockWithPassword,
      unlockWithRecovery,
      setupVault,
      rewrapForNewPassword,
      installPasswordWrap,
      lock,
    }),
    [
      vaultKey,
      isRestoring,
      lockBehavior,
      setLockBehavior,
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
