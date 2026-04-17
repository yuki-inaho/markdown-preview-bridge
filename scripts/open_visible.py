#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import time


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def find_window(title: str, timeout_sec: float) -> str:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        result = run(["xdotool", "search", "--onlyvisible", "--name", title], check=False)
        windows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if windows:
            return windows[-1]
        time.sleep(0.2)
    raise SystemExit(f"Window not found: {title}")


def geometry_matches(output: str, width: int, height: int) -> bool:
    return f"Geometry: {width}x{height}" in output


def wait_geometry(window: str, width: int, height: int, timeout_sec: float) -> str:
    deadline = time.monotonic() + timeout_sec
    last_output = ""
    while time.monotonic() < deadline:
        result = run(["xdotool", "getwindowgeometry", window])
        last_output = result.stdout
        if geometry_matches(last_output, width, height):
            return last_output
        time.sleep(0.2)
    return last_output


def main() -> int:
    parser = argparse.ArgumentParser(description="Open a Markdown Preview Bridge page in a visible browser and normalize its window geometry.")
    parser.add_argument("--url", default="http://127.0.0.1:8777/")
    parser.add_argument("--session", default="md-preview-visible")
    parser.add_argument("--browser", default="chrome")
    parser.add_argument("--title", default="Markdown Preview Bridge")
    parser.add_argument("--x", type=int, default=int(os.environ.get("MD_PREVIEW_WINDOW_X", "80")))
    parser.add_argument("--y", type=int, default=int(os.environ.get("MD_PREVIEW_WINDOW_Y", "40")))
    parser.add_argument("--width", type=int, default=int(os.environ.get("MD_PREVIEW_WINDOW_WIDTH", "1600")))
    parser.add_argument("--height", type=int, default=int(os.environ.get("MD_PREVIEW_WINDOW_HEIGHT", "1000")))
    parser.add_argument("--timeout-sec", type=float, default=10.0)
    args = parser.parse_args()

    if not shutil.which("playwright-cli"):
        raise SystemExit("playwright-cli not found")

    subprocess.run(
        [
            "playwright-cli",
            f"-s={args.session}",
            "open",
            args.url,
            "--browser",
            args.browser,
            "--headed",
        ],
        check=True,
    )

    if not shutil.which("xdotool"):
        print("xdotool not found; visible browser was opened but window geometry was not normalized.", flush=True)
        return 0

    window = find_window(args.title, args.timeout_sec)
    run(
        [
            "xdotool",
            "windowmove",
            window,
            str(args.x),
            str(args.y),
            "windowsize",
            window,
            str(args.width),
            str(args.height),
            "windowactivate",
            window,
        ]
    )
    print(wait_geometry(window, args.width, args.height, args.timeout_sec), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
