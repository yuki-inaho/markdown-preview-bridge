import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const initialSourceFile = path.resolve(process.env.MD_PREVIEW_FILE || '');
const previewRoot = path.resolve(process.env.MD_PREVIEW_ROOT || path.dirname(initialSourceFile || process.cwd()));
const host = process.env.MD_PREVIEW_HOST || '127.0.0.1';
const port = Number(process.env.MD_PREVIEW_PORT || '8777');
const watchEnabled = process.env.MD_PREVIEW_WATCH !== '0';
const readOnly = process.env.MD_PREVIEW_READ_ONLY === '1';
const allowedExtensions = new Set(
  String(process.env.MD_PREVIEW_ALLOW_EXT || '.md,.markdown,.mdown,.mkd')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const allowedAssetExtensions = new Set(
  String(process.env.MD_PREVIEW_ASSET_EXT || '.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.avif')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
// One server may browse several files under the same root, but the lightweight
// hot-reload path tracks only the currently active Markdown file.
let activeWatchFile = null;
let activeWatcher = null;

if (!initialSourceFile) {
  throw new Error('MD_PREVIEW_FILE is required');
}

function closeActiveWatcher() {
  if (!activeWatcher) return;
  try {
    activeWatcher.close();
  } catch (error) {
    console.warn('Markdown watcher cleanup failed:', error);
  }
  activeWatcher = null;
  activeWatchFile = null;
}

function isInsideRoot(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

async function realPreviewRoot() {
  return fs.realpath(previewRoot);
}

async function requestedFile(req) {
  // Every read/write API request resolves through this gate. realpath prevents
  // symlink escapes from the preview root, and the extension allowlist keeps the
  // local bridge focused on Markdown-like source files.
  const url = new URL(req.url || '/', 'http://markdown-preview.local');
  const rawPath = url.searchParams.get('path');
  const target = path.resolve(rawPath || initialSourceFile);
  const [realRoot, realTarget] = await Promise.all([realPreviewRoot(), fs.realpath(target)]);
  if (!isInsideRoot(realRoot, realTarget)) {
    const error = new Error(`Markdown path is outside preview root: ${realTarget}`);
    error.statusCode = 403;
    throw error;
  }
  const ext = path.extname(realTarget).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    const error = new Error(`Markdown extension is not allowed: ${ext || '(none)'}`);
    error.statusCode = 403;
    throw error;
  }
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    const error = new Error(`Markdown path is not a file: ${realTarget}`);
    error.statusCode = 400;
    throw error;
  }
  return realTarget;
}

async function requestedAsset(req) {
  // Local images are served through the same root/realpath boundary as Markdown
  // files, but with an image-only extension allowlist.
  const url = new URL(req.url || '/', 'http://markdown-preview.local');
  const rawPath = url.searchParams.get('path');
  if (!rawPath) {
    const error = new Error('Asset path is required.');
    error.statusCode = 400;
    throw error;
  }
  const target = path.resolve(rawPath);
  const [realRoot, realTarget] = await Promise.all([realPreviewRoot(), fs.realpath(target)]);
  if (!isInsideRoot(realRoot, realTarget)) {
    const error = new Error(`Asset path is outside preview root: ${realTarget}`);
    error.statusCode = 403;
    throw error;
  }
  const ext = path.extname(realTarget).toLowerCase();
  if (!allowedAssetExtensions.has(ext)) {
    const error = new Error(`Asset extension is not allowed: ${ext || '(none)'}`);
    error.statusCode = 403;
    throw error;
  }
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    const error = new Error(`Asset path is not a file: ${realTarget}`);
    error.statusCode = 400;
    throw error;
  }
  return { path: realTarget, stat, ext };
}

function assetContentType(ext) {
  return {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.webp': 'image/webp',
  }[ext] || 'application/octet-stream';
}

function ensureWatched(server, sourceFile) {
  // fs.watch is used only as a fast local feedback signal. The browser checks
  // sourcePath before reloading so stale events from another file are ignored.
  if (!watchEnabled || activeWatchFile === sourceFile) return;
  closeActiveWatcher();
  try {
    const watcher = fsSync.watch(sourceFile, { persistent: false }, (eventType) => {
      server.ws.send({
        type: 'custom',
        event: 'markdown-preview:file-changed',
        data: {
          sourcePath: sourceFile,
          eventType,
          changedAt: Date.now(),
        },
      });
    });
    watcher.on('error', (error) => {
      console.warn(`Markdown watch error for ${sourceFile}:`, error);
      closeActiveWatcher();
    });
    activeWatchFile = sourceFile;
    activeWatcher = watcher;
  } catch (error) {
    console.warn(`Markdown watch unavailable for ${sourceFile}:`, error);
  }
}

function sendError(res, error) {
  res.statusCode = error?.statusCode || 500;
  res.end(String(error?.stack || error));
}

function markdownPreviewApiPlugin() {
  return {
    name: 'markdown-preview-bridge-api',
    configureServer(server) {
      server.middlewares.use('/api/markdown', async (req, res) => {
        try {
          const sourceFile = await requestedFile(req);
          ensureWatched(server, sourceFile);
          const body = await fs.readFile(sourceFile, 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'text/markdown; charset=utf-8');
          // Headers are the browser bridge's source of truth for the current
          // guardrails; the UI should not infer these from URL text.
          res.setHeader('x-source-path', encodeURIComponent(sourceFile));
          res.setHeader('x-watch-enabled', watchEnabled ? '1' : '0');
          res.setHeader('x-read-only', readOnly ? '1' : '0');
          res.setHeader('x-preview-root', encodeURIComponent(await realPreviewRoot()));
          res.setHeader('x-allow-ext', Array.from(allowedExtensions).join(','));
          res.end(body);
        } catch (error) {
          sendError(res, error);
        }
      });

      server.middlewares.use('/api/asset', async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405;
            res.end('GET or HEAD required');
            return;
          }
          const asset = await requestedAsset(req);
          res.statusCode = 200;
          res.setHeader('content-type', assetContentType(asset.ext));
          res.setHeader('content-length', String(asset.stat.size));
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-asset-path', encodeURIComponent(asset.path));
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          fsSync.createReadStream(asset.path).pipe(res);
        } catch (error) {
          sendError(res, error);
        }
      });

      server.middlewares.use('/api/save', async (req, res) => {
        // Saving is deliberately opt-in because this bridge is often used for
        // review sessions where the Markdown file should remain the only source
        // of truth and edits should be explicit.
        if (readOnly) {
          res.statusCode = 403;
          res.end('Markdown preview is read-only');
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST required');
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const sourceFile = await requestedFile(req);
            await fs.writeFile(sourceFile, body, 'utf8');
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, sourceFile, bytes: Buffer.byteLength(body) }));
          } catch (error) {
            sendError(res, error);
          }
        });
      });
    },
  };
}

const server = await createServer({
  root: process.cwd(),
  plugins: [markdownPreviewApiPlugin(), react()],
  server: {
    host,
    port,
    strictPort: true,
  },
});

await server.listen();
server.printUrls();
console.log(`Markdown source: ${initialSourceFile}`);
console.log(`Markdown root: ${previewRoot}`);
console.log(`Markdown hot reload: ${watchEnabled ? 'enabled' : 'disabled'}`);
console.log(`Markdown read-only: ${readOnly ? 'enabled' : 'disabled'}`);
console.log(`Markdown allowed extensions: ${Array.from(allowedExtensions).join(',')}`);
console.log(`Markdown asset extensions: ${Array.from(allowedAssetExtensions).join(',')}`);

process.once('SIGINT', () => {
  closeActiveWatcher();
  process.exit(130);
});
process.once('SIGTERM', () => {
  closeActiveWatcher();
  process.exit(143);
});
