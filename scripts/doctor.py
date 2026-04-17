#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import sys


REQUIRED = ["node", "npm", "playwright-cli"]
OPTIONAL = ["google-chrome", "chromium", "chromium-browser", "xdotool"]


def version(cmd: str) -> str:
    try:
        result = subprocess.run([cmd, "--version"], check=False, capture_output=True, text=True, timeout=5)
    except Exception as exc:  # noqa: BLE001 - diagnostic script should stay best-effort.
        return f"error: {exc}"
    text = (result.stdout or result.stderr).strip()
    return text.splitlines()[0] if text else f"exit={result.returncode}"


def main() -> int:
    print("Markdown Preview Bridge doctor")
    print(f"Python: {sys.version.split()[0]}")

    missing_required = []
    for cmd in REQUIRED:
        path = shutil.which(cmd)
        if not path:
            missing_required.append(cmd)
            print(f"required: {cmd}: missing")
            continue
        print(f"required: {cmd}: {path} ({version(cmd)})")

    chrome_found = False
    for cmd in OPTIONAL:
        path = shutil.which(cmd)
        if not path:
            print(f"optional: {cmd}: missing")
            continue
        if cmd in {"google-chrome", "chromium", "chromium-browser"}:
            chrome_found = True
        print(f"optional: {cmd}: {path} ({version(cmd)})")

    if not chrome_found:
        print("warning: no Chrome/Chromium binary was found on PATH; playwright-cli may still manage a browser.")
    if not shutil.which("xdotool"):
        print("warning: xdotool missing; headed browser geometry normalization is disabled.")

    if missing_required:
        print("doctor result: failed")
        return 1
    print("doctor result: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
