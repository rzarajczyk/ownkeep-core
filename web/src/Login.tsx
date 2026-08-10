import { KeyRound, LoaderCircle, LockKeyhole } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from './utils'

interface LoginProps {
  onLogin: (email: string, password: string, signal: AbortSignal) => Promise<void>
  onBack?: () => void
  /** When true, omit the outer page chrome (useful for hosted shells). */
  embedded?: boolean
  banner?: string
}

export function Login({ onLogin, onBack, embedded = false, banner }: LoginProps) {
  const { t } = useTranslation()
  const emailId = useId()
  const passwordId = useId()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError(t('auth.login.missingFields'))
      return
    }
    const controller = new AbortController()
    setSubmitting(true)
    setError('')
    try {
      await onLogin(email.trim(), password, controller.signal)
    } catch (reason) {
      setError(errorMessage(reason))
      setSubmitting(false)
    }
  }

  const form = (
    <>
      {onBack && (
        <button type="button" className="landing-back" onClick={onBack} disabled={submitting}>
          {t('auth.login.back')}
        </button>
      )}
      <div className={`login-copy${embedded ? ' login-copy--compact' : ''}`}>
        <span className="eyebrow">{t('auth.login.eyebrow')}</span>
        <h1 id="login-heading">{t('auth.login.heading')}</h1>
        <p>{t('auth.login.subtitle')}</p>
      </div>
      {banner && (
        <p className="form-error" role="status">
          {banner}
        </p>
      )}
      <form onSubmit={submit} className="login-form">
        <label htmlFor={emailId}>{t('auth.login.emailLabel')}</label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        <label htmlFor={passwordId}>{t('auth.login.passwordLabel')}</label>
        <div className="password-field">
          <LockKeyhole aria-hidden="true" />
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? <LoaderCircle className="spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
          {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </button>
      </form>
      <p className="privacy-note">{t('auth.login.privacyNote')}</p>
    </>
  )

  if (embedded) return <div className="login-embedded">{form}</div>

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <KeyRound />
          </span>
          <span>{t('common.appName')}</span>
        </div>
        {form}
      </section>
    </main>
  )
}
