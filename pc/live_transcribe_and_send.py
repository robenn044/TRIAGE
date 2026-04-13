#!/usr/bin/env python3
"""Continuously listen on the PC, transcribe locally, and relay text to the Brain Pi."""

from __future__ import annotations

import argparse
import math
import os
import queue
import sys
import tempfile
import time
import wave
from typing import Iterable

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

from send_transcript import post_transcript


def rms(samples: np.ndarray) -> float:
    return math.sqrt(float(np.mean(np.square(samples), dtype=np.float64)))


def write_wav(path: str, samples: np.ndarray, sample_rate: int) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(path, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


def merge_chunks(chunks: Iterable[np.ndarray]) -> np.ndarray:
    arrays = [chunk.reshape(-1) for chunk in chunks]
    if not arrays:
        return np.array([], dtype=np.float32)
    return np.concatenate(arrays).astype(np.float32, copy=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Always-listening PC relay for Triage."
    )
    parser.add_argument(
        "--pi",
        default="http://triagedashboard:3000",
        help="Brain Pi base URL, for example http://192.168.1.50:3000",
    )
    parser.add_argument(
        "--model",
        default="base.en",
        help="faster-whisper model name, for example base.en or small.en",
    )
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="faster-whisper compute type, such as int8, int8_float16, or float32",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="faster-whisper device, usually auto, cpu, or cuda",
    )
    parser.add_argument(
        "--input-device",
        type=int,
        default=None,
        help="sounddevice input device index; omit to use the default microphone",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="Print audio devices and exit.",
    )
    parser.add_argument(
        "--sample-rate",
        type=int,
        default=16000,
        help="Microphone sample rate.",
    )
    parser.add_argument(
        "--block-ms",
        type=int,
        default=250,
        help="Microphone block size in milliseconds.",
    )
    parser.add_argument(
        "--calibration-seconds",
        type=float,
        default=2.0,
        help="Seconds of startup room-noise calibration.",
    )
    parser.add_argument(
        "--silence-ms",
        type=int,
        default=1200,
        help="Silence gap before finalizing a spoken segment.",
    )
    parser.add_argument(
        "--min-speech-ms",
        type=int,
        default=900,
        help="Minimum segment duration before transcription.",
    )
    parser.add_argument(
        "--max-segment-seconds",
        type=float,
        default=12.0,
        help="Force a transcript flush if someone keeps speaking for too long.",
    )
    parser.add_argument(
        "--energy-floor",
        type=float,
        default=0.015,
        help="Absolute minimum RMS gate threshold.",
    )
    parser.add_argument(
        "--energy-multiplier",
        type=float,
        default=3.0,
        help="Voice gate multiplier applied to the measured noise floor.",
    )
    parser.add_argument(
        "--source",
        default="pc-live",
        help="Source label stored in Pi relay logs.",
    )
    parser.add_argument(
        "--min-words",
        type=int,
        default=2,
        help="Minimum word count before sending a transcript.",
    )
    parser.add_argument(
        "--min-chars",
        type=int,
        default=8,
        help="Minimum character count before sending a transcript.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.list_devices:
        print(sd.query_devices())
        return 0

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
    )

    block_frames = max(1, int(args.sample_rate * (args.block_ms / 1000.0)))
    silence_seconds = args.silence_ms / 1000.0
    min_speech_seconds = args.min_speech_ms / 1000.0
    audio_queue: queue.Queue[np.ndarray | None] = queue.Queue()

    def audio_callback(indata, frames, callback_time, status):
        if status:
            print(f"[audio] {status}", file=sys.stderr)
        audio_queue.put(indata.copy())

    print("Starting PC listener")
    print(f"Pi relay:      {args.pi}/api/transcript")
    print(f"Whisper model: {args.model}")
    print(f"Input device:  {args.input_device if args.input_device is not None else 'default'}")
    print("Stay quiet for calibration...")

    noise_samples: list[float] = []
    noise_floor = args.energy_floor
    speech_chunks: list[np.ndarray] = []
    speech_started_at: float | None = None
    last_voice_at: float | None = None

    with sd.InputStream(
        samplerate=args.sample_rate,
        blocksize=block_frames,
        channels=1,
        dtype="float32",
        device=args.input_device,
        callback=audio_callback,
    ):
        calibration_deadline = time.monotonic() + args.calibration_seconds

        while True:
            chunk = audio_queue.get()
            if chunk is None:
                continue

            mono = chunk[:, 0].astype(np.float32, copy=False)
            level = rms(mono)
            now = time.monotonic()

            if now < calibration_deadline:
                noise_samples.append(level)
                continue

            if noise_samples:
                baseline = float(np.median(np.array(noise_samples, dtype=np.float32)))
                noise_floor = max(args.energy_floor, baseline)
                noise_samples.clear()
                print(f"Calibrated noise floor: {noise_floor:.4f}")
                print("Listening...")

            threshold = max(args.energy_floor, noise_floor * args.energy_multiplier)
            has_voice = level >= threshold

            if not has_voice and speech_started_at is None:
                noise_floor = max(args.energy_floor, noise_floor * 0.98 + level * 0.02)
                continue

            if speech_started_at is None and has_voice:
                speech_started_at = now
                last_voice_at = now
                speech_chunks = [mono]
                print("Voice detected")
                continue

            speech_chunks.append(mono)
            if has_voice:
                last_voice_at = now

            segment_seconds = len(merge_chunks(speech_chunks)) / args.sample_rate
            should_flush = False

            if last_voice_at is not None and now - last_voice_at >= silence_seconds:
                should_flush = True
            if segment_seconds >= args.max_segment_seconds:
                should_flush = True

            if not should_flush:
                continue

            samples = merge_chunks(speech_chunks)
            speech_chunks = []
            started_at = speech_started_at
            speech_started_at = None
            last_voice_at = None

            if started_at is None:
                continue

            duration = len(samples) / args.sample_rate
            if duration < min_speech_seconds:
                print("Skipped short segment")
                continue

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name

            try:
                write_wav(wav_path, samples, args.sample_rate)
                print("Transcribing...")
                segments, info = model.transcribe(
                    wav_path,
                    language="en",
                    vad_filter=True,
                    beam_size=5,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()

                if not text:
                    print("No transcript text")
                    continue

                words = len(text.split())
                if words < args.min_words or len(text) < args.min_chars:
                    print(f"Skipped short transcript: {text!r}")
                    continue

                print(f"[heard] {text}")
                result = post_transcript(args.pi, text, args.source)
                print(f"[sent] id={result.get('id')} lang={info.language} prob={info.language_probability:.2f}")
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                print(f"[error] {exc}", file=sys.stderr)
            finally:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
