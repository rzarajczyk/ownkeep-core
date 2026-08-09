import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLanguagePreference,
  i18n,
  LANGUAGE_STORAGE_KEY,
  readLanguagePreference,
  resolveLanguage,
} from './index'

describe('language preference', () => {
  afterEach(() => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    applyLanguagePreference('en')
  })

  it('defaults to auto and resolves a supported language from the browser', () => {
    expect(readLanguagePreference()).toBe('auto')
    expect(['en', 'pl']).toContain(resolveLanguage('auto'))
  })

  it('persists a manual language choice and updates i18n', async () => {
    applyLanguagePreference('pl')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('pl')
    expect(readLanguagePreference()).toBe('pl')
    await i18n.changeLanguage('pl')
    expect(i18n.t('settings.title')).toBe('Ustawienia konta')
    expect(document.documentElement.lang).toBe('pl')
  })

  it('translates common auth strings in English', () => {
    applyLanguagePreference('en')
    expect(i18n.t('auth.login.submit')).toBe('Sign in')
    expect(i18n.t('settings.language.auto')).toBe('Auto (browser)')
  })
})
