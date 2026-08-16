import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { CampaignManager } from './components/CampaignManager'
import { CharacterManager } from './components/CharacterManager'
import { normalizeUsername, usernameToAuthEmail, validateUsername } from './lib/auth'
import { supabase } from './lib/supabase'
import './App.css'

type AuthMode = 'login' | 'register'

type Profile = {
  username: string
  is_admin: boolean
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [profileError, setProfileError] = useState('')

  useEffect(() => {
    let isActive = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!isActive) return
      setSession(data.session)
      setInitializing(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (!nextSession) {
        setProfile(null)
        setProfileError('')
      }
      setInitializing(false)
    })

    return () => {
      isActive = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    let isActive = true

    if (!session) {
      return () => {
        isActive = false
      }
    }

    void supabase
      .from('profiles')
      .select('username, is_admin')
      .eq('id', session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!isActive) return

        if (error) {
          console.error('Could not load profile:', error)
          setProfileError('Your account is signed in, but its profile could not be loaded.')
          return
        }

        setProfileError('')
        setProfile(data)
      })

    return () => {
      isActive = false
    }
  }, [session])

  if (initializing) {
    return <LoadingScreen />
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <div>
          <p className="brand">AskTheDM</p>
          <p className="site-title">Campaign Shopping Trip</p>
        </div>
        {session && (
          <button className="button button-quiet" type="button" onClick={() => void supabase.auth.signOut()}>
            Log out
          </button>
        )}
      </header>

      {session ? (
        <Dashboard
          profile={profile}
          profileError={profileError}
          userId={session.user.id}
        />
      ) : (
        <AuthPanel />
      )}
    </main>
  )
}

function LoadingScreen() {
  return (
    <main className="app-shell app-shell-centered">
      <section className="card loading-card" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        Opening the shop…
      </section>
    </main>
  )
}

function Dashboard({
  profile,
  profileError,
  userId,
}: {
  profile: Profile | null
  profileError: string
  userId: string
}) {
  return (
    <section className="dashboard">
      {profileError ? (
        <p className="message message-error">{profileError}</p>
      ) : profile ? (
        <>
          <div className="card dashboard-card">
            <div>
              <p className="eyebrow">Signed in as</p>
              <h1>{profile.username}</h1>
            </div>
            <div className="role-badge">{profile.is_admin ? 'DM / Administrator' : 'Player'}</div>
          </div>

          <div className={profile.is_admin ? 'dashboard-workspace admin-workspace' : 'dashboard-workspace player-workspace'}>
            <div className={profile.is_admin ? 'dashboard-column character-dashboard-column' : 'player-dashboard-content'}>
              <CharacterManager userId={userId} />
            </div>
            {profile.is_admin && (
              <div className="dashboard-column campaign-dashboard-column">
                <CampaignManager userId={userId} />
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="loading-line">Loading your account…</p>
      )}
    </section>
  )
}

function AuthPanel() {
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setMessage('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')

    const cleanedUsername = normalizeUsername(username)

    if (!validateUsername(cleanedUsername)) {
      setMessage('Use 3–32 letters, numbers, or underscores for your username.')
      return
    }

    if (password.length < 8) {
      setMessage('Your password must contain at least 8 characters.')
      return
    }

    if (mode === 'register' && password !== confirmPassword) {
      setMessage('The two passwords do not match.')
      return
    }

    setSubmitting(true)

    const email = usernameToAuthEmail(cleanedUsername)
    const { error } = mode === 'register'
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: cleanedUsername } },
        })
      : await supabase.auth.signInWithPassword({ email, password })

    setSubmitting(false)

    if (error) {
      console.error(`Supabase ${mode} failed:`, error)
      setMessage(friendlyAuthError(error.message, mode))
    }
  }

  return (
    <section className="auth-layout">
      <div className="welcome-copy">
        <p className="eyebrow">The market awaits</p>
        <h1>Your campaign’s shops, all in one place.</h1>
        <p className="description">
          Create characters, join campaigns, browse persistent inventories, haggle with merchants,
          and purchase wares alongside your party.
        </p>
      </div>

      <section className="card auth-card" aria-labelledby="auth-title">
        <div className="mode-tabs" role="tablist" aria-label="Account access">
          <button
            className={mode === 'login' ? 'mode-tab active' : 'mode-tab'}
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => switchMode('login')}
          >
            Log in
          </button>
          <button
            className={mode === 'register' ? 'mode-tab active' : 'mode-tab'}
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            onClick={() => switchMode('register')}
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <h2 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="form-intro">
            {mode === 'login'
              ? 'Enter the username and password you chose.'
              : 'No email address is required. AskTheDM will manage password resets.'}
          </p>

          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9_]+"
            required
          />
          {mode === 'register' && <p className="field-hint">3–32 letters, numbers, or underscores.</p>}

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />

          {mode === 'register' && (
            <>
              <label htmlFor="confirm-password">Confirm password</label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </>
          )}

          {message && <p className="message message-error" role="alert">{message}</p>}

          <button className="button button-primary" type="submit" disabled={submitting}>
            {submitting
              ? 'Working…'
              : mode === 'login'
                ? 'Log in'
                : 'Create account'}
          </button>
        </form>
      </section>
    </section>
  )
}

function friendlyAuthError(message: string, mode: AuthMode) {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('invalid login credentials')) {
    return 'That username and password combination was not recognized.'
  }

  if (normalizedMessage.includes('already registered') || normalizedMessage.includes('already exists')) {
    return 'That username is already in use.'
  }

  if (normalizedMessage.includes('password')) {
    return message
  }

  return mode === 'register'
    ? 'We could not create that account. Please try a different username.'
    : 'We could not log you in. Please try again.'
}

export default App
