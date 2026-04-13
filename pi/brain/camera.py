"""
TRIAGE Robot — Brain Pi Camera Script

Captures frames from the USB webcam and:
  1. Serves an MJPEG stream on /stream (30 FPS, for dashboard at localhost:3000)
  2. Serves single JPEG snapshots on /frame (for AI vision — Brain Pi fetches locally)
  3. Health check on /health

Runs on the Brain Pi alongside the dashboard.
Camera is accessed at http://localhost:8085/stream from the dashboard.

Usage:
    python camera.py

Runs as a systemd service on the Brain Pi.
"""

import asyncio
import logging
import signal
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread, Lock, Event

import cv2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [camera] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────
CAMERA_INDEX = 0
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
CAPTURE_FPS = 30
LAN_SERVE_PORT = 8085
STREAM_JPEG_QUALITY = 75
SNAPSHOT_JPEG_QUALITY = 85

# ── Shared State ────────────────────────────────────────────
latest_frame_lock = Lock()
latest_frame_jpeg: bytes = b""
frame_event = Event()

MJPEG_BOUNDARY = b"--triageframe"


# ── Local HTTP Server ──────────────────────────────────────
class FrameHandler(BaseHTTPRequestHandler):
    """
    GET /stream  → MJPEG stream (30 FPS, for dashboard <img> tag)
    GET /frame   → Single JPEG snapshot (for AI vision)
    GET /health  → Health check
    """

    def do_GET(self):
        if self.path == "/stream":
            self._handle_mjpeg_stream()
        elif self.path == "/frame":
            self._handle_snapshot()
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_mjpeg_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=triageframe")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            while True:
                frame_event.wait(timeout=2.0)
                frame_event.clear()

                with latest_frame_lock:
                    frame = latest_frame_jpeg

                if not frame:
                    continue

                self.wfile.write(MJPEG_BOUNDARY + b"\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(frame)}\r\n".encode())
                self.wfile.write(b"\r\n")
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_snapshot(self):
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

    def log_message(self, format, *args):
        pass


def start_lan_server():
    server = HTTPServer(("0.0.0.0", LAN_SERVE_PORT), FrameHandler)
    server.request_queue_size = 16
    logger.info("Camera server on port %d  →  /stream (MJPEG 30fps)  /frame (snapshot)", LAN_SERVE_PORT)
    server.serve_forever()


# ── Main Capture Loop ─────────────────────────────────────
async def capture_loop():
    global latest_frame_jpeg

    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS, CAPTURE_FPS)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))

    if not cap.isOpened():
        logger.error("Failed to open camera at index %d", CAMERA_INDEX)
        sys.exit(1)

    actual_fps = cap.get(cv2.CAP_PROP_FPS) or CAPTURE_FPS
    logger.info("Camera opened: %dx%d @ %.0ffps", FRAME_WIDTH, FRAME_HEIGHT, actual_fps)

    frame_interval = 1.0 / CAPTURE_FPS
    frame_count = 0

    while True:
        loop_start = time.monotonic()

        ret, frame = cap.read()
        if not ret:
            await asyncio.sleep(0.01)
            continue

        frame_count += 1
        _, jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, STREAM_JPEG_QUALITY])
        jpeg_bytes = jpeg_buf.tobytes()

        with latest_frame_lock:
            latest_frame_jpeg = jpeg_bytes
        frame_event.set()

        if frame_count % 300 == 0:
            logger.info("Captured %d frames", frame_count)

        elapsed = time.monotonic() - loop_start
        sleep_time = max(0, frame_interval - elapsed)
        if sleep_time > 0:
            await asyncio.sleep(sleep_time)

    cap.release()


# ── Entry Point ────────────────────────────────────────────
def main():
    lan_thread = Thread(target=start_lan_server, daemon=True, name="lan-server")
    lan_thread.start()

    loop = asyncio.new_event_loop()

    def shutdown(signum, _frame):
        logger.info("Shutting down...")
        loop.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    loop.run_until_complete(capture_loop())


if __name__ == "__main__":
    main()

