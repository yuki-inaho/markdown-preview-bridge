# Markdown Preview Bridge

Markdown Preview Bridge is an agent skill for Overleaf-like local Markdown review.
It opens a local Markdown file in a fast ByteMD + Vite browser preview and exposes
a small Playwright-readable DOM bridge for diagnostics, headings, text lookup, and
browser selection context.

The intended workflow is:

```text
local .md -> browser preview -> Playwright DOM inspection -> agent edits .md -> reload/recheck
```

## Install

If this repository is published as a skill repository, install it with the
Vercel skills CLI from the consumer project:

```bash
npx skills add <owner/repo> --agent codex --skill markdown-preview-bridge
```

For personal/global installation, use the scope supported by your skills CLI
version. If symlinks are not suitable for the target environment, use the CLI's
copy mode.

## Requirements

- `uv` is the recommended way to run the bundled Python tools reproducibly.
- Python 3.10 or newer is required; `.python-version` pins the local dev/test baseline used by `uv`.
- Node.js 20 is the validated baseline; see `.node-version`.
- npm is required for the Vite app dependencies.
- `playwright-cli` is required for browser operation.
- Chrome or Chromium is required for headed browser review.
- `xdotool` is optional and only used on Linux/X11 to normalize visible window
  geometry and focus.

Bootstrap the Python tooling environment:

```bash
uv sync --frozen
```

If `just` is installed, the root `justfile` exposes the common commands.

Run the environment check:

```bash
uv run --frozen scripts/doctor.py
# or: just doctor
```

## Quick Start

Start a read-only preview server:

```bash
uv run --frozen scripts/preview.py \
  --file /absolute/path/to/document.md \
  --root /absolute/path/to/project-or-doc-root \
  --port 8777

# or: just preview /absolute/path/to/document.md /absolute/path/to/project-or-doc-root
```

Open it in a visible browser:

```bash
uv run --frozen scripts/open_visible.py \
  --url http://127.0.0.1:8777/ \
  --session md-preview-visible

# or: just open-visible
```

Allow browser-side saving only when needed:

```bash
uv run --frozen scripts/preview.py \
  --file /absolute/path/to/document.md \
  --root /absolute/path/to/project-or-doc-root \
  --port 8777 \
  --allow-write
```

Relative Markdown images are resolved from the Markdown file's directory and
served through `/api/asset` when the target image stays under `--root`.
The default image allowlist is `.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.avif`;
override it with `--asset-ext` when a review document needs a different local
image format.

The preview also supports browser-local review markers and a draggable split
between the source editor and rendered preview. Markers are stored in the
browser origin's `localStorage`, so they survive reloads and are visible across
tabs opened from the same preview server. The default layout gives the rendered
preview more room than the source editor at source:preview = 2:3; drag the
divider to adjust it, or double-click the divider to reset the review layout.

## Validation

Run the smoke test:

```bash
uv run --frozen scripts/quick_validate.py
# or: just quick-validate
```

Use `--no-install` only when the Vite dependencies are already present in the
launcher cache, such as in a prepared CI cache or a previously used local
environment.

The smoke test verifies:

- a Markdown file under `--root` can be read;
- root-outside paths are rejected;
- root-contained image assets can be read through `/api/asset`;
- root-outside assets and non-image assets are rejected;
- default/read-only save is rejected;
- watch headers are returned as expected.

Run the CLI-only browser regression test:

```bash
uv run --frozen scripts/bridge_regression.py
# or: just bridge-regression
```

This headless regression test starts the preview server, opens it through
`playwright-cli`, and verifies the browser bridge contract plus the split-layout
guardrail that keeps the marker strip from overlapping the main panes. It also
checks that a Markdown-relative image loads through `/api/asset` instead of
falling back to Vite's HTML response.

When comparing a merge target against another checkout or installed skill,
override the launcher path and enable the line-navigation contract:

```bash
uv run --frozen scripts/bridge_regression.py \
  --preview-script /absolute/path/to/other/markdown-preview-bridge/scripts/preview.py \
  --require-line-navigation

# or:
just bridge-regression \
  --preview-script /absolute/path/to/other/markdown-preview-bridge/scripts/preview.py \
  --require-line-navigation
```

When comparing two different checkouts or an installed skill against this
repository, run them sequentially or give each run its own `--app-dir` so their
synced Vite caches do not overwrite each other.

## Safety Model

This is a trusted-local development bridge, not a shared web service and not a
sandbox for untrusted Markdown.

The server is bound to `127.0.0.1` by default. It restricts file access to the
configured `--root`, checks real paths, limits Markdown and image asset
extensions separately, and starts in read-only mode. Use `--allow-write` only
when browser-side saving is part of the workflow.

## Known Limitations

- Source mapping is approximate and currently uses rendered text matching.
- Scroll sync is ratio-based and can drift with tables, code blocks, Mermaid,
  KaTeX, or images.
- Marker anchors are browser-local review state and can become stale after
  large source edits.
- Syntax highlighting is not yet a full Shiki/Prism/highlight.js integration.
- Mermaid, KaTeX, image, and link diagnostics are not yet fully structured.
- Large Markdown files should be inspected through bridge diagnostics rather than
  full Playwright snapshots.

## References and Influences

- [StackEdit](https://stackedit.io/) informed the split source/preview editing
  model and Markdown review workflow.
- [ByteMD](https://bytemd.js.org/) provides the Markdown editor/viewer foundation
  used by the local browser preview.
- [Vite](https://vite.dev/) provides the local development server, fast reload
  loop, and custom API middleware hook used by the bridge.
- [Playwright](https://playwright.dev/) and `playwright-cli` informed the browser
  automation surface and the lightweight `window.__mdPreviewBridge` inspection
  API.
- [Mermaid](https://mermaid.js.org/) and [KaTeX](https://katex.org/) support are
  included through ByteMD plugins for diagram and math-heavy Markdown documents.
