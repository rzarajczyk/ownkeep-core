export { default as App } from './App'
export { AppShell } from './AppShell'
export { Login } from './Login'
export { EmailVerifyPage } from './EmailVerifyPage'
export { UserManagementDialog } from './UserManagementDialog'
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
  VaultProvider,
  useVault,
  vaultNeedsSetup,
} from './vault/VaultContext'
export type { VaultLockBehavior } from './vault/VaultContext'
export {
  RestoredUserRecovery,
  VaultSetup,
  VaultUnlock,
} from './vault/VaultGate'
