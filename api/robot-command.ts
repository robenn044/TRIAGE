import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * /api/robot-command
 *
 * POST (from Dashboard UI): Queue a command for the Brain Pi.
 *   Body: { "action": "start_trip" | "end_trip" | "follow_me" | "pause" | "resume" }
 *
 * GET (from Brain Pi): Poll and consume the latest pending command.
 *   Returns: { "action": "..." } or { "action": null } if no pending command.
 */

interface Command {
  action: string
  timestamp: number
}

let pendingCommand: Command | null = null

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // POST: Dashboard sends a command
  if (req.method === 'POST') {
    const { action } = req.body || {}

    const validActions = ['start_trip', 'end_trip', 'follow_me', 'pause', 'resume']
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Must be one of: ${validActions.join(', ')}`,
      })
    }

    pendingCommand = { action, timestamp: Date.now() }

    return res.status(200).json({ ok: true, action, timestamp: pendingCommand.timestamp })
  }

  // GET: Brain Pi polls for pending command
  if (req.method === 'GET') {
    if (!pendingCommand) {
      return res.status(200).json({ action: null })
    }

    // Consume the command (one-shot)
    const cmd = pendingCommand
    pendingCommand = null

    return res.status(200).json(cmd)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
