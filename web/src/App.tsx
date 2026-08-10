import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './App.css'
import { api, ApiError } from './api'
import { AppShell } from './AppShell'
import { EmailVerifyPage } from './EmailVerifyPage'
import { bootstrapI18n } from './i18n'
import { Login } from './Login'
import { LocalRepository } from './offline/repository'
import type { AuthSession, User } from './types'
import { VaultProvider, useVault, vaultNeedsSetup } from './vault/VaultContext'
import { RestoredUserRecovery, VaultSetup, VaultUnlock } from './vault/VaultGate'

bootstrapI18n()

const TOKEN_KEY = 'ownkeep.auth'

function readStoredSession(options?: { allowExpired?: boolean }): AuthSession | null {
  try {
    const value = localStorage.getItem(TOKEN_KEY)
    if (!value) return null
    const session = JSON.parse(value) as AuthSession
    if (!session.token || !session.user?.id) return null
    const expired =
      Boolean(session.expiresAt) && new Date(session.expiresAt).getTime() <= Date.now()
    if (expired && !options?.allowExpired) {
      // Keep the raw session in localStorage so offline data is not orphaned;
      // caller can prompt re-login while preserving IDB outbox.
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

  async function refreshUserIfOnline() {
    if (!navigator.onLine) return
    try {
      const user = await api.me()
      onUserUpdated(user)
      await new LocalRepository(user.id).cacheVault(user.vault)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'connection_failed') return
      throw error
    }
  }

  if (vaultNeedsSetup(session.user)) {
    return (
      <VaultSetup
        passwordHint={passwordHint}
        onReady={async () => {
          await refreshUserIfOnline()
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
          await refreshUserIfOnline()
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
    () => Boolean(readStoredSession() || readStoredSession({ allowExpired: true })),
  )
  const [passwordHint, setPasswordHint] = useState<string | null>(null)
  const [verifyRoute, setVerifyRoute] = useState(() => isVerifyEmailPath())
  const [sessionExpired, setSessionExpired] = useState(false)

  const resetSession = useCallback((options?: { wipeStorage?: boolean }) => {
    if (options?.wipeStorage !== false) {
      localStorage.removeItem(TOKEN_KEY)
    }
    api.setToken(null)
    setSession(null)
    setPasswordHint(null)
    setRestoring(false)
  }, [])

  useEffect(() => {
    api.onUnauthorized(() => resetSession({ wipeStorage: false }))
    return () => api.onUnauthorized(null)
  }, [resetSession])

  useEffect(() => {
    const stored = readStoredSession()
    const expiredStored = !stored ? readStoredSession({ allowExpired: true }) : null
    if (!stored && expiredStored) {
      setSessionExpired(true)
      setRestoring(false)
      return
    }
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
      .then(async (user: User) => {
        const next = { ...stored, user }
        localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
        setSession(next)
        await new LocalRepository(user.id).cacheVault(user.vault)
      })
      .catch(async (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (error instanceof ApiError && error.code === 'connection_failed') {
          const cachedVault = await new LocalRepository(stored.user.id).getCachedVault()
          const user = cachedVault
            ? { ...stored.user, vault: cachedVault }
            : stored.user
          setSession({ ...stored, user })
          return
        }
        resetSession({ wipeStorage: false })
        setSessionExpired(true)
      })
      .finally(() => setRestoring(false))
    return () => controller.abort()
  }, [resetSession])

  async function login(email: string, password: string, signal: AbortSignal) {
    const next = await api.login(email, password, signal)
    api.setToken(next.token)
    localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    setPasswordHint(next.recoveryRequired ? null : password)
    setSessionExpired(false)
    setSession(next)
    await new LocalRepository(next.user.id).cacheVault(next.user.vault)
  }

  function completeRecovery(next: AuthSession) {
    api.setToken(next.token)
    localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    setPasswordHint(null)
    setSession(next)
  }

  async function logout() {
    const current = session
    try {
      if (navigator.onLine) await api.logout()
    } finally {
      if (current) {
        const pending = await new LocalRepository(current.user.id).pendingCount()
        if (pending === 0) await new LocalRepository(current.user.id).clearAll()
      }
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

  if (!session) {
    return (
      <Login
        onLogin={login}
        banner={sessionExpired ? t('errors.api.sessionExpired') : undefined}
      />
    )
  }

  return (
    <VaultProvider>
      {session.recoveryRequired ? (
        <RestoredUserRecovery
          user={session.user}
          onComplete={completeRecovery}
          onCancel={() => resetSession()}
        />
      ) : (
        <AuthenticatedApp
          session={session}
          passwordHint={passwordHint}
          onLogout={logout}
          onSessionEnded={() => resetSession({ wipeStorage: false })}
          onUserUpdated={(user) => {
            setSession((prev) => {
              if (!prev) return prev
              const next = { ...prev, user }
              localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
              return next
            })
            setPasswordHint(null)
            void new LocalRepository(user.id).cacheVault(user.vault)
          }}
        />
      )}
    </VaultProvider>
  )
}

export default App
