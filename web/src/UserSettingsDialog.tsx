import { Globe, KeyRound, LoaderCircle, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DELETED_USER_RETENTION_DAYS, deletedAccountRetentionCopy } from './accountRetention'
import { api } from './api'
import {
  applyLanguagePreference,
  readLanguagePreference,
  type LanguagePreference,
} from './i18n'
import { errorMessage } from './utils'
import { useVault } from './vault/VaultContext'

interface UserSettingsDialogProps {
  onClose: () => void
  onPasswordChanged: () => void
  onAccountDeleted: () => void
}

type SettingsSection = 'security' | 'password' | 'account' | 'language'

export function UserSettingsDialog({
  onClose,
  onPasswordChanged,
  onAccountDeleted,
}: UserSettingsDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { rewrapForNewPassword, lockBehavior, setLockBehavior } = useVault()
  const currentId = useId()
  const nextId = useId()
  const confirmId = useId()
  const deletePasswordId = useId()
  const languageId = useId()
  const [section, setSection] = useState<SettingsSection>('security')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() =>
    readLanguagePreference(),
  )
  const [error, setError] = useState('')
  const [lockError, setLockError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  async function submitPasswordChange(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!currentPassword || !newPassword) {
      setError(t('settings.security.missingFields'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.security.mismatch'))
      return
    }
    setSubmitting(true)
    try {
      const me = await api.me()
      const wrappedVaultKey = await rewrapForNewPassword(newPassword, me.vault)
      await api.changePassword(currentPassword, newPassword, wrappedVaultKey)
      onPasswordChanged()
    } catch (reason) {
      setError(errorMessage(reason))
      setSubmitting(false)
    }
  }

  async function submitAccountDeletion(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!deletePassword) {
      setError(t('settings.account.missingPassword'))
      return
    }
    const confirmed = window.confirm(
      t('settings.account.confirmPrompt', { days: DELETED_USER_RETENTION_DAYS }),
    )
    if (!confirmed) return
    setSubmitting(true)
    try {
      await api.deleteAccount(deletePassword)
      onAccountDeleted()
    } catch (reason) {
      setError(errorMessage(reason))
      setSubmitting(false)
    }
  }

  function goToSection(next: SettingsSection) {
    setSection(next)
    setError('')
    setLockError('')
  }

  function changeLanguage(next: LanguagePreference) {
    setLanguagePreference(next)
    applyLanguagePreference(next)
  }

  async function changeLockBehavior(next: typeof lockBehavior) {
    if (next === lockBehavior || lockBusy) return
    setError('')
    setLockError('')
    setLockBusy(true)
    try {
      await setLockBehavior(next)
    } catch {
      setLockError(t('settings.security.vaultLock.persistError'))
    } finally {
      setLockBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog settings-dialog"
      aria-labelledby="user-settings-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="import-panel">
        <header className="import-header">
          <div>
            <span className="eyebrow">{t('settings.eyebrow')}</span>
            <h2 id="user-settings-title">{t('settings.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('settings.close')}
          >
            <X />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-section-nav" aria-label={t('settings.title')}>
            <button
              type="button"
              className={section === 'security' ? 'active' : ''}
              aria-current={section === 'security' ? 'page' : undefined}
              onClick={() => goToSection('security')}
            >
              {t('settings.nav.security')}
            </button>
            <button
              type="button"
              className={section === 'password' ? 'active' : ''}
              aria-current={section === 'password' ? 'page' : undefined}
              onClick={() => goToSection('password')}
            >
              {t('settings.nav.password')}
            </button>
            <button
              type="button"
              className={section === 'language' ? 'active' : ''}
              aria-current={section === 'language' ? 'page' : undefined}
              onClick={() => goToSection('language')}
            >
              {t('settings.nav.language')}
            </button>
            <button
              type="button"
              className={section === 'account' ? 'active' : ''}
              aria-current={section === 'account' ? 'page' : undefined}
              onClick={() => goToSection('account')}
            >
              {t('settings.nav.account')}
            </button>
          </nav>

          {section === 'security' ? (
            <div className="settings-security">
              <fieldset className="settings-vault-lock">
                <legend>{t('settings.security.vaultLock.title')}</legend>
                <p>{t('settings.security.vaultLock.intro')}</p>
                <label
                  className={
                    lockBehavior === 'lock-on-reload'
                      ? 'settings-choice active'
                      : 'settings-choice'
                  }
                >
                  <input
                    type="radio"
                    name="vault-lock-behavior"
                    value="lock-on-reload"
                    checked={lockBehavior === 'lock-on-reload'}
                    disabled={lockBusy || submitting}
                    onChange={() => void changeLockBehavior('lock-on-reload')}
                  />
                  <span className="settings-choice-text">
                    <strong>{t('settings.security.vaultLock.lockOnReload.label')}</strong>
                    <span>{t('settings.security.vaultLock.lockOnReload.description')}</span>
                  </span>
                </label>
                <label
                  className={
                    lockBehavior === 'until-logout'
                      ? 'settings-choice active settings-choice-warning'
                      : 'settings-choice settings-choice-warning'
                  }
                >
                  <input
                    type="radio"
                    name="vault-lock-behavior"
                    value="until-logout"
                    checked={lockBehavior === 'until-logout'}
                    disabled={lockBusy || submitting}
                    onChange={() => void changeLockBehavior('until-logout')}
                  />
                  <span className="settings-choice-text">
                    <strong>{t('settings.security.vaultLock.untilLogout.label')}</strong>
                    <span>{t('settings.security.vaultLock.untilLogout.summary')}</span>
                  </span>
                </label>
                {lockBehavior === 'until-logout' && (
                  <div className="settings-vault-threats" role="note">
                    <p>
                      <strong>{t('settings.security.vaultLock.untilLogout.threatsTitle')}</strong>
                    </p>
                    <p>{t('settings.security.vaultLock.untilLogout.warningLead')}</p>
                    <ul>
                      <li>{t('settings.security.vaultLock.untilLogout.threatPhysical')}</li>
                      <li>{t('settings.security.vaultLock.untilLogout.threatXss')}</li>
                      <li>{t('settings.security.vaultLock.untilLogout.threatExtensions')}</li>
                      <li>{t('settings.security.vaultLock.untilLogout.threatForensics')}</li>
                      <li>{t('settings.security.vaultLock.untilLogout.threatShared')}</li>
                      <li>{t('settings.security.vaultLock.untilLogout.threatTabs')}</li>
                    </ul>
                    <p>{t('settings.security.vaultLock.untilLogout.clearsOnLogout')}</p>
                  </div>
                )}
                {lockError && (
                  <p className="inline-error" role="alert">
                    {lockError}
                  </p>
                )}
              </fieldset>
            </div>
          ) : section === 'password' ? (
              <form onSubmit={(event) => void submitPasswordChange(event)} className="settings-form">
                <p>{t('settings.security.description')}</p>
                <label htmlFor={currentId}>{t('settings.security.currentPasswordLabel')}</label>
              <input
                id={currentId}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={submitting}
              />
              <label htmlFor={nextId}>{t('settings.security.newPasswordLabel')}</label>
              <input
                id={nextId}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={submitting}
              />
              <label htmlFor={confirmId}>{t('settings.security.confirmPasswordLabel')}</label>
              <input
                id={confirmId}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
              />
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              <div className="import-actions">
                <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
                  {t('common.actions.cancel')}
                </button>
                <button type="submit" className="primary-button" disabled={submitting}>
                  {submitting ? <LoaderCircle className="spin" /> : <KeyRound />}
                  {t('settings.security.submit')}
                </button>
              </div>
            </form>
          ) : section === 'language' ? (
            <div className="settings-form">
              <p>{t('settings.language.hint')}</p>
              <label htmlFor={languageId}>{t('settings.language.title')}</label>
              <div className="settings-language-field">
                <Globe aria-hidden="true" />
                <select
                  id={languageId}
                  value={languagePreference}
                  onChange={(event) => changeLanguage(event.target.value as LanguagePreference)}
                >
                  <option value="auto">{t('settings.language.auto')}</option>
                  <option value="en">{t('settings.language.en')}</option>
                  <option value="pl">{t('settings.language.pl')}</option>
                </select>
              </div>
              <div className="import-actions">
                <button type="button" className="secondary-button" onClick={onClose}>
                  {t('common.actions.done')}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={(event) => void submitAccountDeletion(event)} className="settings-form danger-zone">
              <div>
                <span className="eyebrow">{t('settings.account.dangerZoneEyebrow')}</span>
                <h3>{t('settings.account.deleteTitle')}</h3>
                <p>{deletedAccountRetentionCopy()}</p>
              </div>
              <label htmlFor={deletePasswordId}>{t('settings.account.passwordLabel')}</label>
              <input
                id={deletePasswordId}
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                disabled={submitting}
              />
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              <div className="import-actions">
                <button type="submit" className="danger-button" disabled={submitting}>
                  {submitting ? <LoaderCircle className="spin" /> : <Trash2 />}
                  {t('settings.account.submit')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  )
}
