import { KeyRound, LoaderCircle, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { DELETED_USER_RETENTION_DAYS, deletedAccountRetentionCopy } from './accountRetention'
import { api } from './api'
import { errorMessage } from './utils'
import { useVault } from './vault/VaultContext'

interface UserSettingsDialogProps {
  onClose: () => void
  onPasswordChanged: () => void
  onAccountDeleted: () => void
}

export function UserSettingsDialog({
  onClose,
  onPasswordChanged,
  onAccountDeleted,
}: UserSettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { rewrapForNewPassword } = useVault()
  const currentId = useId()
  const nextId = useId()
  const confirmId = useId()
  const deletePasswordId = useId()
  const [section, setSection] = useState<'security' | 'account'>('security')
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
      setError('Enter your current and new password.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.')
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
      setError('Enter your password to delete your account.')
      return
    }
    const confirmed = window.confirm(
      `Delete your account?\n\nAn administrator can restore it for ${DELETED_USER_RETENTION_DAYS} days, but you will have to provide the restore code to unlock your notes. After that, your account and data are permanently deleted and cannot be restored.`,
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
            <span className="eyebrow">Account</span>
            <h2 id="user-settings-title">User settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-section-nav" aria-label="Settings sections">
            <button
              type="button"
              className={section === 'security' ? 'active' : ''}
              aria-current={section === 'security' ? 'page' : undefined}
              onClick={() => {
                setSection('security')
                setError('')
              }}
            >
              Security
            </button>
            <button
              type="button"
              className={section === 'account' ? 'active' : ''}
              aria-current={section === 'account' ? 'page' : undefined}
              onClick={() => {
                setSection('account')
                setError('')
              }}
            >
              Account
            </button>
          </nav>

          {section === 'security' ? (
            <form onSubmit={(event) => void submitPasswordChange(event)} className="settings-form">
              <p>Change your password. You will be signed out after a successful update.</p>
              <label htmlFor={currentId}>Current password</label>
              <input
                id={currentId}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={submitting}
              />
              <label htmlFor={nextId}>New password</label>
              <input
                id={nextId}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={submitting}
              />
              <label htmlFor={confirmId}>Confirm new password</label>
              <input
                id={confirmId}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
              />
              {error && <p className="inline-error" role="alert">{error}</p>}
              <div className="import-actions">
                <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={submitting}>
                  {submitting ? <LoaderCircle className="spin" /> : <KeyRound />}
                  Update password
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={(event) => void submitAccountDeletion(event)} className="settings-form danger-zone">
              <div>
                <span className="eyebrow">Danger zone</span>
                <h3>Delete account</h3>
                <p>{deletedAccountRetentionCopy}</p>
              </div>
              <label htmlFor={deletePasswordId}>Password</label>
              <input
                id={deletePasswordId}
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                disabled={submitting}
              />
              {error && <p className="inline-error" role="alert">{error}</p>}
              <div className="import-actions">
                <button type="submit" className="danger-button" disabled={submitting}>
                  {submitting ? <LoaderCircle className="spin" /> : <Trash2 />}
                  Delete account
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  )
}
