#!/usr/bin/env python3
"""
TRIAGE — Local Dashboard Server (Brain Pi)

Serves the pre-built Vite dashboard from dist/ on port 3000.
This replaces Vercel for the Brain Pi's local screen, giving:
  - Zero-latency page loads (no internet round trip)
  - Access to the localhost camera stream
  - Local /api/ask for Gemma 4 or Ollama without leaving the Pi
  - Remaining /api/* routes can still proxy to Vercel when needed

Usage:
    python serve_dashboard.py

The Brain Pi kiosk Chromium loads http://localhost:3000/dashboard
"""

import http.server
import base64
import os
import socketserver
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import json
import re

PORT = 3000
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "dist")
VERCEL_BASE = "https://triage-ashy.vercel.app"
REPO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
ENV_FILE = os.path.join(REPO_DIR, ".env.local")

GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_GEMINI_MODEL = "gemma-4-26b-a4b-it"
DEFAULT_OLLAMA_MODEL = "gemma4"
DEFAULT_WHISPER_BIN = os.path.expanduser("~/whisper.cpp/build/bin/whisper-cli")
DEFAULT_WHISPER_MODEL = os.path.expanduser("~/whisper.cpp/models/ggml-base.en.bin")
DEFAULT_WHISPER_THREADS = "4"
SYSTEM_INSTRUCTION = (
    "You are Triage, a friendly and knowledgeable AI tour guide assistant in Albania. "
    "When shown an image, describe what you see and answer the tourist's question directly. "
    "Keep answers under 3 sentences unless more detail is clearly needed. "
    "Do not show your reasoning, bullet points, or internal analysis unless the user asks for them. "
    "Be warm, informative, and focus on what would interest a tourist."
)


def load_env_file(path: str):
    """Load key=value lines from .env.local without overriding real environment vars."""
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def json_response(handler: http.server.BaseHTTPRequestHandler, status: int, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def try_ollama(prompt: str, image: str | None, max_tokens: int):
    base_url = os.environ.get("OLLAMA_BASE_URL")
    if not base_url:
        return None

    messages: list[dict] = [{"role": "system", "content": SYSTEM_INSTRUCTION}]
    if image:
        messages.append({
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image}"}},
            ],
        })
    else:
        messages.append({"role": "user", "content": prompt})

    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps({
            "model": os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.7,
        }).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            answer = data.get("choices", [{}])[0].get("message", {}).get("content")
            return {"answer": answer, "provider": "ollama"} if answer else None
    except Exception as e:
        print(f"Ollama unavailable: {e}")
        return None


def try_google_ai(prompt: str, image: str | None, max_tokens: int):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None

    model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
    parts: list[dict] = [{"text": prompt}]
    if image:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": image,
            },
        })

    req = urllib.request.Request(
        f"{GOOGLE_AI_URL}/{model}:generateContent?key={api_key}",
        data=json.dumps({
            "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
            "contents": [{"parts": parts}],
            "generationConfig": {
                "maxOutputTokens": max_tokens,
                "temperature": 0.7,
            },
        }).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            answer = (
                data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text")
            )
            return {"answer": answer, "provider": "google-ai-studio"} if answer else None
    except urllib.error.HTTPError as e:
        print(f"Google AI error: {e.code} {e.read().decode('utf-8', errors='ignore')[:200]}")
        return None
    except Exception as e:
        print(f"Google AI unavailable: {e}")
        return None


def extract_transcript(cli_output: str):
    """Extract transcript text from whisper-cli stdout."""
    transcript_lines = []
    for line in cli_output.splitlines():
        match = re.match(r"^\[[0-9:. ]+-->[0-9:. ]+\]\s*(.*)$", line.strip())
        if not match:
            continue
        text = match.group(1).strip()
        if text:
            transcript_lines.append(text)

    if transcript_lines:
        return " ".join(transcript_lines).strip()

    fallback_lines = []
    for line in cli_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("whisper_") or stripped.startswith("system_info:") or stripped.startswith("main:"):
            continue
        fallback_lines.append(stripped)
    return " ".join(fallback_lines[-3:]).strip()


def collect_text_fields(value):
    """Recursively collect non-empty 'text' values from whisper.cpp JSON output."""
    texts = []

    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "text" and isinstance(nested, str):
                cleaned = nested.strip()
                if cleaned:
                    texts.append(cleaned)
            else:
                texts.extend(collect_text_fields(nested))
    elif isinstance(value, list):
        for item in value:
            texts.extend(collect_text_fields(item))

    return texts


def run_local_stt(audio_b64: str):
    whisper_bin = os.environ.get("WHISPER_CPP_BIN", DEFAULT_WHISPER_BIN)
    whisper_model = os.environ.get("WHISPER_MODEL", DEFAULT_WHISPER_MODEL)
    whisper_threads = os.environ.get("WHISPER_THREADS", DEFAULT_WHISPER_THREADS)

    if not os.path.exists(whisper_bin):
        raise FileNotFoundError(
            f"whisper-cli not found at {whisper_bin}. Install whisper.cpp or set WHISPER_CPP_BIN."
        )
    if not os.path.exists(whisper_model):
        raise FileNotFoundError(
            f"Whisper model not found at {whisper_model}. Download a model or set WHISPER_MODEL."
        )

    audio_bytes = base64.b64decode(audio_b64)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_audio:
        temp_audio.write(audio_bytes)
        wav_path = temp_audio.name
    output_prefix = wav_path[:-4]

    try:
        cmd = [
            whisper_bin,
            "-m", whisper_model,
            "-f", wav_path,
            "-l", "en",
            "-t", str(whisper_threads),
            "-oj",
            "-of", output_prefix,
        ]
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"whisper-cli failed with code {completed.returncode}: "
                f"{completed.stderr.strip() or completed.stdout.strip()}"
            )

        json_path = f"{output_prefix}.json"
        transcript = ""

        if os.path.exists(json_path):
            with open(json_path, "r", encoding="utf-8") as f:
                json_payload = json.load(f)
            text_parts = collect_text_fields(json_payload)
            transcript = " ".join(text_parts).strip()

        if not transcript:
            transcript = extract_transcript(completed.stdout)
        if not transcript:
            raise RuntimeError("whisper-cli returned no transcript text")
        return transcript
    finally:
        try:
            os.unlink(wav_path)
        except FileNotFoundError:
            pass
        try:
            os.unlink(f"{output_prefix}.json")
        except FileNotFoundError:
            pass


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    """
    Serves static files from dist/, handles /api/ask locally, and proxies the
    remaining /api/* routes to Vercel when needed.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def do_GET(self):
        # Proxy non-local API calls to Vercel
        if self.path.startswith("/api/"):
            self._proxy_to_vercel("GET")
            return

        # SPA fallback: serve index.html for any non-file route
        file_path = os.path.join(DIST_DIR, self.path.lstrip("/"))
        if not os.path.exists(file_path) or os.path.isdir(file_path):
            # Check if it's a file with extension (CSS, JS, etc.)
            if "." not in os.path.basename(self.path):
                self.path = "/index.html"

        super().do_GET()

    def do_POST(self):
        if self.path == "/api/ask":
            self._handle_local_ask()
            return
        if self.path == "/api/stt":
            self._handle_local_stt()
            return
        if self.path.startswith("/api/"):
            self._proxy_to_vercel("POST")
            return
        self.send_error(405)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _handle_local_ask(self):
        """Handle /api/ask locally so kiosk mode does not depend on Vercel."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            json_response(self, 400, {"error": "Invalid JSON body"})
            return

        prompt = payload.get("prompt")
        image = payload.get("image")
        max_tokens = payload.get("max_tokens", 300)

        if not isinstance(prompt, str) or not prompt.strip():
            json_response(self, 400, {"error": "prompt is required"})
            return

        if not isinstance(max_tokens, int):
            max_tokens = 300

        result = try_ollama(prompt, image, max_tokens)
        if not result:
            result = try_google_ai(prompt, image, max_tokens)

        if not result:
            json_response(
                self,
                503,
                {
                    "error": "AI unavailable",
                    "hint": "Check OLLAMA_BASE_URL or GEMINI_API_KEY in .env.local",
                },
            )
            return

        json_response(self, 200, result)

    def _handle_local_stt(self):
        """Handle /api/stt locally using whisper.cpp on the Brain Pi."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            json_response(self, 400, {"error": "Invalid JSON body"})
            return

        audio = payload.get("audio")
        if not isinstance(audio, str) or not audio.strip():
            json_response(self, 400, {"error": "audio is required"})
            return

        try:
            transcript = run_local_stt(audio)
        except FileNotFoundError as e:
            json_response(self, 503, {"error": str(e)})
            return
        except Exception as e:
            json_response(self, 500, {"error": str(e)})
            return

        json_response(self, 200, {"text": transcript, "provider": "whisper.cpp"})

    def _proxy_to_vercel(self, method: str):
        """Forward /api/* requests to Vercel."""
        target_url = VERCEL_BASE + self.path

        try:
            # Read request body for POST
            body = None
            if method == "POST":
                content_length = int(self.headers.get("Content-Length", 0))
                if content_length > 0:
                    body = self.rfile.read(content_length)

            req = urllib.request.Request(
                target_url,
                data=body,
                method=method,
                headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
            )

            with urllib.request.urlopen(req, timeout=15) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp_body)

        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(e.read())

        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        # Only log errors, not every request
        if args and str(args[1]).startswith("4") or str(args[1]).startswith("5"):
            super().log_message(format, *args)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    load_env_file(ENV_FILE)

    if not os.path.isdir(DIST_DIR):
        print(f"ERROR: dist/ not found at {DIST_DIR}")
        print("Run 'npm run build' first, then copy dist/ to the Pi.")
        sys.exit(1)

    # Inject MJPEG stream and Mic stream URLs into the built index.html
    index_path = os.path.join(DIST_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()

        inject = (
            '<script>'
            'window.__TRIAGE_CAMERA_URL="http://localhost:8085/stream";'
            '</script>'
        )
        html = re.sub(r"<script>window\.__TRIAGE_CAMERA_URL=.*?</script>", "", html)
        html = re.sub(r"<script>window\.__TRIAGE_MIC_URL=.*?</script>", "", html)
        if "__TRIAGE_CAMERA_URL" not in html:
            html = html.replace("</head>", f"{inject}</head>", 1)
            with open(index_path, "w", encoding="utf-8") as f:
                f.write(html)
            print("Injected camera URL into index.html")

    with ReusableTCPServer(("0.0.0.0", PORT), DashboardHandler) as httpd:
        print(f"Dashboard serving on http://localhost:{PORT}")
        print(f"Camera stream: http://localhost:8085/stream")
        print("Local AI:      POST http://localhost:3000/api/ask")
        print("Local STT:     POST http://localhost:3000/api/stt")
        print("Other /api/* requests still proxy to Vercel")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
