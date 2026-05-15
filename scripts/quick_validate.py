#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
PREVIEW = SKILL_ROOT / "scripts" / "preview.py"
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6360000002000100ffff030000060005"
    "57bfab6a0000000049454e44ae426082"
)


def fetch(url: str) -> tuple[int, str, dict[str, str]]:
    with urllib.request.urlopen(url, timeout=5) as response:
        body = response.read().decode("utf-8")
        return response.status, body, dict(response.headers.items())


def fetch_bytes(url: str) -> tuple[int, bytes, dict[str, str]]:
    with urllib.request.urlopen(url, timeout=5) as response:
        body = response.read()
        return response.status, body, dict(response.headers.items())


def wait_until_ready(url: str) -> None:
    deadline = time.time() + 30
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            fetch(url)
            return
        except Exception as exc:  # noqa: BLE001 - diagnostic script should report last startup error.
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(f"Preview server did not become ready: {last_error}")


def expect_http_error(url: str, expected_status: int) -> None:
    try:
        fetch(url)
    except urllib.error.HTTPError as exc:
        if exc.code == expected_status:
            return
        raise AssertionError(f"Expected HTTP {expected_status}, got {exc.code}: {url}") from exc
    raise AssertionError(f"Expected HTTP {expected_status}, got success: {url}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a lightweight smoke test for markdown-preview-bridge.")
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--no-install", action="store_true", help="Pass --no-install to preview.py")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="md-preview-bridge-") as root_dir, tempfile.NamedTemporaryFile(
        "w", suffix=".md", delete=False
    ) as outside_file:
        root = Path(root_dir)
        source = root / "sample.md"
        asset = root / "assets" / "pixel.png"
        asset.parent.mkdir()
        asset.write_bytes(PNG_1X1)
        source.write_text(
            "# Sample\n\n![Pixel](assets/pixel.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint('ok')\n```\n",
            encoding="utf-8",
        )
        outside = Path(outside_file.name)
        outside.write_text("# Outside\n", encoding="utf-8")
        outside_asset = outside.with_suffix(".png")
        outside_asset.write_bytes(PNG_1X1)

        cmd = [
            sys.executable,
            str(PREVIEW),
            "--file",
            str(source),
            "--root",
            str(root),
            "--port",
            str(args.port),
            "--no-watch",
        ]
        if args.no_install:
            cmd.append("--no-install")

        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        base = f"http://127.0.0.1:{args.port}"
        try:
            wait_until_ready(f"{base}/api/markdown?path={urllib.parse.quote(str(source))}")
            status, body, headers = fetch(f"{base}/api/markdown?path={urllib.parse.quote(str(source))}")
            assert status == 200
            assert "# Sample" in body
            assert headers.get("x-read-only") == "1"
            assert headers.get("x-watch-enabled") == "0"

            status, asset_body, asset_headers = fetch_bytes(f"{base}/api/asset?path={urllib.parse.quote(str(asset))}")
            assert status == 200
            assert asset_body == PNG_1X1
            assert asset_headers.get("content-type") == "image/png"

            expect_http_error(f"{base}/api/markdown?path={urllib.parse.quote(str(outside))}", 403)
            expect_http_error(f"{base}/api/save?path={urllib.parse.quote(str(source))}", 403)
            expect_http_error(f"{base}/api/asset?path={urllib.parse.quote(str(source))}", 403)
            expect_http_error(f"{base}/api/asset?path={urllib.parse.quote(str(outside_asset))}", 403)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            outside.unlink(missing_ok=True)
            outside_asset.unlink(missing_ok=True)

    print("markdown-preview-bridge quick validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
