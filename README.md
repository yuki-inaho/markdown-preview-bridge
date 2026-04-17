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

- Python 3.10 or newer is recommended.
- Node.js 20 is the validated baseline; see `.node-version`.
- npm is required for the Vite app dependencies.
- `playwright-cli` is required for browser operation.
- Chrome or Chromium is required for headed browser review.
- `xdotool` is optional and only used on Linux/X11 to normalize visible window
  geometry and focus.

Run the environment check:

```bash
python3 scripts/doctor.py
```

## Quick Start

Start a read-only preview server:

```bash
python3 scripts/preview.py \
  --file /absolute/path/to/document.md \
  --root /absolute/path/to/project-or-doc-root \
  --port 8777
```

Open it in a visible browser:

```bash
python3 scripts/open_visible.py \
  --url http://127.0.0.1:8777/ \
  --session md-preview-visible
```

Allow browser-side saving only when needed:

```bash
python3 scripts/preview.py \
  --file /absolute/path/to/document.md \
  --root /absolute/path/to/project-or-doc-root \
  --port 8777 \
  --allow-write
```

The preview also supports browser-local review markers and a draggable split
between the source editor and rendered preview. Markers are stored in the
browser origin's `localStorage`, so they survive reloads and are visible across
tabs opened from the same preview server. The default layout gives the rendered
preview more room than the source editor at source:preview = 2:3; drag the
divider to adjust it, or double-click the divider to reset the review layout.

## Validation

Run the smoke test:

```bash
python3 scripts/quick_validate.py
```

Use `--no-install` only when the Vite dependencies are already present in the
launcher cache, such as in a prepared CI cache or a previously used local
environment.

The smoke test verifies:

- a Markdown file under `--root` can be read;
- root-outside paths are rejected;
- default/read-only save is rejected;
- watch headers are returned as expected.

## Safety Model

This is a trusted-local development bridge, not a shared web service and not a
sandbox for untrusted Markdown.

The server is bound to `127.0.0.1` by default. It restricts file access to the
configured `--root`, checks real paths, limits extensions to Markdown-like files,
and starts in read-only mode. Use `--allow-write` only when browser-side saving
is part of the workflow.

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
