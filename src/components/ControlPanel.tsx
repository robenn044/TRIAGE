import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Play, Square, UserRound, Pause, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

async function sendCommand(action: string) {
  const res = await fetch('/api/robot-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) throw new Error(`Command failed: ${res.status}`)
  return res.json()
}

interface ControlPanelProps {
  currentState?: string
}

export default function ControlPanel({ currentState = 'IDLE' }: ControlPanelProps) {
  const [lastAction, setLastAction] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: sendCommand,
    onSuccess: (_, action) => setLastAction(action),
  })

  const send = (action: string) => mutation.mutate(action)
  const isLoading = mutation.isPending

  const isIdle = currentState === 'IDLE'
  const isActive = ['TOURING', 'AT_POI', 'FOLLOWING'].includes(currentState)

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white/[0.07] p-4 backdrop-blur-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
        Robot Controls
      </p>

      <div className="grid grid-cols-2 gap-2">
        {/* Start Trip */}
        <Button
          variant="outline"
          size="sm"
          disabled={!isIdle || isLoading}
          onClick={() => send('start_trip')}
          className="flex items-center gap-1.5 border-green-500/30 bg-green-500/10 text-green-300 hover:bg-green-500/20 disabled:opacity-40"
        >
          <Play className="h-4 w-4" />
          Start Trip
        </Button>

        {/* Follow Me */}
        <Button
          variant="outline"
          size="sm"
          disabled={!isActive && !isIdle || isLoading}
          onClick={() => send('follow_me')}
          className="flex items-center gap-1.5 border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-40"
        >
          <UserRound className="h-4 w-4" />
          Follow Me
        </Button>

        {/* Pause */}
        <Button
          variant="outline"
          size="sm"
          disabled={!isActive || isLoading}
          onClick={() => send('pause')}
          className="flex items-center gap-1.5 border-yellow-500/30 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-40"
        >
          <Pause className="h-4 w-4" />
          Pause
        </Button>

        {/* Resume */}
        <Button
          variant="outline"
          size="sm"
          disabled={!isActive || isLoading}
          onClick={() => send('resume')}
          className="flex items-center gap-1.5 border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
        >
          <RotateCcw className="h-4 w-4" />
          Resume
        </Button>
      </div>

      {/* End Trip — Full width, prominent */}
      <Button
        variant="destructive"
        size="lg"
        disabled={isIdle || isLoading}
        onClick={() => send('end_trip')}
        className="mt-1 flex w-full items-center justify-center gap-2 bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
      >
        <Square className="h-5 w-5" />
        End Trip
      </Button>

      {/* Status feedback */}
      {isLoading && (
        <p className="text-center text-[10px] text-white/40">Sending…</p>
      )}
      {lastAction && !isLoading && (
        <p className="text-center text-[10px] text-green-400/60">
          ✓ Sent: {lastAction}
        </p>
      )}
    </div>
  )
}
