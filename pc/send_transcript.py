#!/usr/bin/env python3
"""Send transcript text from a PC to the Brain Pi dashboard relay."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


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

    payload = json.dumps({"text": text, "source": args.source}).encode("utf-8")
    req = urllib.request.Request(
        args.pi.rstrip("/") + "/api/transcript",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
            print(body)
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
