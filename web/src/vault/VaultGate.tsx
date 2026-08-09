import { Check, Copy, Download, KeyRound, LoaderCircle, LockKeyhole, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { AuthSession, User } from '../types'
import { rewrapVaultForPassword } from '../crypto/vault'
import { errorMessage } from '../utils'
import { useVault } from './VaultContext'

/** Shown only once after first-time vault creation — login password is reused automatically. */
export function VaultSetup({
  passwordHint,
  onReady,
}: {
  passwordHint: string | null
  onReady: () => void | Promise<void>
}) {
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
      setError(err instanceof Error ? err.message : 'Could not enable encryption')
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
      'OwnKeep recovery key',
      '',
      recoveryKey,
      '',
      'Keep this file somewhere safe and private.',
      'This key cannot be viewed again in OwnKeep.',
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
          <p className="eyebrow">Your vault is ready</p>
          <h1 id="recovery-key-title">Save your recovery key</h1>
          <p className="recovery-key-intro">
            Use this key to regain access to your notes if an admin resets your password.
          </p>
          <div className="recovery-key-warning" role="note">
            <ShieldAlert aria-hidden="true" />
            <p>
              <strong>You won&apos;t be able to see this key again.</strong>
              <span>Save it now and keep it somewhere safe and private.</span>
            </p>
          </div>
          <div className="recovery-key-field">
            <input
              type="text"
              className="recovery-key-input"
              value={recoveryKey}
              readOnly
              aria-label="Recovery key"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="recovery-key-copy"
              aria-label={copied ? 'Copied' : 'Copy recovery key'}
              title={copied ? 'Copied' : 'Copy recovery key'}
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
            Download key as file
          </button>
          <button type="button" className="primary-button vault-continue" onClick={() => void onReady()}>
            I saved it — continue
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
        <p>Setting up encryption…</p>
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
        <p className="eyebrow">Almost there</p>
        <h1 id="vault-setup-title">Continue signing in</h1>
        <p className="vault-unlock-intro">
          Enter your password to finish enabling encryption for your notes.
        </p>
        <form
          className="vault-unlock-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create(password)
          }}
        >
          <label>
            Password
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
            Continue
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
      setError('Enter your recovery key.')
      return
    }
    if (!password) {
      setError('Choose a new password.')
      return
    }
    if (password !== confirmation) {
      setError('Passwords do not match.')
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
          : 'Recovery key was rejected. Check the key and try again.',
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
        <p className="eyebrow">Account restored</p>
        <h1 id="restored-user-recovery-title">Recover your encrypted notes</h1>
        <p className="recovery-complete-intro">
          Signed in as <strong>{user.email}</strong>. Enter the recovery key you saved when
          your vault was created, then choose a new password.
        </p>
        <div className="recovery-key-warning" role="note">
          <ShieldAlert aria-hidden="true" />
          <p>
            <strong>Your recovery key stays in this browser.</strong>
            <span>Only a newly encrypted vault wrap is sent to OwnKeep.</span>
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
            Recovery key
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
            New password
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
            Confirm new password
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
            {busy ? 'Recovering…' : 'Recover account'}
          </button>
          <button type="button" className="recovery-cancel" onClick={onCancel} disabled={busy}>
            Cancel and sign out
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
  const { unlockWithPassword, unlockWithRecovery, installPasswordWrap } = useVault()
  const needsRecovery = user.vault.needsRecoveryUnlock
  const [password, setPassword] = useState(needsRecovery ? '' : (passwordHint ?? ''))
  const [recoveryKey, setRecoveryKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(!needsRecovery && Boolean(passwordHint))
  const autoTried = useRef(false)

  async function unlockWith(passwordValue: string, recoveryValue?: string) {
    setBusy(true)
    setError(null)
    try {
      if (needsRecovery) {
        const vaultKey = await unlockWithRecovery((recoveryValue ?? recoveryKey).trim(), user.vault)
        if (!passwordValue) throw new Error('Choose a new password')
        const wrapped = await rewrapVaultForPassword(vaultKey, passwordValue, user.vault)
        await installPasswordWrap(wrapped)
      } else {
        await unlockWithPassword(passwordValue, user.vault)
      }
      await onReady()
    } catch {
      setError(needsRecovery ? 'Recovery key or password was rejected' : 'Incorrect password')
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
        <p>Unlocking notes…</p>
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
        <p className="eyebrow">{needsRecovery ? 'Password reset' : 'Encrypted notes'}</p>
        <h1 id="vault-unlock-title">
          {needsRecovery ? 'Recover your vault' : 'Unlock your workspace'}
        </h1>
        <p className="vault-unlock-intro">
          {needsRecovery
            ? 'An admin reset your password. Enter your recovery key and choose a new password.'
            : (
              <>
                Signed in as <strong>{user.email}</strong>. Enter your password to decrypt
                your notes.
              </>
            )}
        </p>
        <form
          className="vault-unlock-form"
          onSubmit={(event) => {
            event.preventDefault()
            void unlockWith(password)
          }}
        >
          {needsRecovery ? (
            <label>
              Recovery key
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
            {needsRecovery ? 'New password' : 'Password'}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={needsRecovery ? 'new-password' : 'current-password'}
              required
              autoFocus={!needsRecovery}
            />
          </label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : needsRecovery ? <KeyRound aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            {busy ? 'Unlocking…' : needsRecovery ? 'Recover vault' : 'Unlock'}
          </button>
          <button type="button" className="secondary-button" onClick={() => void onLogout()}>
            Logout
          </button>
        </form>
      </section>
    </main>
  )
}
