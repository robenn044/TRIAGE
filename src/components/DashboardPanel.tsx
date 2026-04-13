import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map, MapPin, Sparkles, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import EndTripButton from './EndTripButton'

const PLANNER_STEPS = [
  'Choose an Albanian city.',
  'Answer a short survey.',
  'Get a personal itinerary.',
]

const REBUILD_CARDS = [
  {
    eyebrow: 'Camera',
    title: 'Visual capture removed',
    body: 'The live feed and snapshot pipeline are offline while we rebuild the input stack.',
  },
  {
    eyebrow: 'Microphone',
    title: 'Voice capture removed',
    body: 'Speech recognition and listening controls are intentionally disabled for the next version.',
  },
  {
    eyebrow: 'Assistant',
    title: 'Shell preserved',
    body: 'The current dashboard keeps its layout, navigation, and presentation so we can swap the new inputs back in cleanly.',
  },
]

export default function DashboardPanel() {
  const navigate = useNavigate()
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setEntered(true))
    )
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    let lockTimer: ReturnType<typeof setTimeout>

    const resetLockTimer = () => {
      clearTimeout(lockTimer)
      lockTimer = setTimeout(() => {
        sessionStorage.setItem('lockReturnPath', '/dashboard')
        navigate('/')
      }, 45_000)
    }

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const
    events.forEach(eventName =>
      window.addEventListener(eventName, resetLockTimer, { passive: true })
    )
    resetLockTimer()

    return () => {
      clearTimeout(lockTimer)
      events.forEach(eventName =>
        window.removeEventListener(eventName, resetLockTimer)
      )
    }
  }, [navigate])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f4fbfe]">
      <div
        className="pointer-events-none fixed inset-0 z-50 bg-[#20a7db]"
        style={{ opacity: entered ? 0 : 1, transition: 'opacity 800ms cubic-bezier(0.4,0,0.2,1)' }}
      />

      <header className="shrink-0 bg-[#20a7db]">
        <div className="mx-auto flex w-full items-center gap-2 px-3 py-1.5">
          <div className="shrink-0 flex items-center justify-center">
            <RobotFace mini />
          </div>
          <div className="min-w-0">
            <h1 className="text-xs font-semibold leading-tight tracking-tight text-white">Triage</h1>
            <p className="text-[10px] leading-tight text-white/70">Travel guide dashboard</p>
          </div>
          <div className="ml-auto shrink-0 rounded-full bg-white/[0.12] px-2 py-0.5 text-[10px] font-medium text-white/80 ring-1 ring-white/[0.15]">
            Preview mode
          </div>
          <EndTripButton />
        </div>
      </header>

      <main className="flex w-full flex-1 min-h-0 gap-3 p-2.5">
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[#20a7db]/[0.12] bg-white p-3 shadow-[0_20px_48px_rgba(32,167,219,0.07)]">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#20a7db]">
                Assistant mode
              </p>
              <h2 className="mt-0.5 text-sm font-semibold leading-tight tracking-tight text-slate-900">
                Rebuilding the live input system
              </h2>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#20a7db]/[0.12] bg-[#f4fbfe] p-1">
              <div className="flex h-9 items-center gap-1.5 rounded-full bg-amber-500 px-3 text-[10px] font-semibold text-white shadow-sm shadow-amber-500/25">
                <Wrench className="h-3.5 w-3.5" />
                Inputs offline
              </div>
              <Button
                onClick={() => navigate('/itinerary')}
                size="lg"
                variant="outline"
                className="h-8 w-8 rounded-full border-[#20a7db]/30 bg-white p-0 text-[#20a7db] hover:bg-[#20a7db]/5"
              >
                <Map className="h-3.5 w-3.5" />
              </Button>
              <Button
                onClick={() => navigate('/maps')}
                size="lg"
                variant="outline"
                className="h-8 w-8 rounded-full border-[#20a7db]/30 bg-white p-0 text-[#20a7db] hover:bg-[#20a7db]/5"
              >
                <MapPin className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="relative mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-[#20a7db]/[0.12] bg-slate-950">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(32,167,219,0.35),transparent_34%),linear-gradient(135deg,rgba(11,23,36,0.92),rgba(5,10,18,1))]" />
            <div className="pointer-events-none absolute left-2 top-2 z-10 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-white/40" />
            <div className="pointer-events-none absolute right-2 top-2 z-10 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-white/40" />
            <div className="pointer-events-none absolute bottom-2 left-2 z-10 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-white/40" />
            <div className="pointer-events-none absolute bottom-2 right-2 z-10 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-white/40" />

            <div className="absolute left-2 top-2 z-20 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur-sm">
              Rebuild in progress
            </div>

            <div className="relative z-10 flex h-full flex-col justify-between p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="max-w-[420px]">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#7fd4ef]">
                    Same UI shell
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                    Camera and microphone inputs have been fully removed from this screen.
                  </h3>
                  <p className="mt-3 max-w-[380px] text-sm leading-6 text-white/70">
                    The dashboard still keeps the existing structure, navigation, and visual language so we can rebuild the input pipeline without changing the overall experience.
                  </p>
                </div>

                <div className="hidden rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-right backdrop-blur md:block">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7fd4ef]">
                    Status
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">Input systems disabled</p>
                  <p className="mt-1 text-xs text-white/60">Ready for the next rebuild pass.</p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {REBUILD_CARDS.map(card => (
                  <div
                    key={card.title}
                    className="rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.2)] backdrop-blur-sm"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7fd4ef]">
                      {card.eyebrow}
                    </p>
                    <p className="mt-2 text-sm font-semibold text-white">{card.title}</p>
                    <p className="mt-2 text-xs leading-5 text-white/70">{card.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-2 shrink-0 rounded-xl bg-slate-900/85 px-4 py-2 backdrop-blur-sm">
            <p className="text-center text-xs leading-5 text-white/90">
              The live camera feed, mic controls, and speech processing have been removed. You can still use the itinerary planner and maps while we rebuild those features.
            </p>
          </div>
        </section>

        <aside className="flex w-[188px] shrink-0 flex-col rounded-2xl border border-[#20a7db]/[0.12] bg-[#eff9fd] p-3 shadow-sm">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            Itinerary planner
          </h3>
          <p className="mt-1 text-xs leading-4 text-slate-600">
            Plan a city trip in Albania by answering a few quick questions.
          </p>

          <div className="mt-3 rounded-2xl border border-[#20a7db]/10 bg-white/80 p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#20a7db]/10 text-[#20a7db]">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#20a7db]">
                  Current focus
                </p>
                <p className="text-xs font-semibold text-slate-800">UI retained, inputs removed</p>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {PLANNER_STEPS.map((item, index) => (
              <div key={item} className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-semibold text-[#20a7db]">
                  {index + 1}
                </span>
                <p className="text-xs leading-4 text-slate-600">{item}</p>
              </div>
            ))}
          </div>

          <div className="mt-auto grid gap-1.5 pt-3">
            <Button
              onClick={() => navigate('/itinerary')}
              className="h-9 bg-[#20a7db] text-xs shadow-sm shadow-[#20a7db]/25 hover:bg-[#1b96c5]"
            >
              Open itinerary planner
            </Button>
          </div>
        </aside>
      </main>
    </div>
  )
}
