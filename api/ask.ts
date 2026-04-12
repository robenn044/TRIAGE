import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * /api/ask — AI Tourist Guide Endpoint
 *
 * Dual-provider Gemma 4 setup:
 *   PRIMARY:  Ollama on your PC (free, unlimited) — http://<PC_IP>:11434
 *   FALLBACK: Google AI Studio (free tier, 15 RPM) — generativelanguage.googleapis.com
 *
 * Both use Gemma 4. Ollama uses OpenAI-compatible API format.
 * Google AI Studio uses the Gemini REST API with Gemma 4 model.
 *
 * Set these env vars in Vercel:
 *   OLLAMA_BASE_URL    = http://<your-pc-ip>:11434  (e.g. http://192.168.1.50:11434)
 *   GEMINI_API_KEY     = your Google AI Studio API key (free at aistudio.google.com)
 *   OLLAMA_MODEL       = gemma4           (default, or gemma4:26b for bigger)
 *   GEMINI_MODEL       = gemma-4-26b-a4b-it  (default)
 */

// ── Types ──────────────────────────────────────────────────

interface AskRequest {
  image?: string   // base64 JPEG (no prefix)
  prompt: string
  max_tokens?: number
}

// ── Provider: Ollama (OpenAI-compatible) ───────────────────

async function tryOllama(
  prompt: string,
  imageB64: string | undefined,
  maxTokens: number,
  model: string,
  baseUrl: string,
): Promise<string | null> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content:
        'You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. ' +
        'When shown an image, describe what you see and provide rich, engaging tourist information. ' +
        'Be warm, conversational, and informative. Keep answers concise unless more detail adds value.',
    },
  ]

  // Ollama's OpenAI-compatible endpoint supports images via content array
  if (imageB64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
      ],
    })
  } else {
    messages.push({ role: 'user', content: prompt })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000) // 8s timeout

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      console.warn(`Ollama error: ${res.status}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.warn('Ollama unreachable:', (err as Error).message)
    return null
  }
}

// ── Provider: Google AI Studio (Gemini API with Gemma 4) ──

async function tryGoogleAI(
  prompt: string,
  imageB64: string | undefined,
  maxTokens: number,
  model: string,
  apiKey: string,
): Promise<string | null> {
  const systemInstruction = {
    parts: [{
      text:
        'You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. ' +
        'When shown an image, describe what you see and provide rich, engaging tourist information. ' +
        'Be warm, conversational, and informative. Keep answers concise unless more detail adds value.',
    }],
  }

  const parts: Array<Record<string, unknown>> = [{ text: prompt }]

  if (imageB64) {
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: imageB64,
      },
    })
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        },
      }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.warn(`Google AI error: ${res.status}`, errBody.slice(0, 200))
      return null
    }

    const data = await res.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null
  } catch (err) {
    console.error('Google AI error:', (err as Error).message)
    return null
  }
}

// ── Handler ────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { image, prompt, max_tokens } = (req.body || {}) as AskRequest

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' })
  }

  const maxTokens = typeof max_tokens === 'number' ? max_tokens : 300

  // Provider config from env
  const ollamaUrl = process.env.OLLAMA_BASE_URL   // e.g. http://192.168.1.50:11434
  const geminiKey = process.env.GEMINI_API_KEY
  const ollamaModel = process.env.OLLAMA_MODEL || 'gemma4'
  const geminiModel = process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it'

  let answer: string | null = null
  let provider = 'none'

  // 1. Try Ollama (PC) first — free and unlimited
  if (ollamaUrl) {
    answer = await tryOllama(prompt, image, maxTokens, ollamaModel, ollamaUrl)
    if (answer) provider = 'ollama'
  }

  // 2. Fallback to Google AI Studio
  if (!answer && geminiKey) {
    answer = await tryGoogleAI(prompt, image, maxTokens, geminiModel, geminiKey)
    if (answer) provider = 'google-ai-studio'
  }

  if (!answer) {
    return res.status(503).json({
      error: 'All AI providers unavailable',
      hint: 'Ensure Ollama is running on your PC or GEMINI_API_KEY is set in Vercel env vars.',
    })
  }

  return res.status(200).json({ answer, provider })
}
