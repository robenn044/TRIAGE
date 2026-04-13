#!/usr/bin/env python3
"""Continuously capture mic audio on the Brain Pi, transcribe locally, and relay text."""

from __future__ import annotations

import base64
import io
import json
import logging
import math
import os
import signal
import subprocess
import sys
import time
import urllib.request
import wave

import numpy as np

from serve_dashboard import run_local_stt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [mic] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2
CHUNK_MS = 250
CHUNK_BYTES = int(RATE * (CHUNK_MS / 1000.0) * SAMPLE_WIDTH)
CALIBRATION_SECONDS = 2.0
SILENCE_SECONDS = 1.2
MIN_SPEECH_SECONDS = 0.9
MAX_SEGMENT_SECONDS = 10.0
MIN_WORDS = 2
MIN_CHARS = 8
MIN_RMS = 0.01
MAX_NOISE_FLOOR = 0.08
MIN_TRIGGER_RMS = 0.03
MAX_TRIGGER_RMS = 0.12
ENERGY_MULTIPLIER = 1.8
LEVEL_LOG_INTERVAL = 3.0
POST_URL = os.environ.get("TRIAGE_TRANSCRIPT_POST_URL", "http://127.0.0.1:3000/api/transcript")
SOURCE = os.environ.get("TRIAGE_TRANSCRIPT_SOURCE", "pi-mic")


def candidate_devices():
    env_device = os.environ.get("TRIAGE_MIC_DEVICE", "").strip()
    if env_device:
        yield env_device
    yield "plughw:CARD=Camera,DEV=0"
    yield "default:CARD=Camera"
    yield "sysdefault:CARD=Camera"
    yield "default"


def probe_device(device: str) -> bool:
    try:
        completed = subprocess.run(
            [
                "arecord",
                "-q",
                "-D",
                device,
                "-f",
                "S16_LE",
                "-r",
                str(RATE),
                "-c",
                str(CHANNELS),
                "-d",
                "1",
                "-t",
                "raw",
                os.devnull,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
            check=False,
        )
        return completed.returncode == 0
    except Exception:
        return False


def discover_device() -> str:
    for device in candidate_devices():
        if probe_device(device):
            logger.info("Using microphone device: %s", device)
            return device
    raise RuntimeError("Could not open any microphone capture device with arecord")


def rms_from_pcm(chunk: bytes) -> float:
    if not chunk:
        return 0.0
    samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
    return math.sqrt(float(np.mean(np.square(samples), dtype=np.float64)))


def pcm_to_wav_b64(pcm_bytes: bytes) -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH)
        wav_file.setframerate(RATE)
        wav_file.writeframes(pcm_bytes)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def post_transcript(text: str):
    payload = json.dumps({"text": text, "source": SOURCE}).encode("utf-8")
    req = urllib.request.Request(
        POST_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def transcribe_segment(chunks: list[bytes]) -> str:
    pcm_bytes = b"".join(chunks)
    if len(pcm_bytes) < int(RATE * SAMPLE_WIDTH * MIN_SPEECH_SECONDS):
        return ""
    transcript = run_local_stt(pcm_to_wav_b64(pcm_bytes)).strip()
    if not transcript:
        return ""
    if len(transcript) < MIN_CHARS or len(transcript.split()) < MIN_WORDS:
        return ""
    return transcript


def compute_noise_floor(samples: list[float]) -> float:
    if not samples:
        return MIN_RMS
    arr = np.array(samples, dtype=np.float32)
    baseline = float(np.percentile(arr, 20))
    if baseline > MAX_NOISE_FLOOR:
        logger.warning(
            "Measured noise floor %.4f is unusually high; clamping to %.4f",
            baseline,
            MAX_NOISE_FLOOR,
        )
        baseline = MAX_NOISE_FLOOR
    return max(MIN_RMS, baseline)


def start_capture(device: str):
    return subprocess.Popen(
        [
            "arecord",
            "-q",
            "-D",
            device,
            "-f",
            "S16_LE",
            "-r",
            str(RATE),
            "-c",
            str(CHANNELS),
            "-t",
            "raw",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def main():
    running = True

    def shutdown(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    device = discover_device()
    process = start_capture(device)
    assert process.stdout is not None

    noise_samples: list[float] = []
    noise_floor = MIN_RMS
    segment_chunks: list[bytes] = []
    speech_started_at: float | None = None
    last_voice_at: float | None = None
    last_level_log_at = 0.0
    calibration_deadline = time.monotonic() + CALIBRATION_SECONDS
    logger.info("Calibrating microphone for %.1f seconds...", CALIBRATION_SECONDS)

    try:
        while running:
            chunk = process.stdout.read(CHUNK_BYTES)
            if not chunk:
                time.sleep(0.05)
                continue

            level = rms_from_pcm(chunk)
            now = time.monotonic()

            if now < calibration_deadline:
                noise_samples.append(level)
                continue

            if noise_samples:
                noise_floor = compute_noise_floor(noise_samples)
                noise_samples.clear()
                logger.info("Mic calibrated. Noise floor %.4f", noise_floor)

            threshold = min(MAX_TRIGGER_RMS, max(MIN_TRIGGER_RMS, noise_floor * ENERGY_MULTIPLIER))
            has_voice = level >= threshold

            if now - last_level_log_at >= LEVEL_LOG_INTERVAL:
                logger.info(
                    "Mic level %.4f threshold %.4f voice=%s",
                    level,
                    threshold,
                    "yes" if has_voice else "no",
                )
                last_level_log_at = now

            if not has_voice and speech_started_at is None:
                noise_floor = min(
                    MAX_NOISE_FLOOR,
                    max(MIN_RMS, noise_floor * 0.995 + min(level, MAX_NOISE_FLOOR) * 0.005),
                )
                continue

            if speech_started_at is None and has_voice:
                speech_started_at = now
                last_voice_at = now
                segment_chunks = [chunk]
                logger.info("Voice detected")
                continue

            segment_chunks.append(chunk)
            if has_voice:
                last_voice_at = now

            segment_seconds = len(b"".join(segment_chunks)) / (RATE * SAMPLE_WIDTH)
            should_flush = False
            if last_voice_at is not None and now - last_voice_at >= SILENCE_SECONDS:
                should_flush = True
            if segment_seconds >= MAX_SEGMENT_SECONDS:
                should_flush = True

            if not should_flush:
                continue

            started_at = speech_started_at
            speech_started_at = None
            last_voice_at = None
            chunks = segment_chunks
            segment_chunks = []

            if started_at is None:
                continue

            try:
                transcript = transcribe_segment(chunks)
                if not transcript:
                    logger.info("Ignored empty transcript")
                    continue
                logger.info("Heard: %s", transcript)
                payload = post_transcript(transcript)
                logger.info("Relayed transcript id=%s", payload.get("id"))
            except Exception as exc:
                logger.error("Mic transcription failed: %s", exc)
                time.sleep(0.5)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    sys.exit(main())
