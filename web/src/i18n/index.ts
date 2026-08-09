import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  applyDocumentLanguage,
  readLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  writeLanguagePreference,
} from './language'
import en from './locales/en'
import pl from './locales/pl'

const resources = {
  en: { translation: en },
  pl: { translation: pl },
}

let initialized = false

export function ensureI18n() {
  if (initialized) return i18n
  initialized = true
  void i18n.use(initReactI18next).init({
    resources,
    lng: resolveLanguage(readLanguagePreference()),
    fallbackLng: 'en',
    supportedLngs: ['en', 'pl'],
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    returnNull: false,
  })

  const syncDocumentLanguage = () => {
    const language = (i18n.resolvedLanguage ?? i18n.language ?? 'en').split('-')[0]
    applyDocumentLanguage(language === 'pl' ? 'pl' : 'en')
  }

  i18n.on('languageChanged', syncDocumentLanguage)
  syncDocumentLanguage()
  return i18n
}

/** Apply stored preference (auto → detect, or forced language). */
export function applyLanguagePreference(preference: LanguagePreference) {
  writeLanguagePreference(preference)
  ensureI18n()
  void i18n.changeLanguage(resolveLanguage(preference))
}

/** Call once at app boot. */
export function bootstrapI18n() {
  ensureI18n()
  applyLanguagePreference(readLanguagePreference())
}

export {
  LANGUAGE_STORAGE_KEY,
  readLanguagePreference,
  resolveLanguage,
  writeLanguagePreference,
} from './language'
export type { LanguagePreference, SupportedLanguage } from './language'
export { i18n }
export default i18n

// Initialize on import so shared components (SaaS) have translations ready.
ensureI18n()
