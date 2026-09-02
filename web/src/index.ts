export { default as App } from './App'
export { AppShell } from './AppShell'
export { Login } from './Login'
export { EmailVerifyPage } from './EmailVerifyPage'
export { UserManagementDialog } from './UserManagementDialog'
export { DeviceSettingsDialog } from './DeviceSettingsDialog'
export { UserSettingsDialog } from './UserSettingsDialog'
export { api, ApiError } from './api'
export type * from './types'
import './i18n'
export {
  applyLanguagePreference,
  bootstrapI18n,
  i18n,
  readLanguagePreference,
  resolveLanguage,
} from './i18n'
export type { LanguagePreference, SupportedLanguage } from './i18n'
export {
  clearVaultSession,
  VaultProvider,
  useVault,
  vaultNeedsSetup,
} from './vault/VaultContext'
export type { DeviceUnlockAvailability, VaultUnlockMode } from './vault/VaultContext'
export {
  RestoredUserRecovery,
  VaultSetup,
  VaultUnlock,
} from './vault/VaultGate'
