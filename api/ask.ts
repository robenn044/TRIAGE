import type { VercelRequest, VercelResponse } from '@vercel/node'

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemma-4-26b-a4b-it'

interface GeminiPart {
  text?: string
  inline_data?: {
    mime_type: string
    data: string
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[]
    }
  }>
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Internal server error'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
  }

  const { image, prompt, max_tokens } = req.body || {}

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' })
  }

  try {
    const systemPrompt =
      'You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. ' +
      'Answer the tourist\'s question concisely and helpfully. ' +
      'Keep answers under 3 sentences unless more detail is clearly needed. ' +
      'Be warm, informative, and focus on what would interest a tourist.'

    const userParts: GeminiPart[] = image
      ? [
          { inline_data: { mime_type: 'image/jpeg', data: image } },
          { text: prompt },
        ]
      : [{ text: prompt }]

    const geminiRes = await fetch(`${GEMINI_API_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: userParts,
          },
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        generationConfig: {
          maxOutputTokens: typeof max_tokens === 'number' ? max_tokens : 300,
          temperature: 0.7,
        },
      }),
    })

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text()
      console.error('Gemma API error:', geminiRes.status, errBody)
      return res.status(geminiRes.status).json({ error: `Gemma API error: ${geminiRes.status}` })
    }

    const data = (await geminiRes.json()) as GeminiResponse
    const answer =
      data.candidates?.[0]?.content?.parts
        ?.map(part => part.text ?? '')
        .join('')
        .trim() || 'Sorry, I could not generate an answer.'

    return res.status(200).json({ answer })
  } catch (error: unknown) {
    console.error('Server error:', error)
    return res.status(500).json({ error: getErrorMessage(error) })
  }
}
