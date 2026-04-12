import { useState, useEffect, useRef, useCallback } from 'react'
import { Wifi, WifiOff, MapPin, AlertTriangle, Smartphone } from 'lucide-react'

/**
 * Phone Link — Tourist's companion page
 *
 * Opened by scanning the QR code on the robot's dashboard.
 * This page:
 *   1. Sends heartbeat pings to /api/phone-link every 3s (AirTag-like beacon)
 *   2. Shows tour status and connection indicator
 *   3. Has an "I'm Here" panic button (sends location signal to robot)
 *   4. Runs entirely in the browser — no app install needed
 */

const HEARTBEAT_INTERVAL_MS = 3000

export default function PhoneLink() {
  const [token, setToken] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heartbeatCount, setHeartbeatCount] = useState(0)
  const [signal, setSignal] = useState<'heartbeat' | 'here'>('heartbeat')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Extract token from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('token')
    if (!t) {
      setError('No pairing token found. Please scan the QR code on the robot\'s screen.')
      return
    }
    setToken(t)
  }, [])

  // Heartbeat sender
  const sendHeartbeat = useCallback(async (sig: 'heartbeat' | 'here' = 'heartbeat') => {
    if (!token) return

    try {
      const res = await fetch('/api/phone-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          signal: sig,
          phoneInfo: {
            userAgent: navigator.userAgent,
            timestamp: Date.now(),
          },
        }),
      })

      if (res.ok) {
        setConnected(true)
        setHeartbeatCount((c) => c + 1)
        setError(null)
      } else {
        const data = await res.json()
        setError(data.error || 'Connection failed')
        setConnected(false)
      }
    } catch {
      setConnected(false)
      setError('Network error — make sure you\'re connected to the internet')
    }
  }, [token])

  // Start heartbeat loop when token is available
  useEffect(() => {
    if (!token) return

    // Send initial heartbeat immediately
    sendHeartbeat('heartbeat')

    // Then every 3 seconds
    intervalRef.current = setInterval(() => {
      sendHeartbeat('heartbeat')
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [token, sendHeartbeat])

  // Keep screen awake (prevent phone from sleeping during tour)
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null

    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen')
        }
      } catch {
        // Wake Lock not supported or denied — that's fine
      }
    }

    requestWakeLock()

    // Re-acquire wake lock when page becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      wakeLock?.release()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  // "I'm Here" button handler — sends a special signal + vibration
  const handleImHere = () => {
    setSignal('here')
    sendHeartbeat('here')

    // Vibrate the phone as confirmation
    if ('vibrate' in navigator) {
      navigator.vibrate([100, 50, 100])
    }

    // Reset signal after 5 seconds
    setTimeout(() => setSignal('heartbeat'), 5000)
  }

  if (error && !token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-900 to-slate-800 p-6">
        <div className="max-w-sm text-center">
          <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-amber-400" />
          <h1 className="mb-2 text-lg font-bold text-white">Pairing Error</h1>
          <p className="text-sm text-white/60">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20">
            <Smartphone className="h-4 w-4 text-blue-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">TRIAGE Tour</h1>
            <p className="text-[10px] text-white/40">AI Tourist Guide — Albania</p>
          </div>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1">
          {connected ? (
            <>
              <div className="h-2 w-2 animate-pulse rounded-full bg-green-400" />
              <span className="text-[10px] font-medium text-green-400">Linked</span>
            </>
          ) : (
            <>
              <div className="h-2 w-2 rounded-full bg-red-400" />
              <span className="text-[10px] font-medium text-red-400">Connecting…</span>
            </>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        {/* Connection card */}
        <div className="w-full max-w-sm rounded-2xl bg-white/[0.06] p-6 backdrop-blur-sm">
          {connected ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
                <Wifi className="h-8 w-8 text-green-400" />
              </div>
              <div className="text-center">
                <h2 className="text-lg font-bold text-white">You're Connected!</h2>
                <p className="mt-1 text-xs text-white/50">
                  TRIAGE is tracking your position. Enjoy the tour!
                </p>
              </div>

              {/* Stats */}
              <div className="grid w-full grid-cols-2 gap-3">
                <div className="rounded-lg bg-white/5 p-3 text-center">
                  <p className="text-lg font-bold text-blue-400">{heartbeatCount}</p>
                  <p className="text-[10px] text-white/40">Heartbeats</p>
                </div>
                <div className="rounded-lg bg-white/5 p-3 text-center">
                  <p className="text-lg font-bold text-green-400">
                    {signal === 'here' ? '📍' : '💓'}
                  </p>
                  <p className="text-[10px] text-white/40">
                    {signal === 'here' ? 'Located!' : 'Active'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/20">
                <WifiOff className="h-8 w-8 text-amber-400" />
              </div>
              <div className="text-center">
                <h2 className="text-lg font-bold text-white">Connecting to TRIAGE…</h2>
                <p className="mt-1 text-xs text-white/50">
                  Please wait while we establish the link.
                </p>
              </div>
              {error && (
                <p className="rounded-lg bg-red-500/10 p-2 text-center text-xs text-red-400">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* "I'm Here" button — the AirTag-like beacon */}
        {connected && (
          <button
            onClick={handleImHere}
            className={`flex h-28 w-28 flex-col items-center justify-center rounded-full shadow-lg transition-all active:scale-95 ${
              signal === 'here'
                ? 'bg-green-500 shadow-green-500/30'
                : 'bg-blue-600 shadow-blue-600/30 hover:bg-blue-500'
            }`}
          >
            <MapPin className="mb-1 h-8 w-8 text-white" />
            <span className="text-xs font-bold text-white">
              {signal === 'here' ? 'Sent!' : "I'm Here"}
            </span>
          </button>
        )}

        {connected && (
          <p className="max-w-xs text-center text-[10px] text-white/30">
            Tap "I'm Here" if the robot needs to find you. Keep this page open during your tour.
          </p>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 px-4 py-3 text-center text-[10px] text-white/20">
        Keep this page open • Your phone is acting as a beacon for TRIAGE
      </footer>
    </div>
  )
}
