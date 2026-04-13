#!/usr/bin/env python3
"""Send transcript text from a PC to the Brain Pi dashboard relay."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def post_transcript(pi_base_url: str, text: str, source: str) -> dict:
    payload = json.dumps({"text": text, "source": source}).encode("utf-8")
    req = urllib.request.Request(
        pi_base_url.rstrip("/") + "/api/transcript",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="POST transcript text to the Brain Pi /api/transcript relay."
    )
    parser.add_argument(
        "--pi",
        default="http://triagedashboard:3000",
        help="Brain Pi base URL, for example http://192.168.1.50:3000",
    )
    parser.add_argument(
        "--source",
        default="pc-manual",
        help="Short source label to show in the Brain Pi logs.",
    )
    parser.add_argument(
        "text",
        nargs="*",
        help="Transcript text to send. If omitted, stdin is used.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = " ".join(args.text).strip()
    if not text:
        text = sys.stdin.read().strip()

    if not text:
        print("No transcript text provided.", file=sys.stderr)
        return 1

    try:
        body = post_transcript(args.pi, text, args.source)
        print(json.dumps(body))
        return 0
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        print(f"HTTP {exc.code}: {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
