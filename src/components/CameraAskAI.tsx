import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map, MapPin, Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import RobotControls from './RobotControls'
import EndTripButton from './EndTripButton'

type AssistantState = 'listening' | 'processing' | 'speaking' | 'error' | 'idle'

const PLANNER_STEPS = [
  'Choose an Albanian city.',
  'Answer a short survey.',
  'Get a personal itinerary.',
]

const MIN_WORDS = 2
const MIN_CHARS = 8
const SNAPSHOT_TIMEOUT_MS = 2_000
const ASK_TIMEOUT_MS = 20_000

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error'
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices()
  const priorities: Array<(v: SpeechSynthesisVoice) => boolean> = [
    v => /Natural/i.test(v.name) && v.lang.startsWith('en'),
    v => v.name.includes('Google UK English Female'),
    v => v.name.includes('Google US English'),
    v => v.name.includes('Google') && v.lang.startsWith('en'),
    v => v.name.includes('Microsoft') && v.lang.startsWith('en') && !v.localService,
    v => v.lang.startsWith('en') && !v.localService,
    v => v.lang.startsWith('en'),
  ]
  for (const test of priorities) {
    const match = voices.find(test)
    if (match) return match
  }
  return null
}

interface TranscriptPayload {
  id: number | null
  text: string | null
  source?: string
}

export default function CameraAskAI() {
  const navigate = useNavigate()

  const isSpeakingRef = useRef(false)
  const processingRef = useRef(false)
  const speechFallbackTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const stateRef = useRef<AssistantState>('idle')
  const latestFrameRef = useRef<string | null>(null)

  const [entered, setEntered] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [state, setState] = useState<AssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')
  const [micEnabled, setMicEnabled] = useState(true)
  const [feedSrc, setFeedSrc] = useState<string | null>(null)

  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setEntered(true))
    )
    return () => cancelAnimationFrame(raf)
  }, [])

  const resetLockTimer = useCallback(() => {
    clearTimeout(lockTimerRef.current)
    if (stateRef.current === 'idle') {
      lockTimerRef.current = setTimeout(() => {
        sessionStorage.setItem('lockReturnPath', '/dashboard')
        navigate('/')
      }, 45_000)
    }
  }, [navigate])

  useEffect(() => {
    resetLockTimer()
  }, [state, resetLockTimer])

  useEffect(() => {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const
    events.forEach(e => window.addEventListener(e, resetLockTimer, { passive: true }))
    resetLockTimer()
    return () => {
      clearTimeout(lockTimerRef.current)
      events.forEach(e => window.removeEventListener(e, resetLockTimer))
    }
  }, [resetLockTimer])

  const mjpegUrl = (window as any).__TRIAGE_CAMERA_URL
    || import.meta.env.VITE_CAMERA_STREAM_URL
    || null

  useEffect(() => {
    if (mjpegUrl) {
      setFeedSrc(mjpegUrl)
      setCameraReady(true)
      latestFrameRef.current = '__mjpeg_stream__'
      return
    }

    let cancelled = false
    let consecutiveErrors = 0

    const poll = async () => {
      while (!cancelled) {
        try {
          const res = await fetch('/api/camera-feed')
          if (res.status === 200) {
            const data = await res.json()
            if (data.image) {
              const src = `data:image/jpeg;base64,${data.image}`
              setFeedSrc(src)
              latestFrameRef.current = data.image
              if (!cameraReady) setCameraReady(true)
              if (cameraError) setCameraError(null)
              consecutiveErrors = 0
            }
          } else if (res.status === 204) {
            if (!cameraReady && consecutiveErrors > 10) {
              setCameraError('Waiting for camera feed from robot…')
            }
            consecutiveErrors++
          }
        } catch {
          consecutiveErrors++
          if (consecutiveErrors > 10 && !cameraError) {
            setCameraError('Cannot reach camera feed')
          }
        }
        await new Promise(r => setTimeout(r, 200))
      }
    }

    poll()
    return () => { cancelled = true }
  }, [mjpegUrl, cameraError, cameraReady])

  const speak = useCallback((text: string) => {
    clearTimeout(speechFallbackTimerRef.current)
    speechSynthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    utterance.pitch = 1.0

    const voice = pickVoice()
    if (voice) utterance.voice = voice

    const finishSpeaking = () => {
      clearTimeout(speechFallbackTimerRef.current)
      isSpeakingRef.current = false
      setState(micEnabled ? 'listening' : 'idle')
    }
    isSpeakingRef.current = true
    setState('speaking')

    utterance.onstart = () => {
      clearTimeout(speechFallbackTimerRef.current)
    }
    utterance.onend = finishSpeaking
    utterance.onerror = () => {
      finishSpeaking()
    }

    const estimatedMs = Math.min(12_000, Math.max(4_000, text.split(/\s+/).length * 450))
    speechFallbackTimerRef.current = setTimeout(() => {
      finishSpeaking()
    }, estimatedMs)

    speechSynthesis.speak(utterance)
  }, [micEnabled])

  const askAI = useCallback(async (prompt: string) => {
    processingRef.current = true
    setState('processing')

    try {
      let image: string | null = latestFrameRef.current
      if (image === '__mjpeg_stream__' && mjpegUrl) {
        try {
          const snapUrl = mjpegUrl.replace('/stream', '/frame')
          const snapRes = await fetchWithTimeout(snapUrl, {}, SNAPSHOT_TIMEOUT_MS)
          if (snapRes.ok) {
            const blob = await snapRes.blob()
            const reader = new FileReader()
            image = await new Promise((resolve) => {
              reader.onloadend = () => {
                const result = reader.result as string
                resolve(result.split(',')[1] || null)
              }
              reader.readAsDataURL(blob)
            })
          }
        } catch {
          image = null
        }
      }

      const res = await fetchWithTimeout('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, prompt }),
      }, ASK_TIMEOUT_MS)

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || `API error ${res.status}`)
      }

      const data = await res.json()
      const answer = data.answer || 'Sorry, I could not understand that.'
      setLastAnswer(answer)
      speak(answer)
    } catch (error: unknown) {
      console.error('AI error:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState(micEnabled ? 'listening' : 'idle')
    } finally {
      processingRef.current = false
    }
  }, [mjpegUrl, speak, micEnabled])

  useEffect(() => {
    if (!micEnabled) {
      setState('idle')
      return
    }

    setState(current => current === 'idle' ? 'listening' : current)

    let cancelled = false

    const pollTranscript = async () => {
      while (!cancelled) {
        if (processingRef.current || isSpeakingRef.current) {
          await new Promise(r => setTimeout(r, 400))
          continue
        }

        try {
          const res = await fetch('/api/transcript')
          if (res.ok) {
            const data = await res.json() as TranscriptPayload
            const text = data.text?.trim() || ''

            if (text) {
              const words = text.split(/\s+/).filter(Boolean).length
              if (words >= MIN_WORDS && text.length >= MIN_CHARS) {
                setTranscript(text)
                await askAI(text)
              }
            } else if (!processingRef.current && !isSpeakingRef.current) {
              setState('listening')
            }
          }
        } catch (error) {
          console.warn('Transcript poll failed:', error)
        }

        await new Promise(r => setTimeout(r, 500))
      }
    }

    pollTranscript()
    return () => { cancelled = true }
  }, [askAI, micEnabled])

  useEffect(() => {
    speechSynthesis.getVoices()
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices()
    return () => clearTimeout(speechFallbackTimerRef.current)
  }, [])

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
            <p className="text-[10px] leading-tight text-white/70">Voice-activated tour guide</p>
          </div>
          <div className="ml-auto shrink-0 rounded-full bg-white/[0.12] px-2 py-0.5 text-[10px] font-medium text-white/80 ring-1 ring-white/[0.15]">
            {statusText}
          </div>
          <EndTripButton />
        </div>
      </header>

      <main className="flex w-full flex-1 min-h-0 gap-3 p-2.5">
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[#20a7db]/[0.12] bg-white p-3 shadow-[0_20px_48px_rgba(32,167,219,0.07)]">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#20a7db]">
                Camera mode
              </p>
              <h2 className="mt-0.5 text-sm font-semibold leading-tight tracking-tight text-slate-900">
                Ask me anything about what you see
              </h2>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#20a7db]/[0.12] bg-[#f4fbfe] p-1">
              <Button
                onClick={() => setMicEnabled(!micEnabled)}
                size="lg"
                title={micEnabled ? 'Pause transcript relay' : 'Resume transcript relay'}
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

          <div className="relative mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-[#20a7db]/[0.12] bg-black">
            <div className="pointer-events-none absolute left-2 top-2 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute right-2 top-2 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute bottom-2 left-2 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute bottom-2 right-2 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-white/40 z-10" />

            <div className="absolute left-2 top-2 z-20 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur-sm">
              {cameraReady ? 'Live' : cameraError ? 'Error' : 'Starting…'}
            </div>

            {feedSrc ? (
              <img
                src={feedSrc}
                alt="Robot camera"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                {cameraError ? (
                  <div className="text-center px-4">
                    <span className="text-lg">📷</span>
                    <p className="mt-2 text-xs font-medium text-white/70">{cameraError}</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#20a7db]/60" />
                    <p className="mt-2 text-[10px] text-white/50">Connecting to camera…</p>
                  </div>
                )}
              </div>
            )}

            {state === 'processing' && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-sm">
                <div className="rounded-2xl bg-white/90 px-6 py-4 text-center shadow-lg backdrop-blur">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#20a7db]" />
                  <p className="mt-2 text-xs font-semibold text-slate-900">Analyzing…</p>
                </div>
              </div>
            )}

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
                        ? 'Waiting for transcript from PC\u2026'
                        : 'Transcript relay paused'}
            </p>
          </div>
        </section>

        <aside className="flex w-[188px] shrink-0 flex-col gap-3 rounded-2xl border border-[#20a7db]/[0.12] bg-[#eff9fd] p-3 shadow-sm">
          <RobotControls />

          <div className="mt-auto">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Itinerary planner
            </h3>
            <div className="mt-1.5 space-y-1.5">
              {PLANNER_STEPS.map((item, i) => (
                <div key={item} className="flex items-start gap-1.5">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-semibold text-[#20a7db]">
                    {i + 1}
                  </span>
                  <p className="text-[10px] leading-4 text-slate-600">{item}</p>
                </div>
              ))}
            </div>

            <div className="mt-2 grid gap-1.5">
              <Button
                onClick={() => navigate('/itinerary')}
                className="h-8 bg-[#20a7db] text-[10px] shadow-sm shadow-[#20a7db]/25 hover:bg-[#1b96c5]"
              >
                Open planner
              </Button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
