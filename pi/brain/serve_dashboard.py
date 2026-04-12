#!/usr/bin/env python3
"""
TRIAGE — Local Dashboard Server (Brain Pi)

Serves the pre-built Vite dashboard from dist/ on port 3000.
This replaces Vercel for the Brain Pi's local screen, giving:
  - Zero-latency page loads (no internet round trip)
  - Access to Face Pi MJPEG stream without mixed-content blocking
  - API calls still go to Vercel (proxied transparently)

Usage:
    python serve_dashboard.py

The Brain Pi kiosk Chromium loads http://localhost:3000/dashboard
"""

import http.server
import os
import socketserver
import sys
import urllib.request
import urllib.error
import json

PORT = 3000
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "dist")
VERCEL_BASE = "https://triage-ashy.vercel.app"


class DashboardHandler(http.server.SimpleHTTPHandler):
    """
    Serves static files from dist/ and proxies /api/* requests to Vercel.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def do_GET(self):
        # Proxy API calls to Vercel
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


def main():
    if not os.path.isdir(DIST_DIR):
        print(f"ERROR: dist/ not found at {DIST_DIR}")
        print("Run 'npm run build' first, then copy dist/ to the Pi.")
        sys.exit(1)

    # Inject MJPEG stream URL into the built index.html if not already present
    index_path = os.path.join(DIST_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r") as f:
            html = f.read()
        # The env var is baked at build time, but we can't change it post-build.
        # Instead, the dashboard auto-detects: if window.__TRIAGE_CAMERA_URL is set, use it.
        if "__TRIAGE_CAMERA_URL" not in html:
            inject = '<script>window.__TRIAGE_CAMERA_URL="http://triageface.local:8085/stream";</script>'
            html = html.replace("</head>", f"{inject}</head>", 1)
            with open(index_path, "w") as f:
                f.write(html)
            print(f"Injected camera URL into index.html")

    with socketserver.TCPServer(("0.0.0.0", PORT), DashboardHandler) as httpd:
        print(f"Dashboard serving on http://localhost:{PORT}")
        print(f"Camera stream: http://triageface.local:8085/stream")
        print(f"API proxy → {VERCEL_BASE}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
