import { useLocation, useNavigate } from 'react-router-dom'

export default function EndTripButton() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  if (pathname === '/') return null

  return (
    <button
      onClick={() => { sessionStorage.clear(); navigate('/') }}
      className="fixed bottom-2 left-2 z-[9999] rounded-full bg-white/60 px-2.5 py-1 text-[9px] font-semibold text-red-400 shadow-sm ring-1 ring-red-200/50 backdrop-blur-sm transition-all duration-200 hover:bg-white hover:text-red-500 hover:shadow-md hover:ring-red-300 hover:scale-105 active:scale-95 opacity-40 hover:opacity-100"
    >
      End Trip
    </button>
  )
}
