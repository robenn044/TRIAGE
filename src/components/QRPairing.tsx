import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { Smartphone, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * QR Pairing Component — AirTag-like phone linking
 *
 * Displays a QR code that the tourist scans with their phone.
 * The QR links to /link?token=XYZ which opens the phone companion page.
 * Polls /api/phone-link to show real-time pairing status.
 */

function generateToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let token = ''
  for (let i = 0; i < 8; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

export default function QRPairing() {
  const [sessionToken, setSessionToken] = useState(() => generateToken())

  // Build the link URL — use current origin so it works in dev and production
  const linkUrl = useMemo(() => {
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    return `${base}/link?token=${sessionToken}`
  }, [sessionToken])

  // Poll phone-link status
  const { data: linkStatus } = useQuery<{
    paired: boolean
    msSinceHeartbeat: number
    signal: string | null
  }>({
    queryKey: ['phone-link'],
    queryFn: async () => {
      const res = await fetch('/api/phone-link')
      if (!res.ok) throw new Error('Failed to check link')
      return res.json()
    },
    refetchInterval: 2000,
    staleTime: 1500,
  })

  const isPaired = linkStatus?.paired ?? false
  const signal = linkStatus?.signal
  const heartbeatAge = linkStatus?.msSinceHeartbeat ?? Infinity

  const regenerateToken = () => {
    // Reset server session first
    fetch('/api/phone-link?action=reset').then(() => {
      setSessionToken(generateToken())
    })
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-white/[0.07] p-4 backdrop-blur-sm">
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-blue-400" />
          <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
            Phone Link
          </p>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5">
          {isPaired ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-green-400" />
              <span className="text-[10px] font-medium text-green-400">Connected</span>
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5 text-white/30" />
              <span className="text-[10px] text-white/30">Waiting…</span>
            </>
          )}
        </div>
      </div>

      {!isPaired ? (
        <>
          {/* QR Code */}
          <div className="rounded-lg bg-white p-2">
            <QRCodeSVG
              value={linkUrl}
              size={140}
              level="M"
              bgColor="#ffffff"
              fgColor="#0f172a"
            />
          </div>

          <p className="text-center text-[10px] text-white/40">
            Tourist scans this QR to pair their phone with TRIAGE
          </p>

          <Button
            variant="ghost"
            size="sm"
            onClick={regenerateToken}
            className="h-7 text-[10px] text-white/30 hover:text-white/60"
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            New Code
          </Button>
        </>
      ) : (
        <>
          {/* Paired state */}
          <div className="flex w-full flex-col gap-2 rounded-lg bg-green-500/10 p-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-green-400" />
              <span className="text-xs font-medium text-green-300">Phone Paired</span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
              <span className="text-white/40">Signal</span>
              <span className="text-white/70">
                {signal === 'here' ? '📍 I\'m here!' : '💓 Active'}
              </span>
              <span className="text-white/40">Latency</span>
              <span className="text-white/70">
                {heartbeatAge < 10000 ? `${(heartbeatAge / 1000).toFixed(1)}s` : 'Stale'}
              </span>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={regenerateToken}
            className="h-7 text-[10px] text-white/30 hover:text-white/60"
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Unpair & Reset
          </Button>
        </>
      )}
    </div>
  )
}
