#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
APP_SOURCE = SKILL_ROOT / "assets" / "app"
DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "markdown-preview-bridge" / "app"


def run(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def sync_app(dest: Path) -> None:
    # Run the Vite app from a cache copy so an installed skill repository stays
    # source-only. Generated directories are recreated in the cache as needed.
    dest.mkdir(parents=True, exist_ok=True)
    for src in APP_SOURCE.iterdir():
        if src.name in {"node_modules", "dist", ".vite"}:
            continue
        target = dest / src.name
        if src.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(src, target, ignore=shutil.ignore_patterns("node_modules", "dist", ".vite"))
        else:
            shutil.copy2(src, target)


def ensure_deps(app_dir: Path) -> None:
    # Dependency freshness depends on both package metadata and the Node runtime:
    # changing Node can invalidate Vite/plugin output even if package.json did
    # not change.
    node_modules = app_dir / "node_modules"
    package_json = app_dir / "package.json"
    package_lock = app_dir / "package-lock.json"
    package_hash_file = app_dir / ".package-json.sha256"
    node = shutil.which("node")
    if not node:
        raise SystemExit("node not found. Install Node.js before using markdown-preview-bridge.")
    node_version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    digest = hashlib.sha256()
    digest.update(package_json.read_bytes())
    if package_lock.exists():
        digest.update(package_lock.read_bytes())
    digest.update(node_version.encode("utf-8"))
    package_hash = digest.hexdigest()
    if node_modules.exists() and package_hash_file.exists() and package_hash_file.read_text().strip() == package_hash:
        return
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("npm not found. Install Node.js/npm before using markdown-preview-bridge.")
    if package_lock.exists():
        run([npm, "ci"], cwd=app_dir)
    else:
        run([npm, "install"], cwd=app_dir)
    package_hash_file.write_text(package_hash + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve a local Markdown file in a ByteMD/Vite preview bridge.")
    parser.add_argument("--file", required=True, help="Local Markdown file path")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument(
        "--root",
        default=None,
        help="Allowed root directory for Markdown read/write. Defaults to the input file's parent directory.",
    )
    parser.add_argument("--app-dir", default=str(DEFAULT_CACHE), help="Prepared Vite app directory")
    parser.add_argument("--no-install", action="store_true", help="Do not run npm install automatically")
    parser.add_argument("--no-watch", action="store_true", help="Disable Markdown file hot reload")
    parser.add_argument(
        "--allow-write",
        action="store_true",
        help="Enable /api/save. By default, the bridge starts in read-only mode for safer public-skill usage.",
    )
    parser.add_argument("--read-only", action="store_true", help="Keep /api/save disabled. This is the default.")
    parser.add_argument(
        "--allow-ext",
        default=".md,.markdown,.mdown,.mkd",
        help="Comma-separated Markdown file extensions allowed under --root",
    )
    parser.add_argument(
        "--asset-ext",
        default=".png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.avif",
        help="Comma-separated image asset extensions that may be served under --root",
    )
    args = parser.parse_args()
    read_only = True if args.read_only else not args.allow_write

    markdown_path = Path(args.file).expanduser().resolve()
    if not markdown_path.is_file():
        raise SystemExit(f"Markdown file not found: {markdown_path}")
    root_path = Path(args.root).expanduser().resolve() if args.root else markdown_path.parent
    if not root_path.is_dir():
        raise SystemExit(f"Markdown preview root is not a directory: {root_path}")
    # This launcher check gives an early, readable error. The Node server still
    # enforces the trust boundary with realpath on every API request.
    try:
        markdown_path.relative_to(root_path)
    except ValueError as exc:
        raise SystemExit(f"Markdown file must be under preview root: file={markdown_path} root={root_path}") from exc

    app_dir = Path(args.app_dir).expanduser().resolve()
    sync_app(app_dir)
    if not args.no_install:
        ensure_deps(app_dir)

    node = shutil.which("node")
    if not node:
        raise SystemExit("node not found. Install Node.js before using markdown-preview-bridge.")

    env = os.environ.copy()
    env["MD_PREVIEW_FILE"] = str(markdown_path)
    env["MD_PREVIEW_ROOT"] = str(root_path)
    env["MD_PREVIEW_HOST"] = args.host
    env["MD_PREVIEW_PORT"] = str(args.port)
    env["MD_PREVIEW_WATCH"] = "0" if args.no_watch else "1"
    env["MD_PREVIEW_READ_ONLY"] = "1" if read_only else "0"
    env["MD_PREVIEW_ALLOW_EXT"] = args.allow_ext
    env["MD_PREVIEW_ASSET_EXT"] = args.asset_ext
    # Polling avoids Vite/Chokidar EMFILE failures in containerized or low-inotify environments.
    env.setdefault("CHOKIDAR_USEPOLLING", "1")

    print(f"Markdown: {markdown_path}", flush=True)
    print(f"Root: {root_path}", flush=True)
    print(f"Read-only: {'yes' if read_only else 'no'}", flush=True)
    print(f"Allowed extensions: {args.allow_ext}", flush=True)
    print(f"Asset extensions: {args.asset_ext}", flush=True)
    print(f"App: {app_dir}", flush=True)
    print(f"Open: http://{args.host}:{args.port}/", flush=True)
    subprocess.run([node, "server.mjs"], cwd=app_dir, env=env, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
