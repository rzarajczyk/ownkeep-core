import { Fingerprint, Globe, LoaderCircle, ShieldAlert, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  applyLanguagePreference,
  readLanguagePreference,
  type LanguagePreference,
} from './i18n'
import { DeviceUnlockError } from './vault/deviceUnlock'
import { useVault, type VaultUnlockMode } from './vault/VaultContext'

type DeviceSettingsSection = 'unlock' | 'language'

export function DeviceSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const languageId = useId()
  const {
    deviceUnlockAvailability,
    deviceUnlockEnrolled,
    setUnlockMode,
    unlockMode,
  } = useVault()
  const [section, setSection] = useState<DeviceSettingsSection>('unlock')
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() =>
    readLanguagePreference(),
  )
  const [busyMode, setBusyMode] = useState<VaultUnlockMode | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  async function changeUnlockMode(mode: VaultUnlockMode) {
    if (
      busyMode ||
      (mode === unlockMode && (mode !== 'device-verification' || deviceUnlockEnrolled))
    ) return
    setError('')
    setBusyMode(mode)
    try {
      await setUnlockMode(mode)
    } catch (reason) {
      setError(
        reason instanceof DeviceUnlockError && reason.code === 'cancelled'
          ? t('deviceSettings.unlock.errors.canceled')
          : reason instanceof DeviceUnlockError && reason.code === 'unsupported'
            ? t('deviceSettings.unlock.errors.unsupported')
            : t('deviceSettings.unlock.errors.failed'),
      )
    } finally {
      setBusyMode(null)
    }
  }

  function changeLanguage(next: LanguagePreference) {
    setLanguagePreference(next)
    applyLanguagePreference(next)
  }

  const deviceOptionDisabled =
    busyMode !== null ||
    deviceUnlockAvailability === 'checking' ||
    deviceUnlockAvailability === 'unsupported' ||
    deviceUnlockAvailability === 'insecure-context'

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog settings-dialog"
      aria-labelledby="device-settings-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="import-panel">
        <header className="import-header">
          <div>
            <span className="eyebrow">{t('deviceSettings.eyebrow')}</span>
            <h2 id="device-settings-title">{t('deviceSettings.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('deviceSettings.close')}
          >
            <X />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-section-nav" aria-label={t('deviceSettings.title')}>
            <button
              type="button"
              className={section === 'unlock' ? 'active' : ''}
              aria-current={section === 'unlock' ? 'page' : undefined}
              onClick={() => {
                setSection('unlock')
                setError('')
              }}
            >
              {t('deviceSettings.nav.unlock')}
            </button>
            <button
              type="button"
              className={section === 'language' ? 'active' : ''}
              aria-current={section === 'language' ? 'page' : undefined}
              onClick={() => {
                setSection('language')
                setError('')
              }}
            >
              {t('deviceSettings.nav.language')}
            </button>
          </nav>

          {section === 'unlock' ? (
            <div className="settings-security">
              <fieldset className="settings-vault-lock">
                <legend>{t('deviceSettings.unlock.title')}</legend>
                <p>{t('deviceSettings.unlock.intro')}</p>

                <label className={unlockMode === 'password' ? 'settings-choice active' : 'settings-choice'}>
                  <input
                    type="radio"
                    name="vault-unlock-mode"
                    value="password"
                    checked={unlockMode === 'password'}
                    disabled={busyMode !== null}
                    onChange={() => void changeUnlockMode('password')}
                  />
                  <span className="settings-choice-text">
                    <strong>{t('deviceSettings.unlock.password.label')}</strong>
                    <span>{t('deviceSettings.unlock.password.description')}</span>
                  </span>
                </label>

                <label
                  className={
                    unlockMode === 'device-verification'
                      ? 'settings-choice active settings-choice-device'
                      : 'settings-choice settings-choice-device'
                  }
                >
                  <input
                    type="radio"
                    name="vault-unlock-mode"
                    value="device-verification"
                    checked={unlockMode === 'device-verification'}
                    disabled={deviceOptionDisabled}
                    onChange={() => void changeUnlockMode('device-verification')}
                  />
                  <span className="settings-choice-icon" aria-hidden="true">
                    {busyMode === 'device-verification' ? <LoaderCircle className="spin" /> : <Fingerprint />}
                  </span>
                  <span className="settings-choice-text">
                    <strong>{t('deviceSettings.unlock.device.label')}</strong>
                    <span>{t('deviceSettings.unlock.device.description')}</span>
                  </span>
                </label>
                {deviceUnlockAvailability === 'checking' && (
                  <p className="settings-support-note">{t('deviceSettings.unlock.device.checking')}</p>
                )}
                {deviceUnlockAvailability === 'insecure-context' && (
                  <p className="settings-support-note inline-error" role="note">
                    {t('deviceSettings.unlock.device.insecureContext')}
                  </p>
                )}
                {deviceUnlockAvailability === 'unsupported' && (
                  <p className="settings-support-note inline-error" role="note">
                    {t('deviceSettings.unlock.device.unsupported')}
                  </p>
                )}
                {unlockMode === 'device-verification' && deviceUnlockEnrolled && (
                  <div className="settings-device-note" role="note">
                    <Fingerprint aria-hidden="true" />
                    <p>{t('deviceSettings.unlock.device.enabledNote')}</p>
                  </div>
                )}
                {unlockMode === 'device-verification' &&
                  !deviceUnlockEnrolled &&
                  deviceUnlockAvailability === 'available' && (
                    <div className="settings-device-note" role="note">
                      <Fingerprint aria-hidden="true" />
                      <div>
                        <p>{t('deviceSettings.unlock.device.missingEnrollment')}</p>
                        <button
                          type="button"
                          className="secondary-button settings-device-reenroll"
                          disabled={busyMode !== null}
                          onClick={() => void changeUnlockMode('device-verification')}
                        >
                          {busyMode === 'device-verification'
                            ? t('deviceSettings.unlock.device.settingUp')
                            : t('deviceSettings.unlock.device.setUpAgain')}
                        </button>
                      </div>
                    </div>
                  )}

                <label
                  className={
                    unlockMode === 'keep-unlocked'
                      ? 'settings-choice active settings-choice-warning'
                      : 'settings-choice settings-choice-warning'
                  }
                >
                  <input
                    type="radio"
                    name="vault-unlock-mode"
                    value="keep-unlocked"
                    checked={unlockMode === 'keep-unlocked'}
                    disabled={busyMode !== null}
                    onChange={() => void changeUnlockMode('keep-unlocked')}
                  />
                  <span className="settings-choice-text">
                    <strong>{t('deviceSettings.unlock.keepUnlocked.label')}</strong>
                    <span>{t('deviceSettings.unlock.keepUnlocked.summary')}</span>
                  </span>
                </label>
                {unlockMode === 'keep-unlocked' && (
                  <div className="settings-vault-threats" role="note">
                    <p>
                      <ShieldAlert aria-hidden="true" />
                      <strong>{t('deviceSettings.unlock.keepUnlocked.threatsTitle')}</strong>
                    </p>
                    <p>{t('deviceSettings.unlock.keepUnlocked.warningLead')}</p>
                    <ul>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatPhysical')}</li>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatXss')}</li>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatExtensions')}</li>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatForensics')}</li>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatShared')}</li>
                      <li>{t('deviceSettings.unlock.keepUnlocked.threatTabs')}</li>
                    </ul>
                    <p>{t('deviceSettings.unlock.keepUnlocked.clearsOnLogout')}</p>
                  </div>
                )}
                {error && <p className="inline-error" role="alert">{error}</p>}
              </fieldset>
            </div>
          ) : (
            <div className="settings-form">
              <p>{t('deviceSettings.language.hint')}</p>
              <label htmlFor={languageId}>{t('deviceSettings.language.title')}</label>
              <div className="settings-language-field">
                <Globe aria-hidden="true" />
                <select
                  id={languageId}
                  value={languagePreference}
                  onChange={(event) => changeLanguage(event.target.value as LanguagePreference)}
                >
                  <option value="auto">{t('deviceSettings.language.auto')}</option>
                  <option value="en">{t('deviceSettings.language.en')}</option>
                  <option value="pl">{t('deviceSettings.language.pl')}</option>
                </select>
              </div>
              <div className="import-actions">
                <button type="button" className="secondary-button" onClick={onClose}>
                  {t('common.actions.done')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}
