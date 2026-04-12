import { useQuery } from '@tanstack/react-query'
import { Activity, Radio, Compass, Eye } from 'lucide-react'

interface RobotState {
  state: string
  ir_l: number
  ir_r: number
  poi: string | null
  speed_l: number
  speed_r: number
  tracking: boolean
  narration: string | null
  timestamp: number
}

const STATE_COLORS: Record<string, string> = {
  IDLE: 'bg-gray-400',
  TOURING: 'bg-green-400',
  AT_POI: 'bg-blue-400',
  FOLLOWING: 'bg-purple-400',
  END_TRIP: 'bg-red-400',
}

const STATE_LABELS: Record<string, string> = {
  IDLE: 'Idle — Waiting',
  TOURING: 'Touring — Navigating',
  AT_POI: 'At Point of Interest',
  FOLLOWING: 'Following Tourist',
  END_TRIP: 'Ending Trip',
}

export default function RobotStateBar() {
  const { data: robotState } = useQuery<RobotState>({
    queryKey: ['robot-state'],
    queryFn: async () => {
      const res = await fetch('/api/robot-state')
      if (!res.ok) throw new Error('Failed to fetch state')
      return res.json()
    },
    refetchInterval: 1000,
    staleTime: 800,
  })

  const state = robotState?.state ?? 'IDLE'
  const dotColor = STATE_COLORS[state] ?? 'bg-gray-400'
  const label = STATE_LABELS[state] ?? state

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white/[0.07] p-4 backdrop-blur-sm">
      {/* State indicator */}
      <div className="flex items-center gap-2">
        <span className={`h-3 w-3 rounded-full ${dotColor} animate-pulse`} />
        <span className="text-sm font-semibold text-white">{label}</span>
      </div>

      {/* Sensor grid */}
      <div className="grid grid-cols-2 gap-2 text-xs text-white/70">
        <div className="flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5" />
          <span>IR Left: {robotState?.ir_l ?? '—'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Radio className="h-3.5 w-3.5" />
          <span>IR Right: {robotState?.ir_r ?? '—'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" />
          <span>Speed: {robotState?.speed_l ?? 0}/{robotState?.speed_r ?? 0}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" />
          <span>Tracking: {robotState?.tracking ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      {/* Current POI */}
      {robotState?.poi && (
        <div className="flex items-center gap-1.5 text-xs text-blue-300">
          <Compass className="h-3.5 w-3.5" />
          <span>POI: {robotState.poi}</span>
        </div>
      )}

      {/* Narration */}
      {robotState?.narration && (
        <div className="mt-1 rounded-lg bg-white/[0.05] p-3 text-xs leading-relaxed text-white/80">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
            AI Narration
          </p>
          {robotState.narration}
        </div>
      )}
    </div>
  )
}
