import {
  Check,
  ChevronLeft,
  Copy,
  KeyRound,
  LoaderCircle,
  Mail,
  RotateCcw,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DELETED_USER_RETENTION_DAYS,
  softDeleteUserConfirmation,
} from './accountRetention'
import { api, ApiError } from './api'
import type { ManagedUser, User } from './types'
import { errorMessage } from './utils'

interface UserManagementDialogProps {
  currentUser: User
  onClose: () => void
}

function normalizeManagedUser(user: ManagedUser): ManagedUser {
  return {
    ...user,
    enabled: user.enabled !== false,
    emailVerified: user.emailVerified === true,
    recoveryPending: user.recoveryPending === true,
    canRestore: user.canRestore === true,
  }
}

function sortUsers(users: ManagedUser[]) {
  return users.map(normalizeManagedUser).sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.email.localeCompare(b.email),
  )
}

function permanentDeletionDeadline(deletedAt: string | null | undefined) {
  if (!deletedAt) return null
  const deletedAtTime = Date.parse(deletedAt)
  if (Number.isNaN(deletedAtTime)) return null
  return new Date(deletedAtTime + DELETED_USER_RETENTION_DAYS * 24 * 60 * 60 * 1000)
}

function formatCalendarDate(deadline: Date, language: string) {
  return deadline.toLocaleDateString(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function permanentDeletionStatus(
  deletedAt: string | null | undefined,
  now: number,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const deadline = permanentDeletionDeadline(deletedAt)
  if (!deadline) return null
  const remaining = deadline.getTime() - now
  const calendarDate = formatCalendarDate(deadline, language)
  if (remaining <= 0) return t('admin.restore.dueNow', { date: calendarDate })
  const hours = Math.ceil(remaining / (60 * 60 * 1000))
  if (hours < 24) {
    return t('admin.restore.inHours', { count: hours, date: calendarDate })
  }
  const days = Math.ceil(hours / 24)
  return t('admin.restore.inDays', { count: days, date: calendarDate })
}

export function UserManagementDialog({ currentUser, onClose }: UserManagementDialogProps) {
  const { t, i18n } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const emailId = useId()
  const passwordId = useId()
  const resetPasswordId = useId()
  const searchId = useId()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [view, setView] = useState<'list' | 'create' | 'reset'>('list')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [resetFor, setResetFor] = useState<ManagedUser | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [restoredCredentials, setRestoredCredentials] = useState<{
    email: string
    temporaryPassword: string
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? users.filter((user) => user.email.toLowerCase().includes(needle))
      : users
    return sortUsers(matches)
  }, [users, query])
  const activeUsers = filteredUsers.filter((user) => user.enabled)
  const deletedUsers = filteredUsers.filter((user) => !user.enabled)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api
      .listUsers(controller.signal)
      .then((loaded) => setUsers(sortUsers(loaded)))
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(errorMessage(reason))
        }
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  async function createUser(event: FormEvent) {
    event.preventDefault()
    setError('')
    setStatus('')
    if (!email.trim() || !password) {
      setError(t('admin.errors.missingCreateFields'))
      return
    }
    setCreating(true)
    try {
      const created = await api.createUser(email.trim(), password)
      setUsers((list) => sortUsers([...list, created]))
      setEmail('')
      setPassword('')
      setView('list')
      setStatus(t('admin.status.userAdded', { email: created.email }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setCreating(false)
    }
  }

  async function deleteUser(user: ManagedUser) {
    if (!window.confirm(softDeleteUserConfirmation(user.email))) return
    setBusyId(user.id)
    setError('')
    setStatus('')
    try {
      const deleted = await api.deleteUser(user.id)
      setUsers((list) =>
        sortUsers(
          list.map((entry) =>
            entry.id === user.id
              ? deleted
              : entry,
          ),
        ),
      )
      setStatus(t('admin.status.userDeleted', { email: user.email }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function restoreUser(user: ManagedUser) {
    const deadline = permanentDeletionDeadline(user.deletedAt)
    if (!user.canRestore || (deadline && deadline.getTime() <= Date.now())) return
    setBusyId(user.id)
    setError('')
    setStatus('')
    setRestoredCredentials(null)
    setCopied(false)
    try {
      const restored = await api.restoreUser(user.id)
      setUsers((list) =>
        sortUsers(
          list.map((entry) => (entry.id === user.id ? restored.user : entry)),
        ),
      )
      setRestoredCredentials({
        email: restored.user.email,
        temporaryPassword: restored.temporaryPassword,
      })
      setStatus(t('admin.status.userRestored', { email: restored.user.email }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function permanentlyDeleteUser(user: ManagedUser) {
    const confirmed = window.confirm(
      t('admin.confirm.permanentDelete', {
        email: user.email,
        days: DELETED_USER_RETENTION_DAYS,
      }),
    )
    if (!confirmed) return
    setBusyId(user.id)
    setError('')
    setStatus('')
    try {
      await api.permanentlyDeleteUser(user.id)
      setUsers((list) => list.filter((entry) => entry.id !== user.id))
      setStatus(t('admin.status.userPermanentlyDeleted', { email: user.email }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function resendVerification(user: ManagedUser) {
    setBusyId(user.id)
    setError('')
    setStatus('')
    try {
      try {
        await api.resendUserVerification(user.id)
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) {
          await api.resendVerification(user.email)
        } else {
          throw reason
        }
      }
      setStatus(t('admin.status.verificationSent', { email: user.email }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(null)
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault()
    if (!resetFor) return
    setError('')
    setStatus('')
    if (!resetPassword) {
      setError(t('admin.errors.missingResetPassword'))
      return
    }
    setBusyId(resetFor.id)
    try {
      await api.resetUserPassword(resetFor.id, resetPassword)
      const resetEmail = resetFor.email
      setResetFor(null)
      setResetPassword('')
      setView('list')
      setStatus(t('admin.status.passwordUpdated', { email: resetEmail }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(null)
    }
  }

  function renderUserRow(user: ManagedUser) {
    const isCurrentUser = user.id === currentUser.id
    const canManageActive = user.enabled && !isCurrentUser && user.role !== 'ADMIN'
    const restoreExplanationId = `restore-explanation-${user.id}`
    const deletionStatusId = `deletion-status-${user.id}`
    const showResend =
      user.enabled && !user.emailVerified && !isCurrentUser && user.role !== 'ADMIN'
    const deletionStatus = permanentDeletionStatus(user.deletedAt, now, i18n.language, t)
    const deletionDeadline = permanentDeletionDeadline(user.deletedAt)
    const restoreAllowed =
      user.canRestore && (!deletionDeadline || deletionDeadline.getTime() > now)
    const restorationNote =
      deletionDeadline && deletionDeadline.getTime() <= now
        ? t('admin.restore.unavailableNote')
        : t('admin.restore.availableNote')

    return (
      <li key={user.id} className={user.enabled ? undefined : 'user-row-deleted'}>
        <div className="user-identity">
          <span className="user-avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user.email}</strong>
            <span className="user-meta">
              {user.role === 'ADMIN' ? t('admin.roles.admin') : t('admin.roles.user')}
              {isCurrentUser && <span className="user-you">{t('admin.roles.you')}</span>}
              {!user.enabled && (
                <span className="user-state user-state-deleted">{t('admin.states.deleted')}</span>
              )}
              {user.enabled && (
                <span
                  className={`user-state ${user.emailVerified ? 'user-state-verified' : 'user-state-pending'}`}
                >
                  {user.emailVerified ? t('admin.states.verified') : t('admin.states.pending')}
                </span>
              )}
              {user.enabled && user.recoveryPending && (
                <span className="user-state user-state-recovery">{t('admin.states.recoveryPending')}</span>
              )}
            </span>
            {!user.enabled && !user.canRestore && (
              <span id={restoreExplanationId} className="user-restore-explanation">
                {t('admin.restore.unavailableNoKey')}
              </span>
            )}
            {!user.enabled && deletionStatus && (
              <span id={deletionStatusId} className="user-deletion-countdown">
                {deletionStatus} {restorationNote}
              </span>
            )}
          </div>
        </div>
        {canManageActive && (
          <div className="user-actions">
            {showResend && (
              <button
                type="button"
                className="secondary-button"
                disabled={busyId === user.id}
                onClick={() => void resendVerification(user)}
              >
                {busyId === user.id ? <LoaderCircle className="spin" /> : <Mail />}
                {t('admin.actions.resendVerification')}
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={busyId === user.id}
              onClick={() => {
                setResetFor(user)
                setResetPassword('')
                setView('reset')
                setError('')
                setStatus('')
              }}
            >
              <KeyRound /> {t('admin.actions.resetPassword')}
            </button>
            <button
              type="button"
              className="icon-button danger"
              aria-label={t('admin.actions.delete', { email: user.email })}
              title={t('admin.actions.delete', { email: user.email })}
              disabled={busyId === user.id}
              onClick={() => void deleteUser(user)}
            >
              {busyId === user.id ? <LoaderCircle className="spin" /> : <Trash2 />}
            </button>
          </div>
        )}
        {!user.enabled && (
          <div className="user-actions user-deleted-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busyId === user.id || !restoreAllowed}
              aria-describedby={
                !restoreAllowed
                  ? !user.canRestore
                    ? restoreExplanationId
                    : deletionStatus
                      ? deletionStatusId
                      : undefined
                  : undefined
              }
              title={
                !user.canRestore
                  ? t('admin.restore.noKeyTitle')
                  : !restoreAllowed
                    ? t('admin.restore.pastDeadlineTitle')
                  : deletionDeadline
                    ? t('admin.restore.restoreBeforeTitle', {
                        date: formatCalendarDate(deletionDeadline, i18n.language),
                      })
                    : undefined
              }
              onClick={() => void restoreUser(user)}
            >
              {busyId === user.id ? <LoaderCircle className="spin" /> : <RotateCcw />}
              {t('admin.actions.restore')}
            </button>
            <button
              type="button"
              className="icon-button danger"
              aria-label={t('admin.actions.permanentlyDelete', { email: user.email })}
              title={t('admin.actions.permanentlyDelete', { email: user.email })}
              disabled={busyId === user.id}
              onClick={() => void permanentlyDeleteUser(user)}
            >
              {busyId === user.id ? <LoaderCircle className="spin" /> : <Trash2 />}
            </button>
          </div>
        )}
      </li>
    )
  }

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog users-dialog"
      aria-labelledby="user-management-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="import-panel">
        <header className="import-header">
          <div>
            <span className="eyebrow">{t('admin.eyebrow')}</span>
            <h2 id="user-management-title">{t('admin.title')}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('admin.close')}>
            <X />
          </button>
        </header>

        {view === 'list' ? (
          <section className="users-view" aria-label={t('admin.toolbar.heading')}>
            <div className="users-toolbar">
              <div>
                <h3>{t('admin.toolbar.heading')}</h3>
                <p>
                  {loading
                    ? t('admin.toolbar.loading')
                    : t('admin.toolbar.accountsCount', { count: users.length })}
                </p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setView('create')
                  setError('')
                  setStatus('')
                }}
              >
                <UserPlus aria-hidden="true" /> {t('admin.toolbar.addUser')}
              </button>
            </div>

            <label className="users-search" htmlFor={searchId}>
              <Search aria-hidden="true" />
              <input
                id={searchId}
                type="search"
                placeholder={t('admin.search.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={loading}
                autoComplete="off"
              />
            </label>

            {status && <p className="users-status" role="status">{status}</p>}
            {error && <p className="inline-error" role="alert">{error}</p>}
            {restoredCredentials && (
              <section className="restored-credentials" aria-labelledby="temporary-password-title">
                <div>
                  <span className="eyebrow">{t('admin.restoredCredentials.eyebrow')}</span>
                  <h4 id="temporary-password-title">
                    {t('admin.restoredCredentials.title', { email: restoredCredentials.email })}
                  </h4>
                  <p>{t('admin.restoredCredentials.description')}</p>
                </div>
                <div className="temporary-password-field">
                  <code>{restoredCredentials.temporaryPassword}</code>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(restoredCredentials.temporaryPassword)
                      setCopied(true)
                    }}
                    aria-label={
                      copied
                        ? t('admin.restoredCredentials.copiedAria')
                        : t('admin.restoredCredentials.copyAria')
                    }
                  >
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied
                      ? t('admin.restoredCredentials.copied')
                      : t('admin.restoredCredentials.copy')}
                  </button>
                </div>
                <button
                  type="button"
                  className="restored-credentials-dismiss"
                  onClick={() => {
                    setRestoredCredentials(null)
                    setCopied(false)
                  }}
                >
                  {t('admin.restoredCredentials.dismiss')}
                </button>
              </section>
            )}

            {loading ? (
              <div className="users-loading" role="status">
                <LoaderCircle className="spin" />
                {t('admin.toolbar.loading')}
              </div>
            ) : (
              <div className="users-list-scroll">
                {filteredUsers.length === 0 ? (
                  <p className="users-empty">
                    {users.length === 0 ? t('admin.empty.noUsers') : t('admin.empty.noMatches')}
                  </p>
                ) : (
                  <>
                    {activeUsers.length > 0 && (
                      <ul className="users-list users-list-active" aria-label={t('admin.toolbar.activeUsers')}>
                        {activeUsers.map(renderUserRow)}
                      </ul>
                    )}
                    {deletedUsers.length > 0 && (
                      <section className="users-deleted-group" aria-labelledby="deleted-users-title">
                        <div className="users-group-heading">
                          <h4 id="deleted-users-title">{t('admin.deletedGroup.title')}</h4>
                          <span>{deletedUsers.length}</span>
                        </div>
                        <ul className="users-list users-list-deleted">
                          {deletedUsers.map(renderUserRow)}
                        </ul>
                      </section>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="users-form-view">
            <button
              type="button"
              className="users-back"
              onClick={() => {
                setView('list')
                setResetFor(null)
                setError('')
              }}
              disabled={creating || busyId !== null}
            >
              <ChevronLeft aria-hidden="true" /> {t('admin.back')}
            </button>

            {view === 'create' ? (
              <form className="settings-form users-task-form" onSubmit={(event) => void createUser(event)}>
                <span className="users-task-icon"><UserPlus aria-hidden="true" /></span>
                <h3>{t('admin.createUser.title')}</h3>
                <p>{t('admin.createUser.description')}</p>
                <label htmlFor={emailId}>{t('admin.createUser.emailLabel')}</label>
                <input
                  id={emailId}
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={creating}
                  autoFocus
                />
                <label htmlFor={passwordId}>{t('admin.createUser.passwordLabel')}</label>
                <input
                  id={passwordId}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={creating}
                />
                {error && <p className="inline-error" role="alert">{error}</p>}
                <div className="import-actions">
                  <button type="submit" className="primary-button" disabled={creating}>
                    {creating ? <LoaderCircle className="spin" /> : <Users />}
                    {t('admin.createUser.submit')}
                  </button>
                </div>
              </form>
            ) : resetFor ? (
              <form className="settings-form users-task-form" onSubmit={(event) => void submitReset(event)}>
                <span className="users-task-icon"><KeyRound aria-hidden="true" /></span>
                <h3>{t('admin.resetPassword.title')}</h3>
                <p>{t('admin.resetPassword.description', { email: resetFor.email })}</p>
                <label htmlFor={resetPasswordId}>{t('admin.resetPassword.newPasswordLabel')}</label>
                <input
                  id={resetPasswordId}
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                  disabled={busyId === resetFor.id}
                  autoFocus
                />
                {error && <p className="inline-error" role="alert">{error}</p>}
                <div className="import-actions">
                  <button type="submit" className="primary-button" disabled={busyId === resetFor.id}>
                    {busyId === resetFor.id ? <LoaderCircle className="spin" /> : <KeyRound />}
                    {t('admin.resetPassword.submit')}
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        )}
      </div>
    </dialog>
  )
}
