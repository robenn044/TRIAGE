import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

/**
 * Displays the live camera feed from the Face Pi via Vercel /api/camera-feed.
 * Polls at ~2fps for the latest JPEG frame.
 */
export default function CameraFeed() {
  const [imgSrc, setImgSrc] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['camera-feed'],
    queryFn: async () => {
      const res = await fetch('/api/camera-feed')
      if (!res.ok || res.status === 204) return null
      return res.json() as Promise<{ image: string; timestamp: number; age_ms: number }>
    },
    refetchInterval: 500,   // Poll at 2fps
    staleTime: 400,
  })

  useEffect(() => {
    if (data?.image) {
      setImgSrc(`data:image/jpeg;base64,${data.image}`)
    }
  }, [data])

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black/40">
      {imgSrc ? (
        <img
          src={imgSrc}
          alt="Robot camera feed"
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/50">
          Waiting for camera feed…
        </div>
      )}

      {/* Age indicator */}
      {data?.age_ms != null && data.age_ms > 5000 && (
        <div className="absolute bottom-2 right-2 rounded bg-red-500/80 px-2 py-0.5 text-[10px] text-white">
          Feed stale ({Math.round(data.age_ms / 1000)}s ago)
        </div>
      )}
    </div>
  )
}
