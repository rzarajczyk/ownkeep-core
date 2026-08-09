export const SUPPORTED_LANGUAGES = ['en', 'pl'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** User preference: follow browser, or force a language. */
export type LanguagePreference = 'auto' | SupportedLanguage

export const LANGUAGE_STORAGE_KEY = 'ownkeep.language'

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'auto' || isSupportedLanguage(value)
}

export function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (stored && isLanguagePreference(stored)) return stored
  } catch {
    // ignore storage failures
  }
  return 'auto'
}

export function writeLanguagePreference(preference: LanguagePreference) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  } catch {
    // ignore storage failures
  }
}

/** Resolve preference to an active UI language. */
export function resolveLanguage(preference: LanguagePreference = readLanguagePreference()): SupportedLanguage {
  if (preference !== 'auto') return preference
  if (typeof navigator === 'undefined') return 'en'
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split('-')[0]
    if (isSupportedLanguage(base)) return base
  }
  return 'en'
}

export function applyDocumentLanguage(language: SupportedLanguage) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
}
