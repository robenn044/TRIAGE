import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map, MapPin, Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import RobotControls from './RobotControls'
import EndTripButton from './EndTripButton'

/* ── Types ─────────────────────────────────────────────── */
type AssistantState = 'listening' | 'processing' | 'speaking' | 'error' | 'idle'

const PLANNER_STEPS = [
  'Choose an Albanian city.',
  'Answer a short survey.',
  'Get a personal itinerary.',
]

const STT_TARGET_SAMPLE_RATE = 16_000
const STT_RMS_FLOOR = 0.02
const STT_SILENCE_MS = 1_200
const STT_MIN_AUDIO_MS = 900
const STT_MIN_WORDS = 2
const STT_MIN_CHARS = 8
const STT_MIN_VOICED_CHUNKS = 4
const STT_CALIBRATION_MS = 1_500

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error'
}

/* ── Helpers ───────────────────────────────────────────── */

/** Capture a JPEG frame from a <video> element, return base64 (no prefix).
 *  Applies scaleX(-1) to match the display correction for the hardware-mirrored webcam. */
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

function getAudioContextCtor() {
  return window.AudioContext
}

export default function CameraAskAI() {
  const navigate = useNavigate()

  /* ── Refs ── */
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const muteGainRef = useRef<GainNode | null>(null)
  const audioChunksRef = useRef<Float32Array[]>([])
  const captureActiveRef = useRef(false)
  const processingRef = useRef(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicedChunkCountRef = useRef(0)
  const noiseFloorRef = useRef(STT_RMS_FLOOR)
  const calibrationStartedAtRef = useRef<number | null>(null)
  const isSpeakingRef = useRef(false)
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const stateRef = useRef<AssistantState>('idle')
  // Stores latest base64 frame from server for AI requests
  const latestFrameRef = useRef<string | null>(null)

  /* ── State ── */
  const [entered, setEntered] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [state, setState] = useState<AssistantState>('idle')
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')
  const [micEnabled, setMicEnabled] = useState(true)
  // Server camera feed as data URL
  const [feedSrc, setFeedSrc] = useState<string | null>(null)

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

  /* ── Camera feed: MJPEG stream (LAN) with Vercel fallback ── */
  // MJPEG URL: injected by serve_dashboard.py at runtime, or set via env var
  const mjpegUrl = (window as any).__TRIAGE_CAMERA_URL
    || import.meta.env.VITE_CAMERA_STREAM_URL
    || null

  useEffect(() => {
    // If MJPEG URL is configured, use it directly (no polling needed)
    if (mjpegUrl) {
      setFeedSrc(mjpegUrl)
      setCameraReady(true)
      latestFrameRef.current = '__mjpeg_stream__'
      return
    }

    // Fallback: poll Vercel /api/camera-feed (slower, for remote access)
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
  }, [mjpegUrl])

  /* ── TTS ── */
  const speak = useCallback((text: string) => {
    speechSynthesis.cancel()

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
      setState(micEnabled ? 'listening' : 'idle')
    }
    utterance.onerror = () => {
      isSpeakingRef.current = false
      setState(micEnabled ? 'listening' : 'idle')
    }

    speechSynthesis.speak(utterance)
  }, [micEnabled])

  /* ── Ask AI ── */
  const askAI = useCallback(async (prompt: string) => {
    processingRef.current = true
    setState('processing')

    try {
      // Get the latest frame for AI analysis
      let image: string | null = latestFrameRef.current
      // If using MJPEG stream, fetch a snapshot from Face Pi for AI
      if (image === '__mjpeg_stream__' && mjpegUrl) {
        try {
          const snapUrl = mjpegUrl.replace('/stream', '/frame')
          const snapRes = await fetch(snapUrl)
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
      console.error('AI error:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState(micEnabled ? 'listening' : 'idle')
    } finally {
      processingRef.current = false
    }
  }, [speak, mjpegUrl, micEnabled])

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  const transcribeSegment = useCallback(async (samples: Float32Array, sampleRate: number) => {
    const wavAudio = encodeWavBase64(samples, sampleRate, STT_TARGET_SAMPLE_RATE)
    const res = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wavAudio }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(errText || `STT error ${res.status}`)
    }

    const data = await res.json()
    return (data.text as string | undefined)?.trim() || ''
  }, [])

  const flushCapturedAudio = useCallback(async () => {
    clearSilenceTimer()

    if (!captureActiveRef.current || processingRef.current || isSpeakingRef.current) {
      return
    }

    captureActiveRef.current = false
    const chunks = audioChunksRef.current
    audioChunksRef.current = []
    const voicedChunks = voicedChunkCountRef.current
    voicedChunkCountRef.current = 0

    const context = audioContextRef.current
    if (!context || chunks.length === 0) {
      return
    }

    const merged = concatFloat32Chunks(chunks)
    const durationMs = (merged.length / context.sampleRate) * 1000
    if (durationMs < STT_MIN_AUDIO_MS || voicedChunks < STT_MIN_VOICED_CHUNKS) {
      setTranscript('')
      setState(micEnabled ? 'listening' : 'idle')
      return
    }

    try {
      setState('processing')
      const text = await transcribeSegment(merged, context.sampleRate)
      if (!text) {
        setTranscript('')
        setState(micEnabled ? 'listening' : 'idle')
        return
      }

      const words = text.split(/\s+/).filter(Boolean).length
      if (words < STT_MIN_WORDS || text.length < STT_MIN_CHARS) {
        setTranscript('')
        setState(micEnabled ? 'listening' : 'idle')
        return
      }

      setTranscript(text)
      await askAI(text)
    } catch (error: unknown) {
      console.error('STT error:', error)
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState(micEnabled ? 'listening' : 'idle')
    }
  }, [askAI, clearSilenceTimer, micEnabled, transcribeSegment])

  /* ── Offline STT Capture ── */
  useEffect(() => {
    if (!micEnabled) {
      clearSilenceTimer()
      captureActiveRef.current = false
      audioChunksRef.current = []
      voicedChunkCountRef.current = 0
      calibrationStartedAtRef.current = null

      audioProcessorRef.current?.disconnect()
      audioSourceRef.current?.disconnect()
      muteGainRef.current?.disconnect()
      audioStreamRef.current?.getTracks().forEach(track => track.stop())
      void audioContextRef.current?.close()

      audioProcessorRef.current = null
      audioSourceRef.current = null
      muteGainRef.current = null
      audioStreamRef.current = null
      audioContextRef.current = null
      setState('idle')
      return
    }

    const AudioContextCtor = getAudioContextCtor()
    if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
      setLastAnswer('Error: Microphone capture is not supported in this browser.')
      setState('error')
      return
    }

    let cancelled = false

    const startCapture = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        const context = new AudioContextCtor()
        await context.resume()

        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4096, 1, 1)
        const muteGain = context.createGain()
        muteGain.gain.value = 0

        source.connect(processor)
        processor.connect(muteGain)
        muteGain.connect(context.destination)

        audioStreamRef.current = stream
        audioContextRef.current = context
        audioSourceRef.current = source
        audioProcessorRef.current = processor
        muteGainRef.current = muteGain
        calibrationStartedAtRef.current = Date.now()
        noiseFloorRef.current = STT_RMS_FLOOR
        setState('listening')

        processor.onaudioprocess = (event) => {
          if (!micEnabled || processingRef.current || isSpeakingRef.current) {
            return
          }

          const input = event.inputBuffer.getChannelData(0)
          const chunk = new Float32Array(input)
          const sumSquares = chunk.reduce((sum, sample) => sum + sample * sample, 0)
          const rms = Math.sqrt(sumSquares / chunk.length)
          const calibrationStartedAt = calibrationStartedAtRef.current ?? Date.now()
          if (Date.now() - calibrationStartedAt < STT_CALIBRATION_MS) {
            noiseFloorRef.current = Math.max(
              STT_RMS_FLOOR,
              noiseFloorRef.current * 0.9 + rms * 0.1,
            )
            return
          }

          const dynamicThreshold = Math.max(STT_RMS_FLOOR, noiseFloorRef.current * 3)
          const hasSpeech = rms >= dynamicThreshold

          if (hasSpeech && !captureActiveRef.current) {
            captureActiveRef.current = true
            audioChunksRef.current = []
            voicedChunkCountRef.current = 0
          }

          if (captureActiveRef.current) {
            audioChunksRef.current.push(chunk)
          }

          if (hasSpeech) {
            voicedChunkCountRef.current += 1
            clearSilenceTimer()
            silenceTimerRef.current = setTimeout(() => {
              void flushCapturedAudio()
            }, STT_SILENCE_MS)
          }
        }
      } catch (error: unknown) {
        console.error('Microphone setup failed:', error)
        setLastAnswer(`Error: ${getErrorMessage(error)}`)
        setState('error')
      }
    }

    void startCapture()

    return () => {
      cancelled = true
      clearSilenceTimer()
      captureActiveRef.current = false
      audioChunksRef.current = []
      voicedChunkCountRef.current = 0
      calibrationStartedAtRef.current = null
      audioProcessorRef.current?.disconnect()
      audioSourceRef.current?.disconnect()
      muteGainRef.current?.disconnect()
      audioStreamRef.current?.getTracks().forEach(track => track.stop())
      void audioContextRef.current?.close()
      audioProcessorRef.current = null
      audioSourceRef.current = null
      muteGainRef.current = null
      audioStreamRef.current = null
      audioContextRef.current = null
    }
  }, [clearSilenceTimer, flushCapturedAudio, micEnabled])

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
                Camera mode
              </p>
              <h2 className="mt-0.5 text-sm font-semibold leading-tight tracking-tight text-slate-900">
                Ask me anything about what you see
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

          {/* Live camera viewport */}
          <div className="relative mt-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-[#20a7db]/[0.12] bg-black">
            {/* Corner brackets */}
            <div className="pointer-events-none absolute left-2 top-2 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute right-2 top-2 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute bottom-2 left-2 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-white/40 z-10" />
            <div className="pointer-events-none absolute bottom-2 right-2 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-white/40 z-10" />

            {/* Status badge */}
            <div className="absolute left-2 top-2 z-20 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur-sm">
              {cameraReady ? 'Live' : cameraError ? 'Error' : 'Starting…'}
            </div>

            {/* Camera feed from server */}
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

            {/* Processing overlay */}
            {state === 'processing' && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 backdrop-blur-sm">
                <div className="rounded-2xl bg-white/90 px-6 py-4 text-center shadow-lg backdrop-blur">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#20a7db]" />
                  <p className="mt-2 text-xs font-semibold text-slate-900">Analyzing…</p>
                </div>
              </div>
            )}

            {/* Transcript overlay — bottom of video */}
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
                        ? 'Ask me anything about what you see\u2026'
                        : 'Microphone paused'}
            </p>
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="flex w-[188px] shrink-0 flex-col gap-3 rounded-2xl border border-[#20a7db]/[0.12] bg-[#eff9fd] p-3 shadow-sm">
          {/* ── Robot Controls ── */}
          <RobotControls />

          {/* ── Itinerary Planner ── */}
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
