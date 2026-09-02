import { KeyRound, LoaderCircle, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DELETED_USER_RETENTION_DAYS, deletedAccountRetentionCopy } from './accountRetention'
import { api } from './api'
import { errorMessage } from './utils'
import { useVault } from './vault/VaultContext'

interface UserSettingsDialogProps {
  onClose: () => void
  onPasswordChanged: () => void
  onAccountDeleted: () => void
}

type SettingsSection = 'password' | 'account'

export function UserSettingsDialog({
  onClose,
  onPasswordChanged,
  onAccountDeleted,
}: UserSettingsDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { clearLocalVaultAccess, rewrapForNewPassword } = useVault()
  const currentId = useId()
  const nextId = useId()
  const confirmId = useId()
  const deletePasswordId = useId()
  const [section, setSection] = useState<SettingsSection>('password')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
      await clearLocalVaultAccess()
      onAccountDeleted()
    } catch (reason) {
      setError(errorMessage(reason))
      setSubmitting(false)
    }
  }

  function goToSection(next: SettingsSection) {
    setSection(next)
    setError('')
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
              className={section === 'password' ? 'active' : ''}
              aria-current={section === 'password' ? 'page' : undefined}
              onClick={() => goToSection('password')}
            >
              {t('settings.nav.password')}
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

          {section === 'password' ? (
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
