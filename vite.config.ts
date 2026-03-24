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

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_SYSTEM =
  "You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. " +
  "When shown an image, describe what you see and answer the tourist's question concisely. " +
  "Keep answers under 3 sentences unless more detail is clearly needed. " +
  "Be warm, informative, and focus on what would interest a tourist.";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Internal server error'
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load ALL env vars (not just VITE_ prefixed) so we can read GROQ_API_KEY
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

      // Dev-only API middleware — handles /api/ask so Groq calls work locally
      {
        name: 'groq-api-middleware',
        configureServer(server) {
          server.middlewares.use('/api/ask', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            const apiKey = env.GROQ_API_KEY;
            if (!apiKey || apiKey === 'your_groq_api_key_here') {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'GROQ_API_KEY not set in .env.local' }));
              return;
            }

            try {
              const raw = await readBody(req);
              const { image, prompt, max_tokens } = JSON.parse(raw);

              const userContent = image
                ? [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
                  ]
                : prompt;

              const groqRes = await fetch(GROQ_URL, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: GROQ_MODEL,
                  messages: [
                    { role: 'system', content: GROQ_SYSTEM },
                    { role: 'user', content: userContent },
                  ],
                  max_tokens: typeof max_tokens === 'number' ? max_tokens : 300,
                  temperature: 0.7,
                }),
              });

              if (!groqRes.ok) {
                const errText = await groqRes.text();
                console.error('Groq API error:', groqRes.status, errText);
                res.statusCode = groqRes.status;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Groq API error: ${groqRes.status}` }));
                return;
              }

              const data = await groqRes.json();
              const answer = data.choices?.[0]?.message?.content || 'Sorry, I could not generate an answer.';

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ answer }));
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
