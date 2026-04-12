import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * /api/phone-link — Phone ↔ Robot pairing endpoint
 *
 * Acts as the "AirTag beacon" relay:
 *   - Phone sends heartbeats every 3s (POST)
 *   - Brain Pi + Dashboard poll status (GET)
 *
 * Pairing flow:
 *   1. Dashboard generates session token, displays QR code
 *   2. Tourist scans QR → opens /link?token=XYZ
 *   3. Phone page sends periodic heartbeats here
 *   4. Brain Pi polls this endpoint to know if user is still connected
 */

// In-memory session state (fine for single-robot use)
let session: {
  token: string | null
  phoneConnected: boolean
  lastHeartbeat: number
  signal: string | null  // "heartbeat" | "here" | "help"
  phoneInfo: Record<string, unknown> | null
} = {
  token: null,
  phoneConnected: false,
  lastHeartbeat: 0,
  signal: null,
  phoneInfo: null,
}

const HEARTBEAT_TIMEOUT_MS = 10_000 // Phone is "lost" after 10s without heartbeat

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method === 'POST') {
    const { token, signal, phoneInfo } = req.body || {}

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' })
    }

    // Accept any token — first phone to connect wins the session
    if (session.token === null) {
      session.token = token
    }

    // Only accept heartbeats for the active session
    if (token !== session.token) {
      return res.status(403).json({ error: 'Session mismatch — another phone is paired' })
    }

    session.phoneConnected = true
    session.lastHeartbeat = Date.now()
    session.signal = signal || 'heartbeat'

    if (phoneInfo) {
      session.phoneInfo = phoneInfo
    }

    return res.status(200).json({
      ok: true,
      paired: true,
      message: 'Heartbeat received',
    })
  }

  if (req.method === 'GET') {
    const { action } = req.query

    // Reset session (called by End Trip)
    if (action === 'reset') {
      session = {
        token: null,
        phoneConnected: false,
        lastHeartbeat: 0,
        signal: null,
        phoneInfo: null,
      }
      return res.status(200).json({ ok: true, message: 'Session reset' })
    }

    // Check if phone heartbeat is stale
    const now = Date.now()
    const timeSinceHeartbeat = now - session.lastHeartbeat
    const isAlive = session.phoneConnected && timeSinceHeartbeat < HEARTBEAT_TIMEOUT_MS

    return res.status(200).json({
      paired: isAlive,
      token: session.token,
      lastHeartbeat: session.lastHeartbeat,
      msSinceHeartbeat: timeSinceHeartbeat,
      signal: session.signal,
      phoneInfo: session.phoneInfo,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
