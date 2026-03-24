import { useEffect, useRef, useState, useCallback } from "react";
import "./RobotFace.css";

interface RobotFaceProps {
  onUnlock?: () => void;
  mini?: boolean;
}

type Expression = "happy" | "surprised" | "sad" | "sleepy" | "excited" | "smirk" | "neutral";

const EXPRESSIONS: Expression[] = [
  "happy", "happy", "happy",
  "excited", "excited",
  "surprised",
  "smirk",
  "neutral",
  "sleepy",
  "sad",
];

export default function RobotFace({ onUnlock, mini }: RobotFaceProps) {
  const [expression, setExpression] = useState<Expression>("happy");
  const [blinking, setBlinking] = useState(false);
  const [squishing, setSquishing] = useState(false);

  const blinkRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exprRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pickNext = (current: Expression): Expression => {
    const pool = EXPRESSIONS.filter((e) => e !== current);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const scheduleBlink = useCallback(() => {
    blinkRef.current = setTimeout(() => {
      setBlinking(true);
      setTimeout(() => {
        setBlinking(false);
        if (Math.random() < 0.25) {
          setTimeout(() => {
            setBlinking(true);
            setTimeout(() => {
              setBlinking(false);
              scheduleBlink();
            }, 230);
          }, 400);
        } else {
          scheduleBlink();
        }
      }, 230);
    }, 2200 + Math.random() * 3800);
  }, []);

  const scheduleExpression = useCallback((current: Expression) => {
    exprRef.current = setTimeout(() => {
      const next = pickNext(current);
      setExpression(next);
      scheduleExpression(next);
    }, 4500 + Math.random() * 5000);
  }, []);

  useEffect(() => {
    scheduleBlink();
    scheduleExpression("happy");
    return () => {
      if (blinkRef.current) clearTimeout(blinkRef.current);
      if (exprRef.current)  clearTimeout(exprRef.current);
    };
  }, []);

  const handleClick = () => {
    if (onUnlock) {
      onUnlock();
      return;
    }
    setSquishing(true);
    setTimeout(() => setSquishing(false), 400);
    const next = pickNext(expression);
    setExpression(next);
    if (exprRef.current) clearTimeout(exprRef.current);
    scheduleExpression(next);
  };

  /* ── Mini mode: tiny glowing dots for page headers ── */
  if (mini) {
    return (
      <div className="robot-face-mini" onClick={handleClick}>
        <span className="mini-dot" />
        <span className="mini-dot mini-mouth" />
        <span className="mini-dot" />
      </div>
    );
  }

  return (
    <div className="robot-face-wrapper">
      <div
        className={`robot-face expr-${expression}`}
        style={squishing ? { animation: "squish 0.38s cubic-bezier(0.34,1.56,0.64,1) forwards" } : undefined}
        onClick={handleClick}
      >
        <div className="robot-features">
          <div className={`led robot-eye${blinking ? " blinking" : ""}`} />
          <div className="led robot-mouth" />
          <div className={`led robot-eye${blinking ? " blinking" : ""}`} />
        </div>
      </div>
    </div>
  );
}