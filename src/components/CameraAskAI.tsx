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
const STT_TARGET_SAMPLE_RATE = 16_000
const MAX_RECORDING_MS = 12_000

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

function concatFloat32Chunks(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function downsampleTo16k(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input

  const ratio = sourceRate / targetRate
  const newLength = Math.round(input.length / ratio)
  const output = new Float32Array(newLength)

  let offsetResult = 0
  let offsetBuffer = 0
  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    let accum = 0
    let count = 0

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i]
      count++
    }

    output[offsetResult] = count > 0 ? accum / count : 0
    offsetResult++
    offsetBuffer = nextOffsetBuffer
  }

  return output
}

function encodeWavBase64(input: Float32Array, sourceRate: number, targetRate: number) {
  const mono = downsampleTo16k(input, sourceRate, targetRate)
  const buffer = new ArrayBuffer(44 + mono.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + mono.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, mono.length * 2, true)

  let offset = 44
  for (let i = 0; i < mono.length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }

  return btoa(binary)
}

export default function CameraAskAI() {
  const navigate = useNavigate()

  const isSpeakingRef = useRef(false)
  const processingRef = useRef(false)
  const speechFallbackTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const stateRef = useRef<AssistantState>('idle')
  const latestFrameRef = useRef<string | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const muteGainRef = useRef<GainNode | null>(null)
  const audioChunksRef = useRef<Float32Array[]>([])

  const [entered, setEntered] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [state, setState] = useState<AssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')
  const [micEnabled, setMicEnabled] = useState(false)
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

  const cleanupRecording = useCallback(async () => {
    clearTimeout(recordTimeoutRef.current)
    audioProcessorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    muteGainRef.current?.disconnect()
    audioStreamRef.current?.getTracks().forEach(track => track.stop())

    audioProcessorRef.current = null
    audioSourceRef.current = null
    muteGainRef.current = null
    audioStreamRef.current = null
    audioChunksRef.current = []

    if (audioContextRef.current) {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }
  }, [])

  const speak = useCallback(async (text: string) => {
    clearTimeout(speechFallbackTimerRef.current)

    const finishSpeaking = () => {
      clearTimeout(speechFallbackTimerRef.current)
      isSpeakingRef.current = false
      setState('idle')
    }
    isSpeakingRef.current = true
    setState('speaking')

    const estimatedMs = Math.min(12_000, Math.max(4_000, text.split(/\s+/).length * 450))
    speechFallbackTimerRef.current = setTimeout(() => {
      finishSpeaking()
    }, estimatedMs)

    try {
      const res = await fetchWithTimeout('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }, 35_000)

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || `TTS error ${res.status}`)
      }
    } finally {
      finishSpeaking()
    }
  }, [])

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
      try {
        await speak(answer)
      } catch (error) {
        console.error('TTS error:', error)
      }
    } catch (error: unknown) {
      console.error('AI error:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState('idle')
    } finally {
      processingRef.current = false
    }
  }, [mjpegUrl, speak])

  const transcribeCapturedAudio = useCallback(async () => {
    const context = audioContextRef.current
    const chunks = audioChunksRef.current
    if (!context || chunks.length === 0) {
      setState('idle')
      setMicEnabled(false)
      return
    }

    const merged = concatFloat32Chunks(chunks)
    const wavAudio = encodeWavBase64(merged, context.sampleRate, STT_TARGET_SAMPLE_RATE)

    setState('processing')
    const res = await fetchWithTimeout('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wavAudio }),
    }, 120_000)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(errText || `STT error ${res.status}`)
    }

    const data = await res.json()
    const text = (data.text as string | undefined)?.trim() || ''
    if (!text || text.length < MIN_CHARS || text.split(/\s+/).filter(Boolean).length < MIN_WORDS) {
      setTranscript('')
      setState('idle')
      setMicEnabled(false)
      return
    }

    setTranscript(text)
    setMicEnabled(false)
    await askAI(text)
  }, [askAI])

  const stopBrowserCapture = useCallback(async () => {
    try {
      await transcribeCapturedAudio()
    } finally {
      await cleanupRecording()
    }
  }, [cleanupRecording, transcribeCapturedAudio])

  const startBrowserCapture = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      throw new Error('Browser microphone capture is not supported here.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    const context = new window.AudioContext()
    await context.resume()

    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const muteGain = context.createGain()
    muteGain.gain.value = 0

    audioStreamRef.current = stream
    audioContextRef.current = context
    audioSourceRef.current = source
    audioProcessorRef.current = processor
    muteGainRef.current = muteGain
    audioChunksRef.current = []

    processor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0)
      audioChunksRef.current.push(new Float32Array(input))
    }

    source.connect(processor)
    processor.connect(muteGain)
    muteGain.connect(context.destination)

    setTranscript('')
    setLastAnswer('')
    setState('listening')
    setMicEnabled(true)

    recordTimeoutRef.current = setTimeout(() => {
      void stopBrowserCapture()
    }, MAX_RECORDING_MS)
  }, [stopBrowserCapture])

  const toggleMicCapture = useCallback(async () => {
    if (processingRef.current || isSpeakingRef.current) return

    if (micEnabled) {
      try {
        await stopBrowserCapture()
      } catch (error) {
        console.error('Browser STT stop failed:', error)
        setLastAnswer(`Error: ${getErrorMessage(error)}`)
        setState('error')
        setMicEnabled(false)
      }
      return
    }

    try {
      await cleanupRecording()
      await startBrowserCapture()
    } catch (error) {
      console.error('Browser STT start failed:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState('error')
      setMicEnabled(false)
      await cleanupRecording()
    }
  }, [cleanupRecording, micEnabled, startBrowserCapture, stopBrowserCapture])

  useEffect(() => () => {
    clearTimeout(speechFallbackTimerRef.current)
    void cleanupRecording()
  }, [cleanupRecording])

  const statusText = (() => {
    switch (state) {
      case 'listening': return '🎙️ Recording…'
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
                onClick={() => void toggleMicCapture()}
                size="lg"
                title={micEnabled ? 'Stop recording and transcribe' : 'Start browser microphone recording'}
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
                        ? 'Recording from Chromium microphone\u2026 tap the mic again to send'
                        : 'Tap the mic to speak'}
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
