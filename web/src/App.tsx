import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './App.css'
import { api } from './api'
import { AppShell } from './AppShell'
import { EmailVerifyPage } from './EmailVerifyPage'
import { bootstrapI18n } from './i18n'
import { Login } from './Login'
import type { AuthSession, User } from './types'
import { VaultProvider, useVault, vaultNeedsSetup } from './vault/VaultContext'
import { RestoredUserRecovery, VaultSetup, VaultUnlock } from './vault/VaultGate'

bootstrapI18n()

const TOKEN_KEY = 'ownkeep.auth'

function readStoredSession(): AuthSession | null {
  try {
    const value = localStorage.getItem(TOKEN_KEY)
    if (!value) return null
    const session = JSON.parse(value) as AuthSession
    if (!session.token || !session.user?.id) return null
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(TOKEN_KEY)
      return null
    }
    return { ...session, recoveryRequired: session.recoveryRequired === true }
  } catch {
    localStorage.removeItem(TOKEN_KEY)
    return null
  }
}

function isVerifyEmailPath() {
  return window.location.pathname.replace(/\/+$/, '') === '/verify-email'
}

function readVerifyToken() {
  return new URLSearchParams(window.location.search).get('token')
}

function AuthenticatedApp({
  session,
  passwordHint,
  onLogout,
  onSessionEnded,
  onUserUpdated,
}: {
  session: AuthSession
  passwordHint: string | null
  onLogout: () => Promise<void>
  onSessionEnded: () => void
  onUserUpdated: (user: User) => void
}) {
  const { isUnlocked, lock } = useVault()

  if (vaultNeedsSetup(session.user)) {
    return (
      <VaultSetup
        passwordHint={passwordHint}
        onReady={async () => {
          const user = await api.me()
          onUserUpdated(user)
        }}
      />
    )
  }

  if (!isUnlocked) {
    return (
      <VaultUnlock
        user={session.user}
        passwordHint={passwordHint}
        onLogout={onLogout}
        onReady={async () => {
          const user = await api.me()
          onUserUpdated(user)
        }}
      />
    )
  }

  return (
    <AppShell
      user={session.user}
      onLogout={async () => {
        lock()
        await onLogout()
      }}
      onSessionEnded={() => {
        lock()
        onSessionEnded()
      }}
    />
  )
}

function App() {
  const { t } = useTranslation()
  const [session, setSession] = useState<AuthSession | null>(() => readStoredSession())
  const [restoring, setRestoring] = useState(
    () => Boolean(session && !session.recoveryRequired),
  )
  const [passwordHint, setPasswordHint] = useState<string | null>(null)
  const [verifyRoute, setVerifyRoute] = useState(() => isVerifyEmailPath())

  const resetSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    api.setToken(null)
    setSession(null)
    setPasswordHint(null)
    setRestoring(false)
  }, [])

  useEffect(() => {
    api.onUnauthorized(resetSession)
    return () => api.onUnauthorized(null)
  }, [resetSession])

  useEffect(() => {
    const stored = readStoredSession()
    if (!stored) {
      setRestoring(false)
      return
    }
    api.setToken(stored.token)
    if (stored.recoveryRequired) {
      setSession(stored)
      setRestoring(false)
      return
    }
    const controller = new AbortController()
    api
      .me(controller.signal)
      .then((user: User) => {
        const next = { ...stored, user }
        localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
        setSession(next)
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) resetSession()
      })
      .finally(() => setRestoring(false))
    return () => controller.abort()
  }, [resetSession])

  async function login(email: string, password: string, signal: AbortSignal) {
    const next = await api.login(email, password, signal)
    api.setToken(next.token)
    localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    setPasswordHint(next.recoveryRequired ? null : password)
    setSession(next)
  }

  function completeRecovery(next: AuthSession) {
    api.setToken(next.token)
    localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    setPasswordHint(null)
    setSession(next)
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      resetSession()
    }
  }

  if (restoring) {
    return (
      <main className="boot-screen" role="status">
        <span className="brand-mark">
          <LoaderCircle className="spin" />
        </span>
        <p>{t('auth.boot.opening')}</p>
      </main>
    )
  }

  if (!session && verifyRoute) {
    return (
      <EmailVerifyPage
        token={readVerifyToken()}
        onDone={() => {
          window.history.replaceState({}, '', '/')
          setVerifyRoute(false)
        }}
      />
    )
  }

  if (!session) return <Login onLogin={login} />

  return (
    <VaultProvider>
      {session.recoveryRequired ? (
        <RestoredUserRecovery
          user={session.user}
          onComplete={completeRecovery}
          onCancel={resetSession}
        />
      ) : (
        <AuthenticatedApp
          session={session}
          passwordHint={passwordHint}
          onLogout={logout}
          onSessionEnded={resetSession}
          onUserUpdated={(user) => {
            setSession((prev) => {
              if (!prev) return prev
              const next = { ...prev, user }
              localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
              return next
            })
            setPasswordHint(null)
          }}
        />
      )}
    </VaultProvider>
  )
}

export default App
