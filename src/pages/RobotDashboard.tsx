import { useQuery } from '@tanstack/react-query'
import CameraFeed from '@/components/CameraFeed'
import RobotStateBar from '@/components/RobotStateBar'
import ControlPanel from '@/components/ControlPanel'
import QRPairing from '@/components/QRPairing'
import RobotFace from '@/components/RobotFace'

/**
 * Robot Dashboard — displays on Screen #2 (Brain Pi) in Chromium kiosk mode.
 *
 * Shows: live camera feed, robot state, AI narration, and control buttons.
 * Bypasses the lock screen — goes straight to the active dashboard.
 */
export default function RobotDashboard() {
  const { data: robotState } = useQuery<{ state: string }>({
    queryKey: ['robot-state'],
    queryFn: async () => {
      const res = await fetch('/api/robot-state')
      if (!res.ok) throw new Error('Failed to fetch state')
      return res.json()
    },
    refetchInterval: 1000,
    staleTime: 800,
  })

  const currentState = robotState?.state ?? 'IDLE'

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-[#0f172a] via-[#1e293b] to-[#0f172a]">
      {/* Main content area */}
      <div className="flex flex-1 flex-col gap-4 p-4 lg:flex-row">
        {/* Left column: Camera + Narration */}
        <div className="flex flex-1 flex-col gap-4">
          {/* Camera feed */}
          <div className="flex-1">
            <CameraFeed />
          </div>

          {/* State bar (visible on mobile below camera) */}
          <div className="lg:hidden">
            <RobotStateBar />
          </div>
        </div>

        {/* Right sidebar: State + Controls */}
        <div className="flex w-full flex-col gap-4 lg:w-80">
          {/* Mini robot face avatar */}
          <div className="flex items-center gap-3 rounded-xl bg-white/[0.07] p-3 backdrop-blur-sm">
            <div className="h-12 w-12 shrink-0">
              <RobotFace mini />
            </div>
            <div>
              <p className="text-sm font-bold text-white">TRIAGE</p>
              <p className="text-[10px] text-white/50">AI Tourist Guide — Albania</p>
            </div>
          </div>

          {/* State (hidden on mobile — shown above) */}
          <div className="hidden lg:block">
            <RobotStateBar />
          </div>

          {/* Phone Pairing (QR / AirTag-like tracking) */}
          <QRPairing />

          {/* Controls */}
          <ControlPanel currentState={currentState} />

          {/* System info */}
          <div className="mt-auto rounded-xl bg-white/[0.04] p-3 text-[10px] text-white/30">
            <p>TRIAGE v1.0 • Brain Pi Dashboard</p>
            <p>Face Pi Camera → Vercel → Dashboard</p>
            <p>Brain Pi → Arduino (USB Serial)</p>
          </div>
        </div>
      </div>
    </div>
  )
}
