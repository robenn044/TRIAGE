import { useLocation, useNavigate } from 'react-router-dom'

export default function EndTripButton() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  if (pathname === '/') return null

  const handleEndTrip = async () => {
    // Send end_trip command to the robot
    try {
      await fetch('/api/robot-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end_trip' }),
      })
    } catch {
      // Best-effort — navigate regardless
    }
    sessionStorage.clear()
    navigate('/')
  }

  return (
    <button
      onClick={handleEndTrip}
      className="shrink-0 rounded-full bg-white/[0.12] px-2.5 py-1 text-[9px] font-semibold text-red-200 ring-1 ring-red-300/30 transition-colors hover:bg-red-500/20 hover:text-white active:scale-95"
    >
      End Trip
    </button>
  )
}
