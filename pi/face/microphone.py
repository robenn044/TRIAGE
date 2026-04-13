"""
TRIAGE Robot — Face Pi Microphone Script

Captures audio from the USB microphone and:
  1. Serves a live audio stream on /stream (WAV chunks, for dashboard)
  2. Serves as a lightweight companion to camera.py

Usage:
    python microphone.py

Runs as a systemd service on the Face Pi.
"""

import logging
import signal
import sys
import time
import wave
import io
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread, Lock

import pyaudio

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [mic] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────
CHANNELS = 1
RATE = 16000          # 16kHz is standard for speech-to-text
CHUNK = 1024          # Number of frames per buffer
FORMAT = pyaudio.paInt16
LAN_SERVE_PORT = 8086 # Local HTTP port (camera is 8085)

# ── Shared State ────────────────────────────────────────────
audio_lock = Lock()
p = pyaudio.PyAudio()

# ── Local HTTP Server ──────────────────────────────────────
class AudioHandler(BaseHTTPRequestHandler):
    """
    GET /stream  → Live audio stream (WAV-like chunked response)
    GET /health  → Health check
    """

    def do_GET(self):
        if self.path == "/stream":
            self._handle_audio_stream()
        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_audio_stream(self):
        """Continuous audio stream — browser can play via <audio> or Web Audio API."""
        self.send_response(200)
        # We use audio/wav but since it's a stream, we don't send a full header with fixed length
        self.send_header("Content-Type", "audio/x-wav")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        # Send a "fake" WAV header with a massive length so browser starts playing
        # Most browsers handle this for live streams
        header = self._create_wav_header(0x7FFFFFFF)
        self.wfile.write(f"{len(header):X}\r\n".encode())
        self.wfile.write(header + b"\r\n")

        stream = p.open(format=FORMAT,
                        channels=CHANNELS,
                        rate=RATE,
                        input=True,
                        frames_per_buffer=CHUNK)

        try:
            logger.info("Client started listening to audio stream")
            while True:
                data = stream.read(CHUNK, exception_on_overflow=False)
                # Write chunk in HTTP chunked format: [length in hex]\r\n[data]\r\n
                self.wfile.write(f"{len(data):X}\r\n".encode())
                self.wfile.write(data + b"\r\n")
                self.wfile.flush()

        except (BrokenPipeError, ConnectionResetError):
            logger.info("Client disconnected from audio stream")
        finally:
            stream.stop_stream()
            stream.close()

    def _create_wav_header(self, data_size):
        """Create a WAV header for the stream."""
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(CHANNELS)
            wav.setsampwidth(p.get_sample_size(FORMAT))
            wav.setframerate(RATE)
            # We use a placeholder data size
            wav.setnframes(data_size // (CHANNELS * p.get_sample_size(FORMAT)))
        return buffer.getvalue()

    def log_message(self, format, *args):
        pass  # Suppress noisy request logs


def start_lan_server():
    """Start the threaded HTTP server."""
    server = HTTPServer(("0.0.0.0", LAN_SERVE_PORT), AudioHandler)
    logger.info("Audio LAN server on port %d  →  /stream (PCM 16kHz)", LAN_SERVE_PORT)
    server.serve_forever()


# ── Entry Point ────────────────────────────────────────────
def main():
    def shutdown(signum, frame):
        logger.info("Shutting down microphone...")
        p.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Start the server in the main thread
    start_lan_server()


if __name__ == "__main__":
    main()
