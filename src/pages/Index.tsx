import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TriageMark from '@/components/TriageMark'

const Index = () => {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)

  const handleUnlock = () => {
    setLeaving(true)
    const returnPath = sessionStorage.getItem('lockReturnPath') || '/dashboard'
    sessionStorage.removeItem('lockReturnPath')
    setTimeout(() => navigate(returnPath), 500)
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#20a7db] px-5"
      style={{ opacity: leaving ? 0 : 1, transition: 'opacity 500ms ease' }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.22),_transparent_40%)]" />
      <div className="absolute -left-12 top-0 h-48 w-48 rounded-full bg-white/12 blur-3xl" />
      <div className="absolute -bottom-10 right-0 h-56 w-56 rounded-full bg-[#8fdcff]/25 blur-3xl" />

      <button
        onClick={handleUnlock}
        className="group relative z-10 flex w-full max-w-[26rem] flex-col items-center rounded-[2rem] border border-white/20 bg-white/10 px-8 py-10 text-white shadow-[0_32px_90px_rgba(0,0,0,0.18)] backdrop-blur-md transition-transform duration-300 hover:scale-[1.01]"
        aria-label="Start TRIAGE"
      >
        <div className="rounded-[1.6rem] border border-white/18 bg-white/12 p-4 shadow-[0_20px_45px_rgba(255,255,255,0.14)]">
          <TriageMark className="h-28 w-28 drop-shadow-[0_16px_30px_rgba(255,255,255,0.22)]" alt="TRIAGE logo" />
        </div>

        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.38em] text-white/75">Tour Guide Kiosk</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[0.28em] text-white">TRIAGE</h1>
        <p className="mt-3 max-w-[18rem] text-center text-sm leading-6 text-white/82">
          Voice-first travel guidance for Albania. Tap to start a new trip.
        </p>

        <span className="mt-6 inline-flex items-center rounded-full bg-white px-5 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[#20a7db] shadow-sm transition-transform duration-300 group-hover:scale-105">
          Tap to begin
        </span>
      </button>
    </div>
  )
}

export default Index
