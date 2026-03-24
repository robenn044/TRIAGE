import { useState } from 'react'
import { Camera, Send, Sparkles, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import RobotFace from './RobotFace'

export default function CameraAskAI() {
  const [question, setQuestion] = useState('')
  const [response, setResponse] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [captured, setCaptured] = useState(false)

  const handleCapture = () => {
    setCaptured(true)
    setResponse(null)
  }

  const handleAsk = () => {
    if (!question.trim()) return
    setLoading(true)
    setTimeout(() => {
      setResponse(
        `Great question! "${question}" — This is a simulated response from Triage AI. In production, this would use your camera feed and OpenAI to describe what you're looking at and answer your question in detail.`
      )
      setLoading(false)
    }, 1500)
  }

  const handleReset = () => {
    setCaptured(false)
    setQuestion('')
    setResponse(null)
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-4 border-b border-border bg-card">
        <div className="w-12 h-8 flex items-center">
          <RobotFace mini />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground tracking-tight">Triage</h1>
          <p className="text-xs text-muted-foreground">Your AI Tour Guide</p>
        </div>
        <div className="ml-auto">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        </div>
      </header>

      {/* Camera Viewfinder */}
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-6 gap-5">
        <div className="relative w-full max-w-md aspect-[4/3] rounded-2xl overflow-hidden border-2 border-border bg-card shadow-sm">
          <div className="absolute inset-0 flex items-center justify-center">
            {captured ? (
              <div className="text-center space-y-2">
                <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                  <Camera className="w-8 h-8 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground">Photo captured</p>
              </div>
            ) : (
              <div className="text-center space-y-3">
                <div className="w-20 h-20 mx-auto rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                  <Camera className="w-10 h-10 text-muted-foreground/40" />
                </div>
                <p className="text-sm text-muted-foreground">Point at something interesting</p>
              </div>
            )}
          </div>

          {/* Viewfinder corners */}
          <div className="absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 border-primary/60 rounded-tl-md" />
          <div className="absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 border-primary/60 rounded-tr-md" />
          <div className="absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 border-primary/60 rounded-bl-md" />
          <div className="absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 border-primary/60 rounded-br-md" />
        </div>

        {!captured ? (
          <Button
            onClick={handleCapture}
            size="lg"
            className="rounded-full w-16 h-16 p-0 shadow-lg shadow-primary/20"
          >
            <Camera className="w-7 h-7" />
          </Button>
        ) : (
          <Button onClick={handleReset} variant="outline" size="sm" className="gap-2">
            <RotateCcw className="w-4 h-4" />
            Retake
          </Button>
        )}

        {captured && (
          <div className="w-full max-w-md space-y-4 animate-fade-in">
            <div className="flex gap-2">
              <Input
                placeholder="Ask about what you see..."
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAsk()}
              />
              <Button
                onClick={handleAsk}
                disabled={!question.trim() || loading}
                className="px-4"
              >
                {loading ? <Sparkles className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>

            {response && (
              <div className="rounded-xl bg-accent border border-border p-4 animate-fade-in">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-6 flex-shrink-0 mt-0.5">
                    <RobotFace mini />
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{response}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
