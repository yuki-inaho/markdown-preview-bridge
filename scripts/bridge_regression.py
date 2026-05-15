#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PREVIEW = REPO_ROOT / "scripts" / "preview.py"
BASE_BRIDGE_KEYS = {
    "diagnostics",
    "headings",
    "images",
    "findText",
    "getSelectionContext",
    "selectionDetails",
    "getMarkdown",
    "reloadMarkdown",
}
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6360000002000100ffff030000060005"
    "57bfab6a0000000049454e44ae426082"
)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=5) as response:
        body = response.read().decode("utf-8")
        return response.status, body


def read_process_output(process: subprocess.Popen[str]) -> str:
    if not process.stdout:
        return ""
    try:
        return process.stdout.read()
    except Exception:  # noqa: BLE001 - diagnostics only.
        return ""


def wait_until_ready(url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.time() + 40
    last_error: Exception | None = None
    while time.time() < deadline:
        if process.poll() is not None:
            output = read_process_output(process)
            raise RuntimeError(
                f"Preview server exited before becoming ready (code={process.returncode}).\n{output}"
            )
        try:
            fetch(url)
            return
        except Exception as exc:  # noqa: BLE001 - test should report last startup failure.
            last_error = exc
            time.sleep(0.5)
    output = read_process_output(process)
    raise RuntimeError(f"Preview server did not become ready: {last_error}\n{output}")


def run_playwright(session: str, *args: str, check: bool = True) -> str:
    cmd = ["playwright-cli", f"-s={session}", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(
            "Playwright CLI command failed:\n"
            f"$ {' '.join(cmd)}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result.stdout


def parse_result_block(output: str):
    marker = "### Result"
    index = output.find(marker)
    if index == -1:
        return None
    payload = output[index + len(marker) :].lstrip()
    next_section = payload.find("\n### ")
    if next_section != -1:
        payload = payload[:next_section]
    payload = payload.strip()
    if not payload or payload == "undefined":
        return None
    return json.loads(payload)


def wait_for_bridge(session: str, *, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last_output = ""
    while time.time() < deadline:
        try:
            output = run_playwright(
                session,
                "eval",
                "() => ({ ready: Boolean(window.__mdPreviewBridge), title: document.title })",
            )
            last_output = output
            result = parse_result_block(output) or {}
            if result.get("ready"):
                return
        except Exception as exc:  # noqa: BLE001 - navigation races are transient here.
            last_output = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"Bridge did not become ready:\n{last_output}")


def make_sample_markdown() -> str:
    return "\n".join(
        [
            "# Sample",
            "",
            "This line is intentionally long so the editor must wrap it visually while still treating it as one Markdown source line for logical line navigation checks in the regression test.",
            "",
            "![Pixel](assets/pixel.png)",
            "",
            "## Math",
            "",
            "Inline math: $a^2 + b^2 = c^2$",
            "",
            "$$",
            "\\int_0^1 x^2 dx",
            "$$",
            "",
            "## Table",
            "",
            "| A | B |",
            "|---|---|",
            "| 1 | 2 |",
            "",
            "## Code",
            "",
            "```python",
            "print('ok')",
            "```",
        ]
    )


def verify_bridge_contract(
    result: dict,
    *,
    source_path: Path,
    expected_line_count: int,
    target_line: int,
    require_line_navigation: bool,
) -> None:
    failures: list[str] = []

    def expect(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    bridge_keys = set(result.get("bridgeKeys") or [])
    diagnostics_before = result.get("diagnosticsBefore") or {}
    diagnostics_after = result.get("diagnosticsAfter") or diagnostics_before
    counts = result.get("counts") or {}
    images = result.get("images") or []
    image_fetches = result.get("imageFetches") or []
    layout = result.get("layout") or {}

    expect(BASE_BRIDGE_KEYS.issubset(bridge_keys), f"Missing bridge keys: {sorted(BASE_BRIDGE_KEYS - bridge_keys)}")
    expect(diagnostics_before.get("sourcePath") == str(source_path), "diagnostics.sourcePath does not match fixture")
    expect(str(source_path.name) in str(diagnostics_before.get("pageTitle") or ""), "page title does not include source file name")
    expect(counts.get("headingCount", 0) >= 3, "expected rendered headings to be counted")
    expect(counts.get("tableCount", 0) >= 1, "expected rendered table to be counted")
    expect(counts.get("codeBlockCount", 0) >= 1, "expected rendered code block to be counted")
    expect(counts.get("imageCount", 0) >= 1, "expected rendered image to be counted")
    expect(counts.get("imageLoadedCount", 0) >= 1, "expected relative image to load through /api/asset")
    expect(counts.get("imageBrokenCount", 0) == 0, f"expected no broken images, got {counts.get('imageBrokenCount')}")
    expect(images and images[0].get("naturalWidth", 0) > 0, f"expected image natural size to be available: {images}")
    expect(images and str(images[0].get("src") or "").startswith("/api/asset?path="), f"expected image src to use /api/asset: {images}")
    expect(
        image_fetches and image_fetches[0].get("status") == 200,
        f"expected image fetch to return HTTP 200: {image_fetches}",
    )
    expect(
        image_fetches and image_fetches[0].get("contentType") == "image/png",
        f"expected image fetch to return image/png: {image_fetches}",
    )
    expect(layout.get("noOverlap") is True, f"marker strip overlaps main content: {layout}")

    if require_line_navigation:
        expect("gotoLine" in bridge_keys, "bridge.gotoLine is missing")
        goto_result = result.get("gotoResult") or {}
        editor = result.get("editor") or {}

        expect(editor.get("lineNumbers") is True, "editor lineNumbers is not enabled")
        expect(editor.get("lineWrapping") is True, "editor lineWrapping is not enabled")
        expect(
            diagnostics_before.get("lineCount") == expected_line_count,
            "diagnostics.lineCount does not match Markdown logical line count",
        )
        expect(isinstance(diagnostics_before.get("cursorLine"), int), "diagnostics.cursorLine is missing")
        expect(goto_result.get("ok") is True, f"gotoLine failed: {goto_result}")
        expect(goto_result.get("line") == target_line, f"gotoLine navigated to unexpected line: {goto_result}")
        expect(diagnostics_after.get("cursorLine") == target_line, "cursorLine did not move after gotoLine")
        expect(diagnostics_after.get("lineCount") == expected_line_count, "lineCount changed after gotoLine")
        expect(result.get("katexCount", 0) >= 1, "expected rendered KaTeX output for math sample")

    if failures:
        raise AssertionError("\n- " + "\n- ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run CLI-only browser regression tests for markdown-preview-bridge.")
    parser.add_argument(
        "--preview-script",
        default=str(DEFAULT_PREVIEW),
        help="Path to the preview.py under test. Defaults to this repository's scripts/preview.py.",
    )
    parser.add_argument("--browser", default="chrome", help="Browser name for playwright-cli open")
    parser.add_argument("--session", default=None, help="Playwright session name. Defaults to a unique temporary value.")
    parser.add_argument("--port", type=int, default=0, help="Server port. Defaults to a free local port.")
    parser.add_argument("--app-dir", default=None, help="Optional app-dir to pass through to preview.py")
    parser.add_argument("--no-install", action="store_true", help="Pass --no-install to preview.py")
    parser.add_argument(
        "--require-line-navigation",
        action="store_true",
        help="Also require gotoLine(), diagnostics cursor/lineCount, wrapped logical-line behavior, and KaTeX output.",
    )
    args = parser.parse_args()

    if not shutil.which("playwright-cli"):
        raise SystemExit("playwright-cli not found. Install playwright-cli before running bridge_regression.py.")

    preview_script = Path(args.preview_script).expanduser().resolve()
    if not preview_script.is_file():
        raise SystemExit(f"preview.py not found: {preview_script}")

    port = args.port or find_free_port()
    session = args.session or f"md-preview-regression-{int(time.time())}-{port}"

    with tempfile.TemporaryDirectory(prefix="md-preview-bridge-regression-") as temp_dir:
        root = Path(temp_dir)
        asset = root / "assets" / "pixel.png"
        asset.parent.mkdir()
        asset.write_bytes(PNG_1X1)
        source = root / "sample.md"
        source.write_text(make_sample_markdown(), encoding="utf-8")
        expected_line_count = len(source.read_text(encoding="utf-8").splitlines())
        target_line = 9

        cmd = [
            sys.executable,
            str(preview_script),
            "--file",
            str(source),
            "--root",
            str(root),
            "--port",
            str(port),
            "--no-watch",
        ]
        if args.app_dir:
            cmd.extend(["--app-dir", str(Path(args.app_dir).expanduser().resolve())])
        if args.no_install:
            cmd.append("--no-install")

        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            api_url = f"http://127.0.0.1:{port}/api/markdown?path={urllib.parse.quote(str(source))}"
            wait_until_ready(api_url, process)

            page_url = f"http://127.0.0.1:{port}/?path={urllib.parse.quote(str(source))}"
            run_playwright(session, "open", page_url, "--browser", args.browser)
            wait_for_bridge(session)

            output = run_playwright(
                session,
                "eval",
                f"""async () => {{
  const bridge = window.__mdPreviewBridge;
  const waitForImages = () => new Promise((resolve) => {{
    const deadline = Date.now() + 5000;
    const check = () => {{
      const images = Array.from(document.querySelectorAll('#rendered img'));
      if (images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)) {{
        resolve();
        return;
      }}
      if (Date.now() > deadline) {{
        resolve();
        return;
      }}
      setTimeout(check, 100);
    }};
    check();
  }});
  await waitForImages();
  const cm = document.querySelector('.editor-pane .CodeMirror')?.CodeMirror;
  const shell = document.querySelector('.app-shell');
  const marker = document.querySelector('.marker-strip');
  const main = document.querySelector('main');
  const rect = (element) => {{
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {{ top: r.top, bottom: r.bottom, height: r.height }};
  }};
  const diagnosticsBefore = bridge?.diagnostics?.() || null;
  const images = bridge?.images?.() || [];
  const imageFetches = await Promise.all(images.map(async (image) => {{
    const response = await fetch(image.src);
    return {{
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length')
    }};
  }}));
  const gotoResult = bridge?.gotoLine?.({target_line}, {{ focus: false }}) || null;
  const diagnosticsAfter = bridge?.diagnostics?.() || null;
  return {{
    bridgeKeys: bridge ? Object.keys(bridge) : [],
    diagnosticsBefore,
    diagnosticsAfter,
    gotoResult,
    editor: {{
      lineNumbers: cm?.getOption?.('lineNumbers') ?? null,
      lineWrapping: cm?.getOption?.('lineWrapping') ?? null
    }},
    counts: {{
      headingCount: diagnosticsBefore?.headingCount ?? 0,
      tableCount: diagnosticsBefore?.tableCount ?? 0,
      codeBlockCount: diagnosticsBefore?.codeBlockCount ?? 0,
      imageCount: diagnosticsBefore?.imageCount ?? 0,
      imageLoadedCount: diagnosticsBefore?.imageLoadedCount ?? 0,
      imageBrokenCount: diagnosticsBefore?.imageBrokenCount ?? 0
    }},
    images,
    imageFetches,
    katexCount: document.querySelectorAll('#rendered .katex, #rendered .katex-display').length,
    layout: {{
      gridTemplateRows: shell ? getComputedStyle(shell).gridTemplateRows : null,
      marker: rect(marker),
      main: rect(main),
      noOverlap: marker && main ? marker.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + 0.5 : null
    }}
  }};
}}""",
            )
            result = parse_result_block(output)
            if not isinstance(result, dict):
                raise RuntimeError(f"Unexpected Playwright eval output:\n{output}")

            verify_bridge_contract(
                result,
                source_path=source,
                expected_line_count=expected_line_count,
                target_line=target_line,
                require_line_navigation=args.require_line_navigation,
            )
        finally:
            run_playwright(session, "close", check=False)
            run_playwright(session, "delete-data", check=False)
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    print(
        "markdown-preview-bridge browser regression passed"
        + (" (line navigation contract enabled)" if args.require_line_navigation else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
