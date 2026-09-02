import { Check, Copy, Download, Fingerprint, KeyRound, LoaderCircle, LockKeyhole, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '../api'
import type { AuthSession, User } from '../types'
import { rewrapVaultForPassword } from '../crypto/vault'
import { errorMessage } from '../utils'
import { DeviceUnlockError } from './deviceUnlock'
import { useVault } from './VaultContext'

/** Shown only once after first-time vault creation — login password is reused automatically. */
export function VaultSetup({
  passwordHint,
  onReady,
}: {
  passwordHint: string | null
  onReady: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const { setupVault } = useVault()
  const [password, setPassword] = useState('')
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(Boolean(passwordHint))
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  async function create(passwordValue: string) {
    setBusy(true)
    setError(null)
    try {
      const key = await setupVault(passwordValue)
      setRecoveryKey(key)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('vault.setup.error'))
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!passwordHint || started.current) return
    started.current = true
    void create(passwordHint)
  }, [passwordHint])

  function downloadRecoveryKey() {
    if (!recoveryKey) return

    const contents = [
      t('vault.recoveryKey.downloadFileIntro'),
      '',
      recoveryKey,
      '',
      t('vault.recoveryKey.downloadFileNote'),
      t('vault.recoveryKey.downloadFileNote2'),
    ].join('\n')
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'ownkeep-recovery-key.txt'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  if (recoveryKey) {
    return (
      <main className="boot-screen vault-gate recovery-key-screen">
        <section className="recovery-key-card" aria-labelledby="recovery-key-title">
          <span className="recovery-key-icon" aria-hidden="true">
            <KeyRound />
          </span>
          <p className="eyebrow">{t('vault.recoveryKey.eyebrow')}</p>
          <h1 id="recovery-key-title">{t('vault.recoveryKey.title')}</h1>
          <p className="recovery-key-intro">
            {t('vault.recoveryKey.intro')}
          </p>
          <div className="recovery-key-warning" role="note">
            <ShieldAlert aria-hidden="true" />
            <p>
              <strong>{t('vault.recoveryKey.warningStrong')}</strong>
              <span>{t('vault.recoveryKey.warningBody')}</span>
            </p>
          </div>
          <div className="recovery-key-field">
            <input
              type="text"
              className="recovery-key-input"
              value={recoveryKey}
              readOnly
              aria-label={t('vault.recoveryKey.inputLabel')}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="recovery-key-copy"
              aria-label={copied ? t('vault.recoveryKey.copiedLabel') : t('vault.recoveryKey.copyLabel')}
              title={copied ? t('vault.recoveryKey.copiedLabel') : t('vault.recoveryKey.copyLabel')}
              onClick={async () => {
                await navigator.clipboard.writeText(recoveryKey)
                setCopied(true)
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </div>
          <button type="button" className="secondary-button recovery-key-download" onClick={downloadRecoveryKey}>
            <Download aria-hidden="true" />
            {t('vault.recoveryKey.downloadButton')}
          </button>
          <button type="button" className="primary-button vault-continue" onClick={() => void onReady()}>
            {t('vault.recoveryKey.continueButton')}
          </button>
        </section>
      </main>
    )
  }

  if (passwordHint || busy) {
    return (
      <main className="boot-screen" role="status">
        <span className="brand-mark">
          <LoaderCircle className="spin" />
        </span>
        <p>{t('vault.setup.settingUp')}</p>
        {error ? <p className="error">{error}</p> : null}
      </main>
    )
  }

  // Session restored before vault init (no password in memory) — ask once, same login password.
  return (
    <main className="boot-screen vault-unlock-screen">
      <section className="vault-unlock-card" aria-labelledby="vault-setup-title">
        <span className="recovery-key-icon" aria-hidden="true">
          <LockKeyhole />
        </span>
        <p className="eyebrow">{t('vault.setup.continueEyebrow')}</p>
        <h1 id="vault-setup-title">{t('vault.setup.continueTitle')}</h1>
        <p className="vault-unlock-intro">
          {t('vault.setup.continueIntro')}
        </p>
        <form
          className="vault-unlock-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create(password)
          }}
        >
          <label>
            {t('vault.setup.passwordLabel')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={busy || !password}>
            {t('vault.setup.continueButton')}
          </button>
        </form>
      </section>
    </main>
  )
}

export function RestoredUserRecovery({
  user,
  onComplete,
  onCancel,
}: {
  user: User
  onComplete: (session: AuthSession) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const { unlockWithRecovery } = useVault()
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function completeRecovery() {
    const trimmedRecoveryKey = recoveryKey.trim()
    setError(null)
    if (!trimmedRecoveryKey) {
      setError(t('vault.restore.errors.missingRecoveryKey'))
      return
    }
    if (!password) {
      setError(t('vault.restore.errors.missingPassword'))
      return
    }
    if (password !== confirmation) {
      setError(t('vault.restore.errors.passwordMismatch'))
      return
    }

    setBusy(true)
    try {
      const vaultKey = await unlockWithRecovery(trimmedRecoveryKey, user.vault)
      const wrappedVaultKey = await rewrapVaultForPassword(vaultKey, password, user.vault)
      const session = await api.completeRecovery(password, wrappedVaultKey)
      onComplete(session)
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? errorMessage(reason)
          : t('vault.restore.errors.rejected'),
      )
      setBusy(false)
    }
  }

  return (
    <main className="boot-screen recovery-complete-screen">
      <section className="recovery-complete-card" aria-labelledby="restored-user-recovery-title">
        <span className="recovery-key-icon" aria-hidden="true">
          <KeyRound />
        </span>
        <p className="eyebrow">{t('vault.restore.eyebrow')}</p>
        <h1 id="restored-user-recovery-title">{t('vault.restore.title')}</h1>
        <p className="recovery-complete-intro">
          {t('vault.restore.intro', { email: user.email })}
        </p>
        <div className="recovery-key-warning" role="note">
          <ShieldAlert aria-hidden="true" />
          <p>
            <strong>{t('vault.restore.warningStrong')}</strong>
            <span>{t('vault.restore.warningBody')}</span>
          </p>
        </div>
        <form
          className="recovery-complete-form"
          onSubmit={(event) => {
            event.preventDefault()
            void completeRecovery()
          }}
        >
          <label>
            {t('vault.restore.recoveryKeyLabel')}
            <input
              type="text"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              autoFocus
              required
            />
          </label>
          <label>
            {t('vault.restore.newPasswordLabel')}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={busy}
              required
            />
          </label>
          <label>
            {t('vault.restore.confirmPasswordLabel')}
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              disabled={busy}
              required
            />
          </label>
          {error ? <p className="inline-error recovery-complete-error" role="alert">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
            {busy ? t('vault.restore.recoveringButton') : t('vault.restore.recoverButton')}
          </button>
          <button type="button" className="recovery-cancel" onClick={onCancel} disabled={busy}>
            {t('vault.restore.cancelButton')}
          </button>
        </form>
      </section>
    </main>
  )
}

export function VaultUnlock({
  user,
  passwordHint,
  onLogout,
  onReady,
}: {
  user: User
  passwordHint: string | null
  onLogout: () => Promise<void>
  onReady: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const {
    deviceUnlockAvailability,
    deviceUnlockEnrolled,
    installPasswordWrap,
    unlockMode,
    unlockWithDevice,
    unlockWithPassword,
    unlockWithRecovery,
  } = useVault()
  const needsRecovery = user.vault.needsRecoveryUnlock
  const canUseDevice =
    !needsRecovery &&
    unlockMode === 'device-verification' &&
    deviceUnlockAvailability === 'available' &&
    deviceUnlockEnrolled
  const [password, setPassword] = useState(needsRecovery ? '' : (passwordHint ?? ''))
  const [recoveryKey, setRecoveryKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(!needsRecovery && Boolean(passwordHint))
  const [showPassword, setShowPassword] = useState(needsRecovery || !canUseDevice)
  const autoTried = useRef(false)

  async function unlockWith(passwordValue: string, recoveryValue?: string) {
    setBusy(true)
    setError(null)
    try {
      if (needsRecovery) {
        const vaultKey = await unlockWithRecovery((recoveryValue ?? recoveryKey).trim(), user.vault)
        if (!passwordValue) throw new Error(t('vault.unlock.missingNewPassword'))
        const wrapped = await rewrapVaultForPassword(vaultKey, passwordValue, user.vault)
        await installPasswordWrap(wrapped)
      } else {
        await unlockWithPassword(passwordValue, user.vault)
      }
      await onReady()
    } catch {
      setError(needsRecovery ? t('vault.unlock.needsRecoveryError') : t('vault.unlock.error'))
      setBusy(false)
    }
  }

  async function unlockUsingDevice() {
    setBusy(true)
    setError(null)
    try {
      await unlockWithDevice()
      await onReady()
    } catch (reason) {
      const canceled = reason instanceof DeviceUnlockError && reason.code === 'cancelled'
      setError(
        canceled
          ? t('vault.unlock.deviceCanceled')
          : t('vault.unlock.deviceError'),
      )
      if (!canceled) setShowPassword(true)
      setBusy(false)
    }
  }

  useEffect(() => {
    if (needsRecovery || !passwordHint || autoTried.current) return
    autoTried.current = true
    void unlockWith(passwordHint)
  }, [needsRecovery, passwordHint])

  if (!needsRecovery && passwordHint && busy && !error) {
    return (
      <main className="boot-screen" role="status">
        <span className="brand-mark">
          <LoaderCircle className="spin" />
        </span>
        <p>{t('vault.unlock.unlocking')}</p>
      </main>
    )
  }

  return (
    <main className="boot-screen vault-unlock-screen">
      <section
        className="vault-unlock-card"
        aria-labelledby="vault-unlock-title"
      >
        <span className="recovery-key-icon" aria-hidden="true">
          {needsRecovery ? <KeyRound /> : <LockKeyhole />}
        </span>
        <p className="eyebrow">
          {needsRecovery ? t('vault.unlock.needsRecoveryEyebrow') : t('vault.unlock.eyebrow')}
        </p>
        <h1 id="vault-unlock-title">
          {needsRecovery ? t('vault.unlock.needsRecoveryTitle') : t('vault.unlock.title')}
        </h1>
        <p className="vault-unlock-intro">
          {needsRecovery
            ? t('vault.unlock.needsRecoveryIntro')
            : canUseDevice
              ? t('vault.unlock.deviceIntro', { email: user.email })
              : t('vault.unlock.intro', { email: user.email })}
        </p>
        {!needsRecovery && unlockMode === 'device-verification' && !deviceUnlockEnrolled && (
          <p className="vault-device-missing" role="status">
            {t('vault.unlock.deviceMissing')}
          </p>
        )}
        {!needsRecovery &&
          unlockMode === 'device-verification' &&
          deviceUnlockEnrolled &&
          deviceUnlockAvailability !== 'available' && (
            <p className="vault-device-missing" role="status">
              {t('vault.unlock.deviceUnavailable')}
            </p>
          )}
        {canUseDevice && !showPassword && (
          <div className="vault-device-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void unlockUsingDevice()}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
              {busy ? t('vault.unlock.deviceUnlockingButton') : t('vault.unlock.deviceUnlockButton')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setError(null)
                setShowPassword(true)
              }}
            >
              {t('vault.unlock.usePasswordButton')}
            </button>
          </div>
        )}
        {(showPassword || needsRecovery) && (
          <form
            className="vault-unlock-form"
            onSubmit={(event) => {
              event.preventDefault()
              void unlockWith(password)
            }}
          >
            {needsRecovery ? (
              <label>
                {t('vault.unlock.recoveryKeyLabel')}
                <input
                  type="text"
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            ) : null}
            <label>
              {needsRecovery ? t('vault.unlock.newPasswordLabel') : t('vault.unlock.passwordLabel')}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={needsRecovery ? 'new-password' : 'current-password'}
                required
                autoFocus={!needsRecovery}
              />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : needsRecovery ? <KeyRound aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
              {busy
                ? needsRecovery
                  ? t('vault.unlock.recoveringButton')
                  : t('vault.unlock.unlockingButton')
                : needsRecovery
                  ? t('vault.unlock.recoverButton')
                  : t('vault.unlock.unlockButton')}
            </button>
          </form>
        )}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="button" className="secondary-button" onClick={() => void onLogout()} disabled={busy}>
          {t('vault.unlock.logoutButton')}
        </button>
      </section>
    </main>
  )
}
