import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './RobotFace.css'

const EXPRESSIONS = [
  { name: 'idle', weight: 55 },
  { name: 'happy', weight: 14 },
  { name: 'curious', weight: 10 },
  { name: 'confused', weight: 10 },
  { name: 'scared', weight: 6 },
  { name: 'sleepy', weight: 5 },
] as const

type Expression = (typeof EXPRESSIONS)[number]['name']

function pickExpression(current: Expression): Expression {
  const pool = EXPRESSIONS.filter((entry) => entry.name !== current)
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
  let random = Math.random() * total

  for (const entry of pool) {
    random -= entry.weight
    if (random <= 0) return entry.name
  }

  return 'idle'
}

interface RobotFaceProps {
  onUnlock?: () => void
  mini?: boolean
  visible?: boolean
}

export default function RobotFace({ onUnlock, mini = false, visible = true }: RobotFaceProps) {
  const [expression, setExpression] = useState<Expression>('idle')
  const [unlocking, setUnlocking] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (visible) {
      setUnlocking(false)
      setExpression('idle')
    }
  }, [visible])

  useEffect(() => {
    if (mini || unlocking) return

    const isIdle = expression === 'idle'
    const delay = isIdle ? 4000 + Math.random() * 4000 : 2000 + Math.random() * 2000

    timerRef.current = setTimeout(() => {
      setExpression((current) => pickExpression(current))
    }, delay)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [expression, mini, unlocking])

  const handleUnlock = () => {
    if (!onUnlock || mini || unlocking) return
    setUnlocking(true)
    setExpression('happy')
    setTimeout(() => onUnlock(), 280)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleUnlock()
    }
  }

  return (
    <div
      className={`robot-face-wrapper ${mini ? 'mini' : ''}`}
      onClick={handleUnlock}
      onKeyDown={handleKeyDown}
      role={onUnlock && !mini ? 'button' : undefined}
      tabIndex={onUnlock && !mini ? 0 : undefined}
      aria-label={mini ? 'Triage robot' : 'Tap to begin your tour'}
    >
      {!mini && (
        <div className="particles" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} className="particle" style={{ '--i': index } as CSSProperties} />
          ))}
        </div>
      )}

      <section className={`robot-face ${expression}`} aria-label="Robot face">
        <div className="eye left-eye">
          <span className="eye-core" />
          <div className="eye-lid" />
        </div>

        <div className="mouth-wrap">
          <div className="mouth">
            <div className="mouth-inner" />
          </div>
        </div>

        <div className="eye right-eye">
          <span className="eye-core" />
          <div className="eye-lid" />
        </div>
      </section>

      {!mini && !unlocking && !!onUnlock && <p className="tap-hint">Tap to begin</p>}
    </div>
  )
}
