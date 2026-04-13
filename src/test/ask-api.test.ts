import { afterEach, describe, expect, it, vi } from "vitest"
import handler from "../../api/ask"

function createResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }

  return response
}

describe("/api/ask", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.OLLAMA_BASE_URL
    delete process.env.OLLAMA_MODEL
    delete process.env.GEMINI_API_KEY
    delete process.env.GEMINI_MODEL
  })

  it("prefers Ollama when available", async () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434"

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from Ollama" } }],
      }),
    })

    vi.stubGlobal("fetch", fetchMock)

    const req = {
      method: "POST",
      body: { prompt: "What do you see?" },
    } as any
    const res = createResponse() as any

    await handler(req, res)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      answer: "Hello from Ollama",
      provider: "ollama",
    })
  })

  it("falls back to Google AI Studio when Ollama is unavailable", async () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434"
    process.env.GEMINI_API_KEY = "test-key"

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Hello from Gemma 4" }] } }],
        }),
      })

    vi.stubGlobal("fetch", fetchMock)

    const req = {
      method: "POST",
      body: { prompt: "Describe this place", image: "abc123" },
    } as any
    const res = createResponse() as any

    await handler(req, res)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      answer: "Hello from Gemma 4",
      provider: "google-ai-studio",
    })
  })
})
