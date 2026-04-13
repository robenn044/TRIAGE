import type { VercelRequest, VercelResponse } from '@vercel/node'

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

type GroqContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface GroqMessage {
  role: 'system' | 'user'
  content: string | GroqContentPart[]
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Internal server error'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' })
  }

  const { image, prompt, max_tokens } = req.body || {}

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' })
  }

  try {
    const messages: GroqMessage[] = [
      {
        role: 'system',
        content:
          'You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. ' +
          'When shown an image, describe what you see and answer the tourist\'s question concisely. ' +
          'Keep answers under 3 sentences unless more detail is clearly needed. ' +
          'Be warm, informative, and focus on what would interest a tourist.',
      },
      {
        role: 'user',
        content: image
          ? [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${image}` },
              },
            ]
          : prompt,
      },
    ]

    const groqRes = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: typeof max_tokens === 'number' ? max_tokens : 300,
        temperature: 0.7,
      }),
    })

    if (!groqRes.ok) {
      const errBody = await groqRes.text()
      console.error('Groq API error:', groqRes.status, errBody)
      return res.status(groqRes.status).json({ error: `Groq API error: ${groqRes.status}` })
    }

    const data = (await groqRes.json()) as GroqResponse
    const answer = data.choices?.[0]?.message?.content || 'Sorry, I could not generate an answer.'

    return res.status(200).json({ answer })
  } catch (error: unknown) {
    console.error('Server error:', error)
    return res.status(500).json({ error: getErrorMessage(error) })
  }
}
