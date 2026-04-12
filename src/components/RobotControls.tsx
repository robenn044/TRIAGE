import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import {
  Smartphone, Play, UserRound, Pause, RotateCcw, X,
  Wifi, WifiOff, RefreshCw, ShieldCheck, ShieldAlert, Shield,
} from 'lucide-react'

/**
 * Robot Controls — embedded in the existing /dashboard sidebar.
 *
 * Includes:
 *   - Robot state indicator
 *   - Start Trip / Follow Me / Pause / Resume buttons
 *   - Connect Phone (QR pairing) toggle
 *   - Safety status (collision avoidance)
 *
 * Styled to match the existing #20a7db / light theme design.
 */

function generateToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let token = ''
  for (let i = 0; i < 8; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

async function sendCommand(action: string) {
  const res = await fetch('/api/robot-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) throw new Error(`Command failed: ${res.status}`)
  return res.json()
}

export default function RobotControls() {
  const [showQR, setShowQR] = useState(false)
  const [sessionToken, setSessionToken] = useState(() => generateToken())

  const linkUrl = useMemo(() => {
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    return `${base}/link?token=${sessionToken}`
  }, [sessionToken])

  // Poll robot state
  const { data: robotState } = useQuery<{
    state: string
    safety: string
    phone_paired: boolean
    tracking: boolean
    speed_l: number
    speed_r: number
  }>({
    queryKey: ['robot-state'],
    queryFn: async () => {
      const res = await fetch('/api/robot-state')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 1000,
    staleTime: 800,
  })

  // Poll phone link
  const { data: phoneStatus } = useQuery<{
    paired: boolean
    signal: string | null
  }>({
    queryKey: ['phone-link'],
    queryFn: async () => {
      const res = await fetch('/api/phone-link')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
    refetchInterval: 2000,
    staleTime: 1500,
  })

  const mutation = useMutation({ mutationFn: sendCommand })
  const send = (action: string) => mutation.mutate(action)

  const currentState = robotState?.state ?? 'IDLE'
  const safety = robotState?.safety ?? 'CLEAR'
  const phonePaired = phoneStatus?.paired ?? false
  const isIdle = currentState === 'IDLE'
  const isActive = ['TOURING', 'AT_POI', 'FOLLOWING'].includes(currentState)

  const handleDisconnectPhone = () => {
    fetch('/api/phone-link?action=reset').then(() => {
      setSessionToken(generateToken())
      setShowQR(false)
    })
  }

  // State badge color
  const stateColor = isIdle
    ? 'bg-slate-200 text-slate-600'
    : currentState === 'FOLLOWING'
      ? 'bg-purple-100 text-purple-700'
      : currentState === 'END_TRIP'
        ? 'bg-red-100 text-red-700'
        : 'bg-[#20a7db]/10 text-[#20a7db]'

  return (
    <div className="flex flex-col gap-2">
      {/* State badge */}
      <div className="flex items-center justify-between">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${stateColor}`}>
          {currentState}
        </span>
        {/* Safety indicator */}
        {safety === 'DANGER' ? (
          <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
        ) : safety === 'CAUTION' ? (
          <Shield className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
        )}
      </div>

      {/* Control buttons */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          disabled={!isIdle || mutation.isPending}
          onClick={() => send('start_trip')}
          className="flex items-center justify-center gap-1 rounded-lg bg-green-500/10 px-2 py-1.5 text-[10px] font-semibold text-green-700 ring-1 ring-green-500/20 transition hover:bg-green-500/20 disabled:opacity-40"
        >
          <Play className="h-3 w-3" /> Start
        </button>
        <button
          disabled={(!isActive && !isIdle) || mutation.isPending}
          onClick={() => send('follow_me')}
          className="flex items-center justify-center gap-1 rounded-lg bg-purple-500/10 px-2 py-1.5 text-[10px] font-semibold text-purple-700 ring-1 ring-purple-500/20 transition hover:bg-purple-500/20 disabled:opacity-40"
        >
          <UserRound className="h-3 w-3" /> Follow
        </button>
        <button
          disabled={!isActive || mutation.isPending}
          onClick={() => send('pause')}
          className="flex items-center justify-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-500/20 transition hover:bg-amber-500/20 disabled:opacity-40"
        >
          <Pause className="h-3 w-3" /> Pause
        </button>
        <button
          disabled={!isActive || mutation.isPending}
          onClick={() => send('resume')}
          className="flex items-center justify-center gap-1 rounded-lg bg-[#20a7db]/10 px-2 py-1.5 text-[10px] font-semibold text-[#20a7db] ring-1 ring-[#20a7db]/20 transition hover:bg-[#20a7db]/20 disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> Resume
        </button>
      </div>

      {/* ── Connect Phone / QR ── */}
      {!phonePaired && !showQR && (
        <button
          onClick={() => setShowQR(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#20a7db]/10 px-2 py-2 text-[10px] font-semibold text-[#20a7db] ring-1 ring-[#20a7db]/20 transition hover:bg-[#20a7db]/20"
        >
          <Smartphone className="h-3.5 w-3.5" /> Connect Phone
        </button>
      )}

      {!phonePaired && showQR && (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-white p-2 ring-1 ring-slate-200">
          <div className="flex w-full items-center justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
              Scan to connect
            </span>
            <button onClick={() => setShowQR(false)} className="text-slate-400 hover:text-slate-600">
              <X className="h-3 w-3" />
            </button>
          </div>
          <QRCodeSVG value={linkUrl} size={110} level="M" bgColor="#ffffff" fgColor="#0f172a" />
          <p className="text-center text-[8px] text-slate-400">
            Tourist scans with phone camera
          </p>
          <button
            onClick={() => {
              fetch('/api/phone-link?action=reset').then(() => setSessionToken(generateToken()))
            }}
            className="flex items-center gap-1 text-[9px] text-slate-400 hover:text-[#20a7db]"
          >
            <RefreshCw className="h-2.5 w-2.5" /> New code
          </button>
        </div>
      )}

      {phonePaired && (
        <div className="flex items-center justify-between rounded-lg bg-green-50 px-2 py-1.5 ring-1 ring-green-200">
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            <Smartphone className="h-3 w-3 text-green-600" />
            <span className="text-[10px] font-medium text-green-700">Phone linked</span>
          </div>
          <button onClick={handleDisconnectPhone} className="text-slate-400 hover:text-red-500">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}
