import { CheckCircle2, KeyRound, LoaderCircle, MailWarning } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { errorMessage } from './utils'

interface EmailVerifyPageProps {
  token: string | null
  onDone?: () => void
}

export function EmailVerifyPage({ token, onDone }: EmailVerifyPageProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'idle' | 'verifying' | 'success' | 'error'>(
    token ? 'verifying' : 'error',
  )
  const [message, setMessage] = useState(
    token ? t('auth.verify.verifyingMessage') : t('auth.verify.missingTokenMessage'),
  )

  useEffect(() => {
    if (!token) {
      setMessage(t('auth.verify.missingTokenMessage'))
      return
    }
    const controller = new AbortController()
    setStatus('verifying')
    setMessage(t('auth.verify.verifyingMessage'))
    api
      .verifyEmail(token, controller.signal)
      .then(() => {
        setStatus('success')
        setMessage(t('auth.verify.successMessage'))
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setStatus('error')
        setMessage(errorMessage(reason))
      })
    return () => controller.abort()
  }, [token, t])

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="verify-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <KeyRound />
          </span>
          <span>{t('common.appName')}</span>
        </div>
        <div className="login-copy">
          <span className="eyebrow">{t('auth.verify.eyebrow')}</span>
          <h1 id="verify-heading">
            {status === 'success'
              ? t('auth.verify.successTitle')
              : status === 'error'
                ? t('auth.verify.errorTitle')
                : t('auth.verify.verifyingTitle')}
          </h1>
          <p>{message}</p>
        </div>
        <div className="email-verify-status" role="status">
          {status === 'verifying' && <LoaderCircle className="spin" aria-hidden="true" />}
          {status === 'success' && <CheckCircle2 aria-hidden="true" />}
          {status === 'error' && <MailWarning aria-hidden="true" />}
        </div>
        {(status === 'success' || status === 'error') && (
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (onDone) {
                onDone()
                return
              }
              window.history.replaceState({}, '', '/')
              window.location.assign('/')
            }}
          >
            {t('auth.verify.continue')}
          </button>
        )}
      </section>
    </main>
  )
}
