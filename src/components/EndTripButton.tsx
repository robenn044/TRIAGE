import { useLocation, useNavigate } from 'react-router-dom'

export default function EndTripButton() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Only show when not on the lock screen
  if (pathname === '/') return null

  return (
    <button
      onClick={() => { sessionStorage.clear(); navigate('/') }}
      className="fixed bottom-3 right-3 z-[9999] rounded-full border border-red-200 bg-white px-3 py-1.5 text-[10px] font-semibold text-red-500 shadow-md transition-colors hover:bg-red-50 hover:border-red-300 active:scale-95"
    >
      End Trip
    </button>
  )
}
