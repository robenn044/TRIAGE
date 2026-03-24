import { useState, useEffect, useRef, CSSProperties } from 'react'
import './RobotFace.css'

const EXPRESSIONS = [
  { name: 'idle', weight: 55 },
  { name: 'happy', weight: 14 },
  { name: 'curious', weight: 10 },
  { name: 'confused', weight: 10 },
  { name: 'scared', weight: 6 },
  { name: 'sleepy', weight: 5 },
]

function pickExpression(current: string) {
  const pool = EXPRESSIONS.filter(e => e.name !== current)
  const total = pool.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const e of pool) {
    r -= e.weight
    if (r <= 0) return e.name
  }
  return 'idle'
}

interface RobotFaceProps {
  onUnlock?: () => void
  mini?: boolean
  visible?: boolean
}

export default function RobotFace({ onUnlock, mini = false, visible = true }: RobotFaceProps) {
  const [expression, setExpression] = useState('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    if (visible && unlocking) {
      setUnlocking(false)
      setExpression('idle')
    }
  }, [visible])

  useEffect(() => {
    if (mini || unlocking) return
    const isIdle = expression === 'idle'
    const delay = isIdle
      ? 4000 + Math.random() * 4000
      : 2000 + Math.random() * 2000

    timerRef.current = setTimeout(() => {
      setExpression(pickExpression(expression))
    }, delay)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [expression, mini, unlocking])

  const handleClick = () => {
    if (!onUnlock || mini || unlocking) return
    setUnlocking(true)
    setExpression('happy')
    setTimeout(() => onUnlock(), 500)
  }

  return (
    <div
      className={`robot-face-wrapper ${mini ? 'mini' : ''} ${unlocking ? 'unlocking' : ''}`}
      onClick={handleClick}
      role={onUnlock && !mini ? 'button' : undefined}
      tabIndex={onUnlock && !mini ? 0 : undefined}
      aria-label={mini ? 'Triage robot' : 'Tap to begin your tour'}
    >
      {!mini && (
        <div className="particles" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="particle" style={{ '--i': i } as CSSProperties} />
          ))}
        </div>
      )}

      {!mini && (
        <div className="wheat-hat" aria-hidden="true">
          <div className="hat-crown">
            <div className="hat-band" />
            <div className="hat-crease" />
          </div>
          <div className="hat-brim" />
          <div className="hat-wheat-sprig">
            <div className="sprig-stem" />
            <div className="sprig-head">
              <span className="sprig-grain" />
              <span className="sprig-grain" />
              <span className="sprig-grain" />
              <span className="sprig-grain" />
              <span className="sprig-grain" />
            </div>
          </div>
        </div>
      )}

      <section className={`robot-face ${expression}`} aria-label="Robot face">
        <div className="eye left-eye">
          <div className="eye-iris">
            <span className="eye-glint" />
            <span className="eye-glint-sm" />
          </div>
          <div className="eye-lid" />
        </div>

        <div className="mouth-wrap">
          <div className="mouth">
            <div className="mouth-inner" />
          </div>
        </div>

        <div className="eye right-eye">
          <div className="eye-iris">
            <span className="eye-glint" />
            <span className="eye-glint-sm" />
          </div>
          <div className="eye-lid" />
        </div>
      </section>

      {!mini && !unlocking && !!onUnlock && (
        <p className="tap-hint">Tap to begin</p>
      )}
    </div>
  )
}
