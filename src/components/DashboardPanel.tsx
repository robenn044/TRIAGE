import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Map, MapPin, Mic, MicOff, Sparkles, Video, VideoOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RobotFace from './RobotFace'
import EndTripButton from './EndTripButton'

type AssistantState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error'

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

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') {
    return null
  }

  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error'
}

function describeMediaError(error: unknown, kind: 'camera' | 'microphone') {
  const err = error as { name?: string; message?: string } | null
  const name = err?.name ?? ''
  const message = err?.message ?? 'Unknown error'

  if (kind === 'camera') {
    if (!navigator.mediaDevices?.getUserMedia) {
      return {
        summary: 'Camera access is not available',
        detail:
          window.location.protocol !== 'https:' && window.location.hostname !== 'localhost'
            ? 'Chrome requires HTTPS before it can request camera access.'
            : 'This browser does not expose the camera API.',
      }
    }

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return {
        summary: 'Camera permission denied',
        detail: 'Allow camera access in Chrome and try again.',
      }
    }

    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return {
        summary: 'No camera found',
        detail: 'Chrome could not find a video input device on this system.',
      }
    }

    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        summary: 'Camera is busy',
        detail: 'Another app is already using the camera. Close it and retry.',
      }
    }

    return {
      summary: 'Camera unavailable',
      detail: message,
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      summary: 'Microphone access is not available',
      detail:
        window.location.protocol !== 'https:' && window.location.hostname !== 'localhost'
          ? 'Chrome requires HTTPS before it can request microphone access.'
          : 'This browser does not expose the microphone API.',
    }
  }

  if (!getSpeechRecognitionCtor()) {
    return {
      summary: 'Free English STT is unavailable',
      detail: 'Chrome speech recognition is required for the built-in free English STT.',
    }
  }

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      summary: 'Microphone permission denied',
      detail: 'Allow microphone access in Chrome to enable English speech recognition.',
    }
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      summary: 'No microphone found',
      detail: 'Chrome could not find a microphone on this system.',
    }
  }

  return {
    summary: 'Microphone unavailable',
    detail: message,
  }
}

function snapFrame(video: HTMLVideoElement, quality = 0.85): string {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas context unavailable')
  }

  context.translate(canvas.width, 0)
  context.scale(-1, 1)
  context.drawImage(video, 0, 0)

  return canvas.toDataURL('image/jpeg', quality).split(',')[1]
}

function choosePreferredVoice() {
  const voices = speechSynthesis.getVoices()
  const englishVoices = voices.filter(voice => voice.lang.toLowerCase().startsWith('en'))

  if (englishVoices.length === 0) {
    return null
  }

  const scoreVoice = (voice: SpeechSynthesisVoice) => {
    let score = 0
    const name = voice.name.toLowerCase()

    if (/google uk english female/.test(name)) score += 12
    if (/google us english/.test(name)) score += 10
    if (/google/.test(name)) score += 6
    if (/microsoft/.test(name)) score += 5
    if (/(natural|neural|premium|enhanced|aria|jenny|libby|sonia|sara)/.test(name)) score += 4
    if (!voice.localService) score += 1

    return score
  }

  return [...englishVoices].sort((left, right) => scoreVoice(right) - scoreVoice(left))[0] ?? null
}

async function waitForVideoFrame(video: HTMLVideoElement, timeoutMs = 8_000) {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }

    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup()
        resolve()
      }
    }

    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Camera opened but no frames arrived in time.'))
    }, timeoutMs)

    video.addEventListener('loadeddata', onReady)
    video.addEventListener('canplay', onReady)
  })
}

export default function DashboardPanel() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const isSpeakingRef = useRef(false)
  const stateRef = useRef<AssistantState>('idle')

  const [entered, setEntered] = useState(false)
  const [state, setState] = useState<AssistantState>('idle')
  const [cameraReady, setCameraReady] = useState(false)
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraErrorDetail, setCameraErrorDetail] = useState<string | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [micErrorDetail, setMicErrorDetail] = useState<string | null>(null)
  const [micPermissionGranted, setMicPermissionGranted] = useState(false)
  const [micEnabled, setMicEnabled] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [lastAnswer, setLastAnswer] = useState('')

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const clearCameraStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const requestCameraAccess = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API unavailable')
    }

    clearCameraStream()
    setCameraError(null)
    setCameraErrorDetail(null)
    setCameraReady(false)

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
      audio: false,
    })

    const video = videoRef.current
    if (!video) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('Video element unavailable')
    }

    video.srcObject = stream
    await video.play()
    await waitForVideoFrame(video)

    streamRef.current = stream
    setCameraReady(true)
  }, [clearCameraStream])

  const requestMicrophoneAccess = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unavailable')
    }

    if (!getSpeechRecognitionCtor()) {
      throw new Error('Chrome speech recognition unavailable')
    }

    setMicError(null)
    setMicErrorDetail(null)

    const tempStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })

    tempStream.getTracks().forEach(track => track.stop())
    setMicPermissionGranted(true)
  }, [])

  const enableInputs = useCallback(async () => {
    setRequestingAccess(true)
    setState('idle')

    let cameraGranted = false
    let microphoneGranted = false

    try {
      await requestCameraAccess()
      cameraGranted = true
    } catch (error) {
      const mediaError = describeMediaError(error, 'camera')
      setCameraError(mediaError.summary)
      setCameraErrorDetail(mediaError.detail)
    }

    try {
      await requestMicrophoneAccess()
      microphoneGranted = true
    } catch (error) {
      const mediaError = describeMediaError(error, 'microphone')
      setMicError(mediaError.summary)
      setMicErrorDetail(mediaError.detail)
      setMicPermissionGranted(false)
    }

    setMicEnabled(microphoneGranted)

    if (cameraGranted && microphoneGranted) {
      setState('listening')
    } else if (!cameraGranted || !microphoneGranted) {
      setState('error')
    }

    setRequestingAccess(false)
  }, [requestCameraAccess, requestMicrophoneAccess])

  const speak = useCallback((text: string) => {
    speechSynthesis.cancel()

    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 0.96
    utterance.pitch = 1
    utterance.voice = choosePreferredVoice()

    utterance.onstart = () => {
      isSpeakingRef.current = true
      setState('speaking')
    }

    utterance.onend = () => {
      isSpeakingRef.current = false
      if (micEnabled && micPermissionGranted) {
        setState('listening')
      } else if (cameraReady) {
        setState('idle')
      }
    }

    utterance.onerror = () => {
      isSpeakingRef.current = false
      setState(micEnabled && micPermissionGranted ? 'listening' : 'idle')
    }

    speechSynthesis.speak(utterance)
  }, [cameraReady, micEnabled, micPermissionGranted])

  const askGroq = useCallback(async (prompt: string) => {
    setState('processing')
    setTranscript('')

    try {
      let image: string | null = null

      if (videoRef.current && videoRef.current.readyState >= 2) {
        image = snapFrame(videoRef.current)
      }

      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, prompt }),
      })

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(errorBody || `API error ${response.status}`)
      }

      const data = await response.json()
      const answer = data.answer || 'Sorry, I could not generate an answer.'

      setLastAnswer(answer)
      speak(answer)
    } catch (error) {
      setLastAnswer(`Error: ${getErrorMessage(error)}`)
      setState('error')
    }
  }, [speak])

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setEntered(true))
    )

    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    if (!micEnabled || !micPermissionGranted) {
      try {
        recognitionRef.current?.stop()
      } catch {
        // ignore
      }

      if (!isSpeakingRef.current && stateRef.current !== 'processing') {
        setState(cameraReady ? 'idle' : stateRef.current === 'error' ? 'error' : 'idle')
      }

      return
    }

    const SpeechRecognition = getSpeechRecognitionCtor()
    if (!SpeechRecognition) {
      setMicError('Free English STT is unavailable')
      setMicErrorDetail('Use Chrome or Microsoft Edge to enable browser speech recognition.')
      setState('error')
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
    let interimText = ''
    let processingLock = false

    const clearSilenceTimer = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
    }

    const flush = () => {
      if (processingLock || isSpeakingRef.current) {
        return
      }

      let text = accumulated.trim()
      if (!text && interimText.trim()) {
        text = interimText.trim()
      }

      accumulated = ''
      interimText = ''

      if (!text) {
        setTranscript('')
        return
      }

      const wordCount = text.split(/\s+/).length
      if (wordCount < 2 || text.length < 8) {
        setTranscript('')
        return
      }

      processingLock = true
      askGroq(text).finally(() => {
        processingLock = false
      })
    }

    const resetSilenceTimer = (delayMs: number) => {
      clearSilenceTimer()
      silenceTimer = setTimeout(flush, delayMs)
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (isSpeakingRef.current || processingLock) {
        return
      }

      let newFinal = ''
      let newInterim = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) {
          if (result[0].confidence > 0.2) {
            newFinal += result[0].transcript
          }
        } else {
          newInterim += result[0].transcript
        }
      }

      if (newFinal) {
        accumulated += `${accumulated ? ' ' : ''}${newFinal.trim()}`
        interimText = ''
        setTranscript(accumulated)
        resetSilenceTimer(1200)
      }

      if (newInterim) {
        interimText = newInterim.trim()
        setTranscript(accumulated ? `${accumulated} ${interimText}` : interimText)
        resetSilenceTimer(1800)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return
      }

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setMicEnabled(false)
        setMicPermissionGranted(false)
        setMicError('Microphone permission denied')
        setMicErrorDetail('Allow microphone access in Chrome to use the free English STT.')
      } else {
        setMicError('Speech recognition error')
        setMicErrorDetail(`Chrome STT returned: ${event.error}`)
      }

      setState('error')
    }

    recognition.onend = () => {
      if (accumulated.trim() && !processingLock && !isSpeakingRef.current) {
        clearSilenceTimer()
        flush()
        return
      }

      accumulated = ''
      interimText = ''

      if (!micEnabled || !micPermissionGranted || isSpeakingRef.current || stateRef.current === 'processing') {
        return
      }

      try {
        recognition.start()
        setState('listening')
      } catch {
        // ignore restart errors
      }
    }

    try {
      recognition.start()
      setState('listening')
    } catch (error) {
      setMicError('Could not start speech recognition')
      setMicErrorDetail(getErrorMessage(error))
      setState('error')
    }

    return () => {
      clearSilenceTimer()
      recognition.onend = null
      try {
        recognition.stop()
      } catch {
        // ignore
      }
    }
  }, [askGroq, cameraReady, micEnabled, micPermissionGranted])

  useEffect(() => {
    const handleVoicesChanged = () => {
      speechSynthesis.getVoices()
    }

    speechSynthesis.getVoices()
    speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged)

    return () => {
      speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged)
    }
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

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop()
      } catch {
        // ignore
      }

      speechSynthesis.cancel()
      clearCameraStream()
    }
  }, [clearCameraStream])

  const handleMicrophoneButton = useCallback(async () => {
    if (requestingAccess) {
      return
    }

    if (!micPermissionGranted) {
      setRequestingAccess(true)

      try {
        await requestMicrophoneAccess()
        setMicEnabled(true)
        setState(cameraReady ? 'listening' : 'idle')
      } catch (error) {
        const mediaError = describeMediaError(error, 'microphone')
        setMicError(mediaError.summary)
        setMicErrorDetail(mediaError.detail)
        setState('error')
      } finally {
        setRequestingAccess(false)
      }

      return
    }

    if (micEnabled) {
      speechSynthesis.cancel()
      isSpeakingRef.current = false

      try {
        recognitionRef.current?.stop()
      } catch {
        // ignore
      }

      setTranscript('')
      setMicEnabled(false)
      setState(cameraReady ? 'idle' : 'error')
      return
    }

    setMicError(null)
    setMicErrorDetail(null)
    setMicEnabled(true)
  }, [cameraReady, micEnabled, micPermissionGranted, requestMicrophoneAccess, requestingAccess])

  const handleRetryCamera = useCallback(async () => {
    setRequestingAccess(true)

    try {
      await requestCameraAccess()
      setState(micEnabled && micPermissionGranted ? 'listening' : 'idle')
    } catch (error) {
      const mediaError = describeMediaError(error, 'camera')
      setCameraError(mediaError.summary)
      setCameraErrorDetail(mediaError.detail)
      setState('error')
    } finally {
      setRequestingAccess(false)
    }
  }, [micEnabled, micPermissionGranted, requestCameraAccess])

  const statusText = (() => {
    if (requestingAccess) return 'Requesting access...'
    if (state === 'listening') return 'Listening...'
    if (state === 'processing') return 'Thinking...'
    if (state === 'speaking') return 'Speaking...'
    if (cameraReady && micPermissionGranted && !micEnabled) return 'Microphone paused'
    if (cameraReady && !micPermissionGranted) return 'Camera live'
    if (state === 'error') return 'Needs attention'
    return 'Enable inputs'
  })()

  const footerText = (() => {
    if (state === 'speaking' && lastAnswer) return lastAnswer
    if (state === 'processing') return 'Sending your English transcript and current camera view to Groq...'
    if (transcript && state === 'listening') return transcript
    if (cameraError) return cameraError
    if (micError) return micError
    if (!cameraReady && !micPermissionGranted) return 'Allow Chrome camera and microphone access to start the live assistant.'
    if (cameraReady && !micPermissionGranted) return 'Camera is live. Enable the microphone to turn on free English STT.'
    if (cameraReady && micPermissionGranted && !micEnabled) return 'Microphone paused. Tap the mic button to resume English STT.'
    return 'Ask me anything about what you see...'
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
            <p className="text-[10px] leading-tight text-white/70">Chrome camera + free English STT</p>
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
                onClick={handleMicrophoneButton}
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
            <div className="pointer-events-none absolute left-2 top-2 z-10 h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-white/40" />
            <div className="pointer-events-none absolute right-2 top-2 z-10 h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-white/40" />
            <div className="pointer-events-none absolute bottom-2 left-2 z-10 h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-white/40" />
            <div className="pointer-events-none absolute bottom-2 right-2 z-10 h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-white/40" />

            <div className="absolute left-2 top-2 z-20 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur-sm">
              {cameraReady ? 'Live' : requestingAccess ? 'Requesting access...' : 'Permission needed'}
            </div>

            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
                cameraReady ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ transform: 'scaleX(-1)' }}
            />

            {!cameraReady && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(32,167,219,0.22),transparent_34%),linear-gradient(135deg,rgba(11,23,36,0.94),rgba(5,10,18,1))] p-4">
                <div className="w-full max-w-[520px] rounded-3xl border border-white/10 bg-white/[0.08] p-6 text-white shadow-[0_18px_48px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-[#7fd4ef]">
                      {requestingAccess ? <Loader2 className="h-5 w-5 animate-spin" /> : <Video className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7fd4ef]">
                        Chrome access
                      </p>
                      <h3 className="mt-2 text-xl font-semibold tracking-tight">
                        Turn on the live camera and microphone.
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-white/75">
                        This asks Chrome directly for camera permission, microphone permission, free English speech-to-text, and a human English speaking voice for Groq replies.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7fd4ef]">Camera</p>
                      <p className="mt-2 text-xs leading-5 text-white/70">Live Chrome `getUserMedia` feed with mirrored preview.</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7fd4ef]">STT</p>
                      <p className="mt-2 text-xs leading-5 text-white/70">Free English browser speech recognition using Chrome Web Speech.</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7fd4ef]">TTS</p>
                      <p className="mt-2 text-xs leading-5 text-white/70">Human-sounding English voice preference for Groq responses.</p>
                    </div>
                  </div>

                  {cameraError && (
                    <div className="mt-5 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3">
                      <p className="text-sm font-semibold text-white">{cameraError}</p>
                      {cameraErrorDetail && <p className="mt-1 text-xs leading-5 text-white/70">{cameraErrorDetail}</p>}
                    </div>
                  )}

                  {micError && (
                    <div className="mt-3 rounded-2xl border border-amber-300/25 bg-amber-500/10 px-4 py-3">
                      <p className="text-sm font-semibold text-white">{micError}</p>
                      {micErrorDetail && <p className="mt-1 text-xs leading-5 text-white/70">{micErrorDetail}</p>}
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      onClick={enableInputs}
                      disabled={requestingAccess}
                      className="h-10 bg-[#20a7db] px-5 text-xs shadow-sm shadow-[#20a7db]/25 hover:bg-[#1b96c5] disabled:opacity-60"
                    >
                      {requestingAccess ? 'Requesting access...' : 'Enable camera and mic'}
                    </Button>
                    <Button
                      onClick={() => navigate('/itinerary')}
                      variant="outline"
                      className="h-10 border-white/15 bg-white/5 px-5 text-xs text-white hover:bg-white/10"
                    >
                      Open itinerary planner
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {cameraReady && (
              <>
                <div className="absolute right-2 top-2 z-20 flex items-center gap-2">
                  <div className={`rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-sm ${
                    micEnabled ? 'bg-[#20a7db]/85 text-white' : 'bg-black/55 text-white/80'
                  }`}>
                    {micEnabled ? 'English STT live' : 'English STT paused'}
                  </div>
                  <div className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white/80 shadow-sm backdrop-blur-sm">
                    Human English TTS
                  </div>
                </div>

                {!micEnabled && (
                  <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-slate-950/90 to-transparent px-4 pb-4 pt-12">
                    <div className="mx-auto max-w-[420px] rounded-2xl border border-white/10 bg-black/45 px-4 py-3 text-center backdrop-blur-sm">
                      <p className="text-sm font-semibold text-white">
                        Microphone is paused.
                      </p>
                      <p className="mt-1 text-xs leading-5 text-white/70">
                        Tap the mic button to enable free English speech recognition in Chrome.
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}

            {state === 'processing' && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 backdrop-blur-sm">
                <div className="rounded-2xl bg-white/90 px-6 py-4 text-center shadow-lg backdrop-blur">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#20a7db]" />
                  <p className="mt-2 text-xs font-semibold text-slate-900">Analyzing with Groq...</p>
                </div>
              </div>
            )}

            {transcript && state !== 'idle' && (
              <div className="absolute bottom-3 left-3 right-3 z-20">
                <div className="rounded-xl bg-black/60 px-3 py-2 backdrop-blur-sm">
                  <p className="text-xs leading-4 text-white/90">
                    {state === 'listening' && 'Listening: '}
                    {state === 'processing' && 'Sending: '}
                    {transcript}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="mt-2 shrink-0 rounded-xl bg-slate-900/85 px-4 py-2 backdrop-blur-sm">
            <p className="text-center text-xs leading-5 text-white/90">
              {footerText}
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
                  Assistant stack
                </p>
                <p className="text-xs font-semibold text-slate-800">Chrome media + Groq replies</p>
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

          <div className="mt-3 space-y-2">
            <div className="rounded-xl border border-[#20a7db]/10 bg-white px-2.5 py-2">
              <div className="flex items-center gap-2">
                {cameraReady ? <Video className="h-3.5 w-3.5 text-[#20a7db]" /> : <VideoOff className="h-3.5 w-3.5 text-slate-400" />}
                <p className="text-[10px] font-semibold text-slate-800">
                  {cameraReady ? 'Camera live' : 'Camera offline'}
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-[#20a7db]/10 bg-white px-2.5 py-2">
              <div className="flex items-center gap-2">
                {micPermissionGranted ? <Mic className="h-3.5 w-3.5 text-[#20a7db]" /> : <MicOff className="h-3.5 w-3.5 text-slate-400" />}
                <p className="text-[10px] font-semibold text-slate-800">
                  {micPermissionGranted ? 'English STT ready' : 'Mic permission needed'}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-auto grid gap-1.5 pt-3">
            <Button
              onClick={handleRetryCamera}
              variant="outline"
              className="h-9 border-[#20a7db]/[0.18] bg-white text-xs"
            >
              Retry camera
            </Button>
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
