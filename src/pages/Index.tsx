import { useState } from 'react'
import RobotFace from '@/components/RobotFace'
import CameraAskAI from '@/components/CameraAskAI'

const Index = () => {
  const [unlocked, setUnlocked] = useState(false)

  if (unlocked) {
    return <CameraAskAI />
  }

  return (
    <div className="flex min-h-screen bg-background">
      <RobotFace onUnlock={() => setUnlocked(true)} />
    </div>
  )
}

export default Index
