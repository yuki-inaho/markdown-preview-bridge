# Security Policy

Markdown Preview Bridge is a trusted-local development tool. It starts a local
HTTP server, reads Markdown files from disk, and can optionally write Markdown
files back to disk.

## Supported Use

- Use it on Markdown files you trust.
- Keep the server bound to `127.0.0.1` unless you have a specific reason not to.
- Use `--root` to restrict file access to a project or document directory.
- Use the default read-only mode for review sessions.
- Use `--allow-write` only when browser-side saving is required.

## File Access Guardrails

The preview server:

- resolves requested paths with `realpath`;
- rejects files outside the configured preview root;
- allows Markdown-like extensions only by default;
- starts in read-only mode unless `--allow-write` is passed.

## Non-Goals

This project is not a sandbox for untrusted Markdown and is not a shared web
service. Raw HTML, Mermaid, KaTeX, and Markdown plugin behavior should be
treated as trusted-local-input concerns.

## Reporting Issues

When reporting a security issue, include:

- the command used to start the bridge;
- the configured `--root`;
- whether `--allow-write` was used;
- the operating system and Node/Python versions;
- a minimal Markdown file or request path that reproduces the issue.
