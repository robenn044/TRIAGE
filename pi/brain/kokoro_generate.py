#!/usr/bin/env python3
"""Generate a WAV file with kokoro-onnx."""

from __future__ import annotations

import argparse

import soundfile as sf
from kokoro_onnx import Kokoro


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Kokoro TTS wav file.")
    parser.add_argument("--model", required=True, help="Path to kokoro-v1.0.onnx")
    parser.add_argument("--voices", required=True, help="Path to voices-v1.0.bin")
    parser.add_argument("--voice", default="af_sarah", help="Kokoro voice id")
    parser.add_argument("--lang", default="en-us", help="Language code")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--output", required=True, help="Output wav path")
    parser.add_argument("text", help="Text to synthesize")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(
        args.text,
        voice=args.voice,
        speed=args.speed,
        lang=args.lang,
    )
    sf.write(args.output, samples, sample_rate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
