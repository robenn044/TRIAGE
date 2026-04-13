import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map, MapPin, Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import EndTripButton from './EndTripButton'

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

function snapFrame(video: HTMLVideoElement, quality = 0.85): string {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')!
  ctx.translate(canvas.width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0)
  return canvas.toDataURL('image/jpeg', quality).split(',')[1]
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

export default function CameraAskAI() {
  const navigate = useNavigate()

  const videoRef = useRef<HTMLVideoElement>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const isSpeakingRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const stateRef = useRef<AssistantState>('idle')
  const cameraReadyRef = useRef(false)

  const [entered, setEntered] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraErrorDetail, setCameraErrorDetail] = useState<string | null>(null)
  const [cameraRetry, setCameraRetry] = useState(0)
  const [diagLog, setDiagLog] = useState<string[]>([])
  const [state, setState] = useState<AssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')
  const [micEnabled, setMicEnabled] = useState(true)

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

  useEffect(() => {
    let cancelled = false
    cameraReadyRef.current = false
    setCameraError(null)
    setCameraErrorDetail(null)
    setCameraReady(false)
    setDiagLog([])

    const ts = () => new Date().toISOString().slice(11, 23)
    const log = (msg: string) => setDiagLog(prev => [...prev, `[${ts()}] ${msg}`])

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            const e = new Error(label)
            ;(e as { name: string }).name = 'TimeoutError'
            reject(e)
          }, ms)
        ),
      ])
    }

    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    let framePoller: ReturnType<typeof setInterval> | null = null

    ;(async () => {
      log(`protocol: ${window.location.protocol}`)
      log(`mediaDevices: ${!!navigator.mediaDevices}`)
      log(`getUserMedia: ${typeof navigator.mediaDevices?.getUserMedia}`)
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        log('FAIL: Camera API not available')
        if (!cancelled) {
          setCameraError('Camera API not available')
          setCameraErrorDetail(
            window.location.protocol !== 'https:'
              ? 'Page is not on HTTPS. Camera requires a secure connection.'
              : 'navigator.mediaDevices is missing. Use Chromium or Firefox.'
          )
        }
        return
      }

      let videoDeviceCount = 0
      log('calling enumerateDevices...')
      try {
        const devices = await withTimeout(
          navigator.mediaDevices.enumerateDevices(),
          3_000,
          'enumerateDevices timed out'
        )
        const videoDevs = devices.filter(d => d.kind === 'videoinput')
        videoDeviceCount = videoDevs.length
        log(`enumerateDevices OK: ${devices.length} total, ${videoDeviceCount} videoinput`)
        videoDevs.forEach((d, i) => log(`  cam[${i}]: ${d.label || '(no label)'} id=${d.deviceId.slice(0, 8)}`))
      } catch (e) {
        log(`enumerateDevices FAILED: ${(e as Error).name} — ${(e as Error).message} (skipping, continuing to getUserMedia)`)
      }
      if (cancelled) return

      const attempts: MediaStreamConstraints[] = [
        { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
        { video: true, audio: false },
      ]
      let stream: MediaStream | null = null
      let lastError: unknown = null

      for (let i = 0; i < attempts.length; i++) {
        if (cancelled) break
        log(`getUserMedia attempt ${i + 1}/${attempts.length}...`)
        try {
          stream = await withTimeout(navigator.mediaDevices.getUserMedia(attempts[i]), 10_000, 'timeout')
          log(`getUserMedia attempt ${i + 1}: SUCCESS`)
          break
        } catch (err) {
          lastError = err
          const e = err as { name?: string; message?: string }
          log(`getUserMedia attempt ${i + 1}: FAIL name=${e.name} msg=${e.message}`)
          if (e.name === 'TimeoutError') break
        }
      }

      if (cancelled) {
        stream?.getTracks().forEach(t => t.stop())
        return
      }

      if (!stream) {
        const err = lastError as { name?: string; message?: string } | null
        const name = err?.name ?? ''
        let summary = 'Camera error'
        let detail = err?.message ?? 'Unknown error'

        if (name === 'TimeoutError') {
          summary = 'Chromium camera blocked (xdg-portal missing)'
          detail =
            'Both enumerateDevices and getUserMedia hung — this often means xdg-desktop-portal is missing on Raspberry Pi OS.' +
            '\n\nTry:' +
            '\n  sudo apt install xdg-desktop-portal xdg-desktop-portal-gtk' +
            '\n  sudo reboot'
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          summary = 'No camera found'
          detail = videoDeviceCount === 0
            ? 'The browser sees 0 video devices. Check the webcam connection and system permissions.'
            : `Browser detected ${videoDeviceCount} device(s) but could not open one. Unplug and replug the webcam, then tap Retry.`
        } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          summary = 'Camera permission denied'
          detail = 'Allow camera access for this site in the browser, then tap Retry.'
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          summary = 'Camera already in use'
          detail = 'Another application has the webcam open. Close it, then tap Retry.'
        } else if (name === 'OverconstrainedError') {
          summary = 'Camera constraints rejected'
          detail = 'Tap Retry — it will request the camera with no constraints.'
        }

        if (!cancelled) {
          setCameraError(summary)
          setCameraErrorDetail(detail)
        }
        log(`FAIL: ${summary} — ${detail.split('\n')[0]}`)
        return
      }

      const vTracks = stream.getVideoTracks()
      log(`stream tracks: ${stream.getTracks().length} total, ${vTracks.length} video`)
      vTracks.forEach((t, i) => log(`  track[${i}]: ${t.label} readyState=${t.readyState}`))
      if (vTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop())
        if (!cancelled) {
          setCameraError('No video in stream')
          setCameraErrorDetail('getUserMedia returned a stream with no video tracks. Unplug and replug the webcam then tap Retry.')
        }
        log('FAIL: no video tracks in stream')
        return
      }

      streamRef.current = stream
      log('stream assigned to video element, polling for frames...')

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(e => log(`play() error: ${(e as Error).message}`))

        let pollCount = 0
        framePoller = setInterval(() => {
          if (cancelled) {
            clearInterval(framePoller!)
            return
          }
          const vid = videoRef.current
          pollCount++
          if (pollCount % 10 === 0) {
            log(`poll ${pollCount}: videoWidth=${vid?.videoWidth ?? 'N/A'} videoHeight=${vid?.videoHeight ?? 'N/A'} readyState=${vid?.readyState ?? 'N/A'}`)
          }
          if (vid && vid.videoWidth > 0 && vid.videoHeight > 0) {
            clearInterval(framePoller!)
            framePoller = null
            if (watchdogTimer) {
              clearTimeout(watchdogTimer)
              watchdogTimer = null
            }
            log(`OK: first frame ${vid.videoWidth}x${vid.videoHeight} after ${pollCount * 200}ms`)
            cameraReadyRef.current = true
            setCameraReady(true)
          }
        }, 200)

        watchdogTimer = setTimeout(() => {
          if (framePoller) {
            clearInterval(framePoller)
            framePoller = null
          }
          if (!cancelled && !cameraReadyRef.current) {
            const vid = videoRef.current
            log(`WATCHDOG fired: videoWidth=${vid?.videoWidth} videoHeight=${vid?.videoHeight} readyState=${vid?.readyState}`)
            stream?.getTracks().forEach(t => {
              log(`  stopping track: ${t.label} state=${t.readyState}`)
              t.stop()
            })
            setCameraError('Camera opened but sent no frames')
            setCameraErrorDetail('The webcam connected but produced no video data in 8 seconds.')
          }
        }, 8_000)
      }
    })()

    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
      if (framePoller) clearInterval(framePoller)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [cameraRetry])

  const speak = useCallback((text: string) => {
    speechSynthesis.cancel()

    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }

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
      setTimeout(() => {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.start()
          } catch {
            // ignore
          }
        }
      }, 400)
    }
    utterance.onerror = () => {
      isSpeakingRef.current = false
      setState('listening')
      setTimeout(() => {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.start()
          } catch {
            // ignore
          }
        }
      }, 400)
    }

    speechSynthesis.speak(utterance)
  }, [])

  const askGroq = useCallback(async (prompt: string) => {
    setState('processing')
    setTranscript('')

    try {
      let image: string | null = null
      if (videoRef.current && videoRef.current.readyState >= 2) {
        image = snapFrame(videoRef.current)
      }

      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, prompt }),
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
    let accumulated = ''
    let lastInterim = ''
    let processingLock = false
    const SILENCE_MS = 1800
    const MIN_WORDS = 2
    const MIN_CHARS = 8
    const CONFIDENCE_FLOOR = 0.2

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
      askGroq(text).finally(() => {
        processingLock = false
      })
    }

    const clearSilenceTimer = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
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
      if (accumulated.trim() && !processingLock && !isSpeakingRef.current) {
        clearSilenceTimer()
        flush()
      } else {
        accumulated = ''
        lastInterim = ''
      }

      if (micEnabled && !isSpeakingRef.current) {
        try {
          recognition.start()
        } catch {
          // ignore
        }
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

  useEffect(() => {
    speechSynthesis.getVoices()
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices()
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

            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />

            {(cameraError || (!cameraReady && diagLog.length > 0)) && (
              <div className="absolute inset-0 flex flex-col bg-slate-900/97 z-30 p-3 overflow-hidden">
                <div className="flex-1 overflow-y-auto mb-3 rounded-lg bg-black/40 p-2 font-mono">
                  <p className="text-[9px] font-semibold text-[#20a7db] uppercase tracking-wider mb-1">Camera diagnostics</p>
                  {diagLog.map((line, i) => (
                    <p
                      key={i}
                      className={`text-[10px] leading-4 whitespace-pre-wrap break-all ${
                        line.includes('FAIL') || line.includes('WATCHDOG') ? 'text-red-400' :
                        line.includes('OK:') || line.includes('SUCCESS') ? 'text-green-400' :
                        line.includes('poll') ? 'text-slate-500' : 'text-slate-300'
                      }`}
                    >
                      {line}
                    </p>
                  ))}
                  {!cameraError && !cameraReady && (
                    <p className="text-[10px] text-yellow-400 animate-pulse">⏳ waiting...</p>
                  )}
                </div>

                {cameraError && (
                  <div className="shrink-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">📷</span>
                      <p className="text-sm font-bold text-white">{cameraError}</p>
                    </div>
                    {cameraErrorDetail && (
                      <p className="text-[11px] text-white/70 leading-5 mb-3 whitespace-pre-line">{cameraErrorDetail}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setCameraRetry(r => r + 1)}
                        className="flex-1 rounded-xl bg-[#20a7db] py-2 text-xs font-semibold text-white hover:bg-[#1b96c5] transition-colors"
                      >
                        🔄 Retry
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(diagLog.join('\n')).catch(() => {})}
                        className="rounded-xl border border-white/20 px-3 py-2 text-xs font-semibold text-white/70 hover:text-white transition-colors"
                      >
                        📋 Copy log
                      </button>
                    </div>
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
                  ? 'Thinking…'
                  : lastAnswer && lastAnswer.startsWith('Error:')
                    ? lastAnswer
                    : transcript && state === 'listening'
                      ? transcript
                      : micEnabled
                        ? 'Ask me anything about what you see…'
                        : 'Microphone paused'}
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
