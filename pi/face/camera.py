"""
TRIAGE Robot — Face Pi Camera Script

Captures frames from the USB webcam and:
  1. POSTs base64 JPEG to Vercel /api/camera-feed (for dashboard display)
  2. Serves the latest frame on a local HTTP endpoint (for Brain Pi low-latency vision)

Usage:
    python camera.py

Runs as a systemd service on the Face Pi.
"""

import asyncio
import base64
import io
import logging
import signal
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread, Lock

import cv2
import httpx
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [camera] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────
CAMERA_INDEX = 0
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
CAPTURE_FPS = 10                    # Capture rate
VERCEL_UPLOAD_FPS = 4               # Upload to Vercel (increased from 2)
LAN_SERVE_PORT = 8085               # Local HTTP port for Brain Pi
VERCEL_CAMERA_FEED_URL = "https://triage-ashy.vercel.app/api/camera-feed"
JPEG_QUALITY = 70
VERCEL_JPEG_QUALITY = 40            # Lower quality for Vercel (smaller payload = faster)
VERCEL_RESIZE = (320, 240)          # Downscale for Vercel upload (saves ~75% bandwidth)

# ── Shared State ────────────────────────────────────────────
latest_frame_lock = Lock()
latest_frame_jpeg: bytes = b""


# ── Local HTTP Server (for Brain Pi) ───────────────────────
class FrameHandler(BaseHTTPRequestHandler):
    """Serves the latest JPEG frame on GET /frame"""

    def do_GET(self):
        if self.path == "/frame":
            with latest_frame_lock:
                frame = latest_frame_jpeg

            if not frame:
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"No frame available")
                return

            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(frame)

        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress noisy request logs


def start_lan_server():
    """Start the local HTTP server in a background thread."""
    server = HTTPServer(("0.0.0.0", LAN_SERVE_PORT), FrameHandler)
    logger.info("LAN frame server started on port %d", LAN_SERVE_PORT)
    server.serve_forever()


# ── Vercel Upload ──────────────────────────────────────────
async def upload_to_vercel(client: httpx.AsyncClient, frame: np.ndarray):
    """Resize, compress and POST frame to Vercel /api/camera-feed."""
    try:
        # Downscale for faster upload
        small = cv2.resize(frame, VERCEL_RESIZE, interpolation=cv2.INTER_AREA)
        _, jpeg_buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, VERCEL_JPEG_QUALITY])
        jpeg_b64 = base64.b64encode(jpeg_buf.tobytes()).decode("ascii")

        resp = await client.post(
            VERCEL_CAMERA_FEED_URL,
            json={"image": jpeg_b64},
            timeout=5.0,
        )
        if resp.status_code != 200:
            logger.warning("Vercel upload failed: %d %s", resp.status_code, resp.text[:200])
    except httpx.HTTPError as e:
        logger.warning("Vercel upload error: %s", e)


# ── Main Capture Loop ─────────────────────────────────────
async def capture_loop():
    global latest_frame_jpeg

    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)

    if not cap.isOpened():
        logger.error("Failed to open camera at index %d", CAMERA_INDEX)
        sys.exit(1)

    logger.info("Camera opened: %dx%d @ %dfps", FRAME_WIDTH, FRAME_HEIGHT, CAPTURE_FPS)

    async with httpx.AsyncClient() as client:
        frame_interval = 1.0 / CAPTURE_FPS
        upload_interval = 1.0 / VERCEL_UPLOAD_FPS
        last_upload = 0.0

        while True:
            loop_start = time.monotonic()

            ret, frame = cap.read()
            if not ret:
                logger.warning("Frame capture failed, retrying...")
                await asyncio.sleep(0.1)
                continue

            # Encode to JPEG
            encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
            success, jpeg_buf = cv2.imencode(".jpg", frame, encode_params)
            if not success:
                continue

            jpeg_bytes = jpeg_buf.tobytes()

            # Update shared frame for LAN server
            with latest_frame_lock:
                latest_frame_jpeg = jpeg_bytes

            # Upload to Vercel at lower rate (resized separately)
            now = time.monotonic()
            if now - last_upload >= upload_interval:
                last_upload = now
                asyncio.create_task(upload_to_vercel(client, frame))

            # Maintain capture rate
            elapsed = time.monotonic() - loop_start
            sleep_time = max(0, frame_interval - elapsed)
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

    cap.release()


# ── Entry Point ────────────────────────────────────────────
def main():
    # Start LAN server in background thread
    lan_thread = Thread(target=start_lan_server, daemon=True, name="lan-server")
    lan_thread.start()

    # Handle graceful shutdown
    loop = asyncio.new_event_loop()

    def shutdown(signum, frame):
        logger.info("Shutting down...")
        loop.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Run capture loop
    loop.run_until_complete(capture_loop())


if __name__ == "__main__":
    main()
