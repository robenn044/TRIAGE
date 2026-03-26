import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map, MapPin, Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import EndTripButton from './EndTripButton'

/* ── Types ─────────────────────────────────────────────── */
type AssistantState = 'listening' | 'processing' | 'speaking' | 'error' | 'idle'

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}
interface SpeechRecognitionErrorEvent {
  error: string
}
interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative
  isFinal: boolean
}
interface SpeechRecognitionResultList {
  length: number
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance
  }
}

const PLANNER_STEPS = [
  'Choose an Albanian city.',
  'Answer a short survey.',
  'Get a personal itinerary.',
]

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error'
}

/* ── Helpers ───────────────────────────────────────────── */

/** Pick the most natural-sounding English voice available. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices()
  const priorities: Array<(v: SpeechSynthesisVoice) => boolean> = [
    // Windows 11 Neural / Natural voices — best quality on desktop
    v => /Natural/i.test(v.name) && v.lang.startsWith('en'),
    // Google UK English Female — high quality on Chrome/Chromium
    v => v.name.includes('Google UK English Female'),
    // Google US English — also good
    v => v.name.includes('Google US English'),
    // Any Google English voice
    v => v.name.includes('Google') && v.lang.startsWith('en'),
    // Microsoft online voices (better than local)
    v => v.name.includes('Microsoft') && v.lang.startsWith('en') && !v.localService,
    // Any remote/cloud English voice (usually better quality)
    v => v.lang.startsWith('en') && !v.localService,
    // Last resort: any English voice
    v => v.lang.startsWith('en'),
  ]
  for (const test of priorities) {
    const match = voices.find(test)
    if (match) return match
  }
  return null
}

export default function CameraAskAI() {
  const navigate = useNavigate()

  /* ── Refs ── */
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const isSpeakingRef = useRef(false)
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const stateRef = useRef<AssistantState>('idle')

  /* ── State ── */
  const [entered, setEntered] = useState(false)
  const [state, setState] = useState<AssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')
  const [micEnabled, setMicEnabled] = useState(true)

  // Keep stateRef in sync so lock timer callback can read current state
  useEffect(() => { stateRef.current = state }, [state])

  /* ── Fade-in from lock screen ── */
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setEntered(true))
    )
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ── 45s inactivity lock — only ticks during true idle ── */
  const resetLockTimer = useCallback(() => {
    clearTimeout(lockTimerRef.current)
    // Only start countdown when absolutely nothing is happening
    if (stateRef.current === 'idle') {
      lockTimerRef.current = setTimeout(() => {
        sessionStorage.setItem('lockReturnPath', '/dashboard')
        navigate('/')
      }, 45_000)
    }
  }, [navigate])

  // Restart/clear timer whenever activity state changes
  useEffect(() => {
    resetLockTimer()
  }, [state, resetLockTimer])

  // Also reset on any user interaction
  useEffect(() => {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const
    events.forEach(e => window.addEventListener(e, resetLockTimer, { passive: true }))
    resetLockTimer()
    return () => {
      clearTimeout(lockTimerRef.current)
      events.forEach(e => window.removeEventListener(e, resetLockTimer))
    }
  }, [resetLockTimer])

  /* ── TTS ── */
  const speak = useCallback((text: string) => {
    speechSynthesis.cancel()

    // Stop recognition while speaking to prevent echo
    try { recognitionRef.current?.stop() } catch { /* ok */ }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    utterance.pitch = 1.0

    const voice = pickVoice()
    if (voice) utterance.voice = voice

    utterance.onstart = () => {
      isSpeakingRef.current = true
      setState('speaking')
    }
    utterance.onend = () => {
      isSpeakingRef.current = false
      setState('listening')
      // Restart recognition after a short gap so mic doesn't catch tail-end audio
      setTimeout(() => {
        if (recognitionRef.current) {
          try { recognitionRef.current.start() } catch { /* already running */ }
        }
      }, 400)
    }
    utterance.onerror = () => {
      isSpeakingRef.current = false
      setState('listening')
      setTimeout(() => {
        if (recognitionRef.current) {
          try { recognitionRef.current.start() } catch { /* already running */ }
        }
      }, 400)
    }

    speechSynthesis.speak(utterance)
  }, [])

  /* ── Ask Groq ── */
  const askGroq = useCallback(async (prompt: string) => {
    setState('processing')
    setTranscript('')

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || `API error ${res.status}`)
      }

      const data = await res.json()
      const answer = data.answer || 'Sorry, I could not understand that.'

      setLastAnswer(answer)
      speak(answer)
    } catch (error: unknown) {
      console.error('Groq error:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState('listening')
    }
  }, [speak])

  /* ── Speech Recognition ── */
  useEffect(() => {
    if (!micEnabled) {
      recognitionRef.current?.stop()
      setState('idle')
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setCameraError('Speech recognition is not supported in this browser.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.maxAlternatives = 1
    recognitionRef.current = recognition

    let silenceTimer: ReturnType<typeof setTimeout> | null = null
    let accumulated = ''                // buffer for final fragments
    let lastInterim = ''                // fallback if isFinal never fires
    let processingLock = false           // prevent double-sends
    const SILENCE_MS = 1800             // 1.8s silence → utterance is done
    const MIN_WORDS = 2
    const MIN_CHARS = 8
    const CONFIDENCE_FLOOR = 0.2        // low threshold — let most speech through

    /** Flush the buffer: if it looks like a real question, send to Groq. */
    const flush = () => {
      if (processingLock || isSpeakingRef.current) return
      let text = accumulated.trim()
      if (!text && lastInterim.trim()) text = lastInterim.trim()
      accumulated = ''
      lastInterim = ''
      if (!text) return

      const words = text.split(/\s+/).length
      if (words < MIN_WORDS || text.length < MIN_CHARS) {
        setTranscript('')
        return
      }
      processingLock = true
      askGroq(text).finally(() => { processingLock = false })
    }

    const clearSilenceTimer = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    }
    const resetSilenceTimer = (ms: number) => {
      clearSilenceTimer()
      silenceTimer = setTimeout(flush, ms)
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (isSpeakingRef.current || processingLock) return

      let interim = ''
      let newFinal = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r.isFinal) {
          if (r[0].confidence > CONFIDENCE_FLOOR) newFinal += r[0].transcript
        } else {
          interim += r[0].transcript
        }
      }

      if (newFinal) {
        accumulated += newFinal
        lastInterim = ''
        setTranscript(accumulated)
        resetSilenceTimer(1200)
      }

      if (interim) {
        lastInterim = interim
        setTranscript(accumulated ? accumulated + ' ' + interim : interim)
        resetSilenceTimer(SILENCE_MS)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      console.warn('Speech recognition error:', event.error)
    }

    recognition.onend = () => {
      // Flush remaining text only if not already processing/speaking
      if (accumulated.trim() && !processingLock && !isSpeakingRef.current) {
        clearSilenceTimer()
        flush()
      } else {
        accumulated = ''
        lastInterim = ''
      }

      // Auto-restart unless mic is disabled or we're speaking
      if (micEnabled && !isSpeakingRef.current) {
        try { recognition.start() } catch { /* already started */ }
      }
    }

    try {
      recognition.start()
      setState('listening')
    } catch (err) {
      console.warn('Could not start speech recognition:', err)
    }

    return () => {
      clearSilenceTimer()
      recognition.onend = null
      recognition.stop()
    }
  }, [micEnabled, askGroq])

  /* ── Ensure voices are loaded ── */
  useEffect(() => {
    speechSynthesis.getVoices()
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices()
  }, [])

  /* ── Status badge text ── */
  const statusText = (() => {
    switch (state) {
      case 'listening': return '🎙️ Listening…'
      case 'processing': return '🧠 Thinking…'
      case 'speaking': return '🔊 Speaking…'
      case 'error': return '⚠️ Error'
      default: return '⏸ Paused'
    }
  })()

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f4fbfe]">
      {/* ── Blue fade-in overlay ────── */}
      <div
        className="pointer-events-none fixed inset-0 z-50 bg-[#20a7db]"
        style={{ opacity: entered ? 0 : 1, transition: 'opacity 800ms cubic-bezier(0.4,0,0.2,1)' }}
      />

      {/* ── Header ── */}
        <header className="shrink-0 bg-[#20a7db]">
          <div className="mx-auto flex w-full items-center gap-2 px-3 py-1.5">
            <div className="shrink-0 flex items-center justify-center">
              <RobotFace mini />
            </div>
            <div className="min-w-0">
              <h1 className="text-xs font-semibold leading-tight tracking-tight text-white">Triage</h1>
              <p className="text-[10px] leading-tight text-white/70">Voice-activated tour guide</p>
            </div>
          <div className="ml-auto shrink-0 rounded-full bg-white/[0.12] px-2 py-0.5 text-[10px] font-medium text-white/80 ring-1 ring-white/[0.15]">
            {statusText}
          </div>
          <EndTripButton />
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex w-full flex-1 min-h-0 gap-3 p-2.5">
        {/* Camera section — takes all available space */}
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[#20a7db]/[0.12] bg-white p-3 shadow-[0_20px_48px_rgba(32,167,219,0.07)]">
          {/* Header row */}
          <div className="flex shrink-0 items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#20a7db]">
                Voice mode
              </p>
              <h2 className="mt-0.5 text-sm font-semibold leading-tight tracking-tight text-slate-900">
                Ask me anything about Albania
              </h2>
            </div>
            {/* Nav buttons */}
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#20a7db]/[0.12] bg-[#f4fbfe] p-1">
              <Button
                onClick={() => setMicEnabled(!micEnabled)}
                size="lg"
                className={`h-9 w-9 rounded-full p-0 shadow-sm ${
                  micEnabled
                    ? 'bg-[#20a7db] shadow-[#20a7db]/25 hover:bg-[#1b96c5]'
                    : 'bg-red-500 shadow-red-500/25 hover:bg-red-600'
                }`}
              >
                {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              </Button>
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

          {/* Camera disabled banner */}
          <div className="relative mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-[#20a7db]/[0.12] bg-slate-900 flex flex-col items-center justify-center gap-3">
            {/* Corner brackets */}
            <div className="pointer-events-none absolute left-2 top-2 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-white/20 z-10" />
            <div className="pointer-events-none absolute right-2 top-2 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-white/20 z-10" />
            <div className="pointer-events-none absolute bottom-2 left-2 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-white/20 z-10" />
            <div className="pointer-events-none absolute bottom-2 right-2 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-white/20 z-10" />

            {/* Camera icon with slash */}
            <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
              <svg className="h-8 w-8 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
              </svg>
              {/* Diagonal slash */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-0.5 w-12 rotate-45 rounded-full bg-red-400/70" />
              </div>
            </div>

            {/* Banner text */}
            <div className="text-center px-6">
              <p className="text-sm font-semibold text-white/80">Camera disabled</p>
              <p className="mt-1 text-xs text-yellow-400/90 font-medium">🚧 Work in progress</p>
              <p className="mt-2 text-xs leading-4 text-white/40">Use your voice to ask me anything about Albania!</p>
            </div>

            {/* Processing overlay */}
            {state === 'processing' && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                <div className="rounded-2xl bg-white/90 px-6 py-4 text-center shadow-lg backdrop-blur">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#20a7db]" />
                  <p className="mt-2 text-xs font-semibold text-slate-900">Thinking…</p>
                </div>
              </div>
            )}

            {/* Transcript overlay — bottom of panel */}
            {transcript && state !== 'idle' && (
              <div className="absolute bottom-3 left-3 right-3 z-20">
                <div className="rounded-xl bg-black/60 px-3 py-2 backdrop-blur-sm">
                  <p className="text-xs text-white/90 leading-4">
                    {state === 'listening' && '🎙️ '}
                    {state === 'processing' && '🧠 '}
                    {transcript}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Subtitle bar */}
          <div className="mt-2 shrink-0 rounded-xl bg-slate-900/85 px-4 py-2 backdrop-blur-sm">
            <p className="text-center text-xs leading-5 text-white/90">
              {state === 'speaking' && lastAnswer
                ? lastAnswer
                : state === 'processing'
                  ? 'Thinking\u2026'
                  : lastAnswer && lastAnswer.startsWith('Error:')
                    ? lastAnswer
                    : transcript && state === 'listening'
                      ? transcript
                      : micEnabled
                         ? 'Ask me anything about Albania\u2026'
                        : 'Microphone paused'}
            </p>
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="flex w-[188px] shrink-0 flex-col rounded-2xl border border-[#20a7db]/[0.12] bg-[#eff9fd] p-3 shadow-sm">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">
            Itinerary planner
          </h3>
          <p className="mt-1 text-xs leading-4 text-slate-600">
            Plan a city trip in Albania by answering a few quick questions.
          </p>

          <div className="mt-3 space-y-2">
            {PLANNER_STEPS.map((item, i) => (
              <div key={item} className="flex items-start gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-semibold text-[#20a7db]">
                  {i + 1}
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
