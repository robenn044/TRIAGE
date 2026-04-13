import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import type { IncomingMessage } from "http";

/** Read the full body of an incoming request. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const GOOGLE_AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemma-4-26b-a4b-it';
const OLLAMA_MODEL = 'gemma4';
const SYSTEM_INSTRUCTION =
  "You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. " +
  "When shown an image, describe what you see and answer the tourist's question concisely. " +
  "Keep answers under 3 sentences unless more detail is clearly needed. " +
  "Be warm, informative, and focus on what would interest a tourist.";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Internal server error'
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load ALL env vars (not just VITE_ prefixed)
  const env = loadEnv(mode, process.cwd(), '');

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    plugins: [
      react(),

      // Dev-only API middleware — handles /api/ask so AI calls work locally
      {
        name: 'triage-ai-middleware',
        configureServer(server) {
          server.middlewares.use('/api/ask', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const raw = await readBody(req);
              const { image, prompt, max_tokens } = JSON.parse(raw);
              const maxTokens = typeof max_tokens === 'number' ? max_tokens : 300;

              const geminiKey = env.GEMINI_API_KEY;
              const ollamaUrl = env.OLLAMA_BASE_URL; // e.g. http://localhost:11434

              let answer = null;
              let provider = 'none';

              // 1. Try Ollama first
              if (ollamaUrl) {
                try {
                  const messages = [
                    { role: 'system', content: SYSTEM_INSTRUCTION },
                    {
                      role: 'user',
                      content: image 
                        ? [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                          ]
                        : prompt
                    }
                  ];

                  const ollamaRes = await fetch(`${ollamaUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      model: env.OLLAMA_MODEL || OLLAMA_MODEL,
                      messages,
                      max_tokens: maxTokens,
                      temperature: 0.7,
                    }),
                  });

                  if (ollamaRes.ok) {
                    const data = await ollamaRes.json();
                    answer = data.choices?.[0]?.message?.content;
                    if (answer) provider = 'ollama';
                  }
                } catch (e) {
                  console.warn('Ollama unreachable in dev:', getErrorMessage(e));
                }
              }

              // 2. Fallback to Google AI Studio
              if (!answer && geminiKey) {
                try {
                  const model = env.GEMINI_MODEL || GEMINI_MODEL;
                  const url = `${GOOGLE_AI_URL}/${model}:generateContent?key=${geminiKey}`;
                  
                  const parts: any[] = [{ text: prompt }];
                  if (image) {
                    parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
                  }

                  const googleRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                      contents: [{ parts }],
                      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
                    }),
                  });

                  if (googleRes.ok) {
                    const data = await googleRes.json();
                    answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (answer) provider = 'google-ai-studio';
                  } else {
                    const err = await googleRes.text();
                    console.error('Google AI error:', googleRes.status, err);
                  }
                } catch (e) {
                  console.error('Google AI fetch error:', getErrorMessage(e));
                }
              }

              if (!answer) {
                res.statusCode = 503;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ 
                  error: 'AI unavailable', 
                  hint: 'Check GEMINI_API_KEY or OLLAMA_BASE_URL in .env.local' 
                }));
                return;
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ answer, provider }));
            } catch (error: unknown) {
              console.error('API middleware error:', error);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: getErrorMessage(error) }));
            }
          });
        },
      },
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
  };
});
