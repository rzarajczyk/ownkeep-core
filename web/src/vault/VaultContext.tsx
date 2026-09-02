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
  checkDeviceUnlockAvailability,
  clearDeviceUnlockEnrollment,
  enrollDeviceUnlock,
  hasDeviceUnlockEnrollment,
  unlockVaultWithDevice,
  type DeviceUnlockAvailability,
} from './deviceUnlock'
import {
  clearUnlockModePreference,
  clearPersistedVaultKey,
  clearPersistedVaultKeysExcept,
  persistVaultKey,
  publishVaultLocked,
  readUnlockMode,
  removePersistedVaultKey,
  restoreVaultKey,
  subscribeVaultLocked,
  writeUnlockMode,
  type VaultUnlockMode,
} from './vaultPersist'

export type { DeviceUnlockAvailability, VaultUnlockMode }

interface VaultContextValue {
  vaultKey: Uint8Array | null
  isUnlocked: boolean
  isRestoring: boolean
  unlockMode: VaultUnlockMode
  deviceUnlockAvailability: DeviceUnlockAvailability
  deviceUnlockEnrolled: boolean
  setUnlockMode: (mode: VaultUnlockMode) => Promise<void>
  unlockWithPassword: (password: string, vault: VaultInfo) => Promise<void>
  unlockWithDevice: () => Promise<void>
  unlockWithRecovery: (recoveryKey: string, vault: VaultInfo) => Promise<Uint8Array>
  setupVault: (password: string) => Promise<string>
  rewrapForNewPassword: (newPassword: string, vault: VaultInfo) => Promise<string>
  installPasswordWrap: (wrappedVaultKey: string) => Promise<void>
  clearLocalVaultAccess: () => Promise<void>
  lock: () => void
}

const VaultContext = createContext<VaultContextValue | null>(null)

export async function clearVaultSession(userId: number): Promise<void> {
  clearNoteKeyCache()
  publishVaultLocked(userId)
  await clearPersistedVaultKey(userId)
}

export function VaultProvider({
  children,
  user,
}: {
  children: ReactNode
  user: Pick<User, 'id' | 'email'>
}) {
  const [vaultKey, setVaultKey] = useState<Uint8Array | null>(null)
  const [unlockMode, setUnlockModeState] = useState<VaultUnlockMode>(() =>
    readUnlockMode(user.id),
  )
  const [deviceUnlockAvailability, setDeviceUnlockAvailability] =
    useState<DeviceUnlockAvailability>('checking')
  const [deviceUnlockEnrolled, setDeviceUnlockEnrolled] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)

  useEffect(() => {
    const userId = user.id
    const mode = readUnlockMode(userId)
    setUnlockModeState(mode)
    setVaultKey(null)
    setDeviceUnlockEnrolled(false)
    setDeviceUnlockAvailability('checking')
    clearNoteKeyCache()
    let cancelled = false
    setIsRestoring(true)
    void (async () => {
      try {
        const [, availability, enrolled] = await Promise.all([
          clearPersistedVaultKeysExcept(userId),
          checkDeviceUnlockAvailability(),
          hasDeviceUnlockEnrollment(userId),
        ])
        if (cancelled) return
        setDeviceUnlockAvailability(availability)
        setDeviceUnlockEnrolled(enrolled)
        if (mode === 'keep-unlocked') {
          const key = await restoreVaultKey(userId)
          if (cancelled) return
          if (key) setVaultKey(key)
        }
      } finally {
        if (!cancelled) setIsRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user.id])

  useEffect(() => {
    const userId = user.id
    return subscribeVaultLocked(userId, () => {
      setVaultKey(null)
      clearNoteKeyCache()
      void clearPersistedVaultKey(userId)
    })
  }, [user.id])

  const persistIfNeeded = useCallback(
    async (key: Uint8Array) => {
      if (readUnlockMode(user.id) !== 'keep-unlocked') return
      await persistVaultKey(user.id, key)
    },
    [user.id],
  )

  const lock = useCallback(() => {
    setVaultKey(null)
    void clearVaultSession(user.id)
  }, [user.id])

  const setUnlockMode = useCallback(
    async (mode: VaultUnlockMode) => {
      if (
        mode === unlockMode &&
        (mode !== 'device-verification' || deviceUnlockEnrolled)
      ) return
      if (mode === 'device-verification') {
        if (!vaultKey) throw new Error(i18n.t('errors.vaultLocked'))
        await enrollDeviceUnlock(user, vaultKey)
        try {
          await removePersistedVaultKey(user.id)
          writeUnlockMode(user.id, mode)
        } catch (reason) {
          await clearDeviceUnlockEnrollment(user.id).catch(() => undefined)
          throw reason
        }
        setUnlockModeState(mode)
        setDeviceUnlockEnrolled(true)
        return
      }
      if (mode === 'keep-unlocked') {
        if (!vaultKey) throw new Error(i18n.t('errors.vaultLocked'))
        await persistVaultKey(user.id, vaultKey)
      } else {
        await removePersistedVaultKey(user.id)
      }
      try {
        if (deviceUnlockEnrolled) await clearDeviceUnlockEnrollment(user.id)
        writeUnlockMode(user.id, mode)
      } catch (reason) {
        if (mode === 'keep-unlocked') await clearPersistedVaultKey(user.id)
        throw reason
      }
      setUnlockModeState(mode)
      setDeviceUnlockEnrolled(false)
    },
    [deviceUnlockEnrolled, unlockMode, user, vaultKey],
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

  const unlockWithDevice = useCallback(async () => {
    try {
      const key = await unlockVaultWithDevice(user.id)
      setVaultKey(key)
    } catch (reason) {
      const canceled =
        typeof reason === 'object' &&
        reason !== null &&
        'code' in reason &&
        reason.code === 'cancelled'
      if (!canceled) setDeviceUnlockEnrolled(false)
      throw reason
    }
  }, [user.id])

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

  const clearLocalVaultAccess = useCallback(async () => {
    setVaultKey(null)
    clearNoteKeyCache()
    await Promise.all([
      clearPersistedVaultKey(user.id),
      clearDeviceUnlockEnrollment(user.id).catch(() => undefined),
    ])
    clearUnlockModePreference(user.id)
    setUnlockModeState('password')
    setDeviceUnlockEnrolled(false)
    publishVaultLocked(user.id)
  }, [user.id])

  const value = useMemo(
    () => ({
      vaultKey,
      isUnlocked: vaultKey !== null,
      isRestoring,
      unlockMode,
      deviceUnlockAvailability,
      deviceUnlockEnrolled,
      setUnlockMode,
      unlockWithPassword,
      unlockWithDevice,
      unlockWithRecovery,
      setupVault,
      rewrapForNewPassword,
      installPasswordWrap,
      clearLocalVaultAccess,
      lock,
    }),
    [
      vaultKey,
      isRestoring,
      unlockMode,
      deviceUnlockAvailability,
      deviceUnlockEnrolled,
      setUnlockMode,
      unlockWithPassword,
      unlockWithDevice,
      unlockWithRecovery,
      setupVault,
      rewrapForNewPassword,
      installPasswordWrap,
      clearLocalVaultAccess,
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
