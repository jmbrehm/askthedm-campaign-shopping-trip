import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import './App.css'

type BackendStatus = 'checking' | 'connected' | 'error'

function App() {
  const [backendStatus, setBackendStatus] =
    useState<BackendStatus>('checking')
  const [statusMessage, setStatusMessage] =
    useState('Checking persistent backend…')

  useEffect(() => {
    let isActive = true

    async function checkBackend() {
      const { data, error } = await supabase
        .from('app_status')
        .select('message')
        .eq('id', 1)
        .single()

      if (!isActive) return

      if (error) {
        console.error('Supabase connection failed:', error)
        setBackendStatus('error')
        setStatusMessage('Backend connection unavailable')
        return
      }

      setBackendStatus('connected')
      setStatusMessage(data.message)
    }

    void checkBackend()

    return () => {
      isActive = false
    }
  }, [])

  return (
    <main className="app-shell">
      <section className="placeholder-card">
        <p className="brand">AskTheDM</p>

        <h1>Campaign Shopping Trip</h1>

        <p className="description">
          A shared campaign storefront for persistent D&amp;D shop inventories,
          purchases, haggling, and restocking.
        </p>

        <div className={`status status-${backendStatus}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusMessage}
        </div>
      </section>
    </main>
  )
}

export default App