import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * /api/camera-feed
 *
 * POST: Face Pi uploads a base64 JPEG frame → stored in memory.
 * GET:  Dashboard polls for the latest frame → returns base64 JPEG.
 *
 * Note: In-memory storage resets on cold starts. For production,
 * consider Vercel KV or Edge Config. This is fine for a single-robot setup.
 */

let latestFrame: string | null = null
let lastUpdated: number = 0

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers for dashboard access
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // POST: Receive frame from Face Pi
  if (req.method === 'POST') {
    const { image } = req.body || {}

    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64 string) is required' })
    }

    latestFrame = image
    lastUpdated = Date.now()

    return res.status(200).json({ ok: true, timestamp: lastUpdated })
  }

  // GET: Serve latest frame to dashboard
  if (req.method === 'GET') {
    if (!latestFrame) {
      return res.status(204).json({ error: 'no_frame', message: 'No camera frame available yet' })
    }

    return res.status(200).json({
      image: latestFrame,
      timestamp: lastUpdated,
      age_ms: Date.now() - lastUpdated,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
