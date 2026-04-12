import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * /api/robot-state
 *
 * POST (from Brain Pi): Push the latest robot state.
 *   Body: { state, ir_l, ir_r, poi, speed_l, speed_r, tracking, narration }
 *
 * GET (from Dashboard UI): Poll the latest robot state.
 */

interface RobotState {
  state: string        // FSM state: IDLE, TOURING, AT_POI, FOLLOWING, END_TRIP
  mode: string         // LINE_FOLLOW or COMMAND
  ir_l: number         // Left IR sensor (0 or 1)
  ir_r: number         // Right IR sensor (0 or 1)
  poi: string | null   // Current Point of Interest name
  speed_l: number      // Left motor speed
  speed_r: number      // Right motor speed
  tracking: boolean    // Whether target following is active
  narration: string | null  // Latest AI narration text
  safety: string       // CLEAR, CAUTION, or DANGER
  phone_paired: boolean
  timestamp: number
}

let currentState: RobotState = {
  state: 'IDLE',
  mode: 'LINE_FOLLOW',
  ir_l: 0,
  ir_r: 0,
  poi: null,
  speed_l: 0,
  speed_r: 0,
  tracking: false,
  narration: null,
  safety: 'CLEAR',
  phone_paired: false,
  timestamp: Date.now(),
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // POST: Brain Pi pushes state
  if (req.method === 'POST') {
    const body = req.body || {}

    currentState = {
      state: body.state ?? currentState.state,
      mode: body.mode ?? currentState.mode,
      ir_l: body.ir_l ?? currentState.ir_l,
      ir_r: body.ir_r ?? currentState.ir_r,
      poi: body.poi ?? currentState.poi,
      speed_l: body.speed_l ?? currentState.speed_l,
      speed_r: body.speed_r ?? currentState.speed_r,
      tracking: body.tracking ?? currentState.tracking,
      narration: body.narration ?? currentState.narration,
      safety: body.safety ?? currentState.safety,
      phone_paired: body.phone_paired ?? currentState.phone_paired,
      timestamp: Date.now(),
    }

    return res.status(200).json({ ok: true, timestamp: currentState.timestamp })
  }

  // GET: Dashboard polls state
  if (req.method === 'GET') {
    return res.status(200).json(currentState)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
