import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, Viewer } from '@bytemd/react';
import gfm from '@bytemd/plugin-gfm';
import math from '@bytemd/plugin-math';
import mermaid from '@bytemd/plugin-mermaid';
import 'katex/contrib/copy-tex';
import 'bytemd/dist/index.css';
import 'katex/dist/katex.css';
import './style.css';

const NORMALIZE_RE = /\s+/g;
const MARKER_STORAGE_KEY = 'markdown-preview-bridge:markers:v1';
const MARKER_HIGHLIGHT_NAME = 'markdown-preview-bridge-marker';
const MARKER_FALLBACK_ATTR = 'data-md-marker-fallback';
const PANE_RATIO_STORAGE_KEY = 'markdown-preview-bridge:pane-ratios:v1';
const DEFAULT_PANE_RATIO = 0.4;
const PANE_KEYBOARD_STEP = 0.04;
const MIN_PANE_WIDTH = 360;
const SPLIT_HANDLE_WIDTH = 12;
let katexModulePromise = null;
let mermaidModulePromise = null;
let mermaidInitialized = false;

async function ensureKatex() {
  if (!katexModulePromise) {
    katexModulePromise = import('katex').then((mod) => mod.default || mod);
  }
  return katexModulePromise;
}

async function ensureMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => mod.default || mod);
  }
  const mermaidLib = await mermaidModulePromise;
  if (!mermaidInitialized) {
    mermaidLib.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
    });
    mermaidInitialized = true;
  }
  return mermaidLib;
}

async function renderMathInRenderedDom() {
  const rendered = document.querySelector('#rendered');
  if (!rendered) return;
  const elements = Array.from(rendered.querySelectorAll('.math.math-inline, .math.math-display'));
  if (elements.length === 0) return;
  const katex = await ensureKatex();
  elements.forEach((element) => {
    if (element.querySelector('.katex')) return;
    const expression = element.textContent || '';
    katex.render(expression, element, {
      throwOnError: false,
      displayMode: element.classList.contains('math-display'),
    });
    element.dataset.katexRendered = '1';
  });
}

async function renderMermaidInRenderedDom(reportError = () => {}) {
  const rendered = document.querySelector('#rendered');
  if (!rendered) return;
  const elements = Array.from(rendered.querySelectorAll('pre > code.language-mermaid'));
  if (elements.length === 0) return;
  const mermaidLib = await ensureMermaid();
  await Promise.all(elements.map(async (element, index) => {
    const pre = element.parentElement;
    if (!pre) return;
    const source = element.textContent || '';
    const fallbackPre = pre.cloneNode(true);
    const container = document.createElement('div');
    container.className = 'bytemd-mermaid mermaid';
    container.style.lineHeight = 'initial';
    pre.replaceWith(container);
    try {
      const renderId = `md-preview-mermaid-${Date.now()}-${index}`;
      const renderedSvg = await mermaidLib.render(renderId, source);
      container.innerHTML = renderedSvg.svg;
      renderedSvg.bindFunctions?.(container);
      container.dataset.mermaidRendered = '1';
    } catch (error) {
      container.replaceWith(fallbackPre);
      reportError(error);
    }
  }));
}

function normalizeKatexFragmentToTex(fragment) {
  const katexHtml = fragment.querySelectorAll('.katex-mathml + .katex-html');
  katexHtml.forEach((element) => element.remove?.());

  const katexMathml = fragment.querySelectorAll('.katex-mathml');
  katexMathml.forEach((element) => {
    const texSource = element.querySelector('annotation');
    if (!texSource) return;
    element.replaceWith?.(texSource);
    texSource.innerHTML = `$${texSource.innerHTML}$`;
  });

  const displays = fragment.querySelectorAll('.katex-display annotation');
  displays.forEach((element) => {
    element.innerHTML = `$$${element.innerHTML.slice(1, -1)}$$`;
  });

  return fragment;
}

function selectionPlainText(selection) {
  if (!selection || selection.rangeCount === 0) return '';
  const text = selection.toString();
  if (!selectionIsInsideRendered(selection)) return normalizeText(text);
  const fragment = selection.getRangeAt(0).cloneContents();
  if (!fragment.querySelector?.('.katex-mathml')) return normalizeText(text);
  return normalizeText(normalizeKatexFragmentToTex(fragment).textContent || text);
}

function normalizeText(value) {
  return String(value || '').replace(NORMALIZE_RE, ' ').trim();
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .find((line) => line.length >= 2) || '';
}

function findLineForText(lines, text, startIndex = 0) {
  // This is navigation-grade source mapping, not an AST-backed source map.
  // It favors the next plausible line so repeated headings/paragraphs usually
  // map in reading order.
  const needle = firstUsefulLine(text);
  if (!needle) return null;
  const compactNeedle = needle.slice(0, 100);

  for (let i = Math.max(0, startIndex); i < lines.length; i += 1) {
    if (normalizeText(lines[i]).includes(compactNeedle)) return i + 1;
  }
  for (let i = 0; i < Math.max(0, startIndex); i += 1) {
    if (normalizeText(lines[i]).includes(compactNeedle)) return i + 1;
  }
  return null;
}

function annotateRenderedDom(markdown, sourcePath) {
  // ByteMD does not expose source positions for rendered blocks, so the bridge
  // annotates common block elements after render. Playwright consumers should
  // treat data-md-line as a hint for jumping back into the Markdown source.
  const rendered = document.querySelector('#rendered');
  if (!rendered) return;
  const lines = markdown.split(/\r?\n/);
  const blocks = Array.from(
    rendered.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table')
  );
  let cursor = 0;
  blocks.forEach((block, index) => {
    const text = normalizeText(block.innerText || block.textContent || '');
    const line = findLineForText(lines, text, cursor);
    if (line) cursor = line;
    block.dataset.mdSource = sourcePath;
    block.dataset.mdLine = line ? String(line) : '';
    block.dataset.mdBlock = String(index + 1);
  });
}

function sourceForLine(markdown, line, radius = 3) {
  const lines = markdown.split(/\r?\n/);
  const index = Number(line) - 1;
  if (!Number.isFinite(index) || index < 0 || index >= lines.length) return [];
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines.slice(start, end).map((text, offset) => ({
    line: start + offset + 1,
    text,
  }));
}

function nearestMdBlock(node) {
  let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (current && current !== document.body) {
    if (current.dataset?.mdBlock) return current;
    current = current.parentElement;
  }
  return null;
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || 'Markdown Preview Bridge';
}

function pathFromLocation() {
  return new URLSearchParams(window.location.search).get('path') || '';
}

function markerStorageKey() {
  return MARKER_STORAGE_KEY;
}

function supportsCssHighlights() {
  return typeof CSS !== 'undefined' && typeof Highlight !== 'undefined' && Boolean(CSS.highlights);
}

function readMarkerRegistry() {
  // Markers are browser-local review state, not Markdown content.
  // Versioned localStorage keeps them shared across tabs without mutating .md.
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(markerStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : Array.isArray(parsed) ? parsed : [];
    return markers.filter(Boolean);
  } catch (error) {
    console.warn('Markdown marker registry read failed:', error);
    return [];
  }
}

function writeMarkerRegistry(markers) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(markerStorageKey(), JSON.stringify({
    version: 1,
    markers,
  }));
}

function normalizeMarkerRegistry(markers) {
  return Array.isArray(markers)
    ? markers.map(ensureMarkerRecord).filter(Boolean)
    : [];
}

function markersForSourcePath(markers, sourcePath) {
  return normalizeMarkerRegistry(markers)
    .filter((marker) => marker.sourcePath === sourcePath)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function markerRegistryEquals(left, right) {
  if (left === right) return true;
  const normalizedLeft = normalizeMarkerRegistry(left);
  const normalizedRight = normalizeMarkerRegistry(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((marker, index) => {
    const other = normalizedRight[index];
    return (
      marker.id === other.id
      && marker.status === other.status
      && marker.sourcePath === other.sourcePath
      && marker.start?.block === other.start?.block
      && marker.end?.block === other.end?.block
      && marker.start?.offset === other.start?.offset
      && marker.end?.offset === other.end?.offset
    );
  });
}

function markerId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mk_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function markerSourceFileName(sourcePath) {
  return basename(sourcePath);
}

function renderedBlocks() {
  return Array.from(document.querySelectorAll('#rendered [data-md-block]'));
}

function renderedBlockById(blockId) {
  return renderedBlocks().find((element) => element.dataset.mdBlock === String(blockId)) || null;
}

function textOffsetInBlock(block, container, offset) {
  if (!block) return 0;
  const range = document.createRange();
  range.setStart(block, 0);
  try {
    range.setEnd(container, offset);
  } catch (error) {
    return 0;
  }
  const result = range.toString().length;
  range.detach?.();
  return result;
}

function resolveBlockOffset(block, charOffset) {
  if (!block) return null;
  const targetOffset = Math.max(0, Number(charOffset) || 0);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = targetOffset;
  let lastTextNode = null;
  let current = walker.nextNode();

  while (current) {
    lastTextNode = current;
    const length = current.nodeValue?.length || 0;
    if (remaining <= length) {
      return { container: current, offset: remaining };
    }
    remaining -= length;
    current = walker.nextNode();
  }

  if (lastTextNode) {
    return { container: lastTextNode, offset: lastTextNode.nodeValue?.length || 0 };
  }
  return { container: block, offset: 0 };
}

function blockPreview(block) {
  return normalizeText(block?.innerText || block?.textContent || '').slice(0, 180);
}

function blockMetadata(block) {
  return {
    block: block?.dataset.mdBlock || null,
    tag: block?.tagName?.toLowerCase() || null,
    sourceLine: block?.dataset.mdLine || null,
    textPreview: blockPreview(block),
  };
}

function ensureMarkerRecord(marker) {
  if (!marker || typeof marker !== 'object') return null;
  const sourcePath = String(marker.sourcePath || '').trim();
  if (!sourcePath) return null;
  const sourceFileName = String(marker.sourceFileName || markerSourceFileName(sourcePath)).trim() || markerSourceFileName(sourcePath);
  const start = marker.start || {};
  const end = marker.end || {};
  return {
    version: 1,
    id: String(marker.id || markerId()),
    sourcePath,
    sourceFileName,
    selectedText: String(marker.selectedText || ''),
    start: {
      block: String(start.block || ''),
      sourceLine: start.sourceLine ? String(start.sourceLine) : null,
      offset: Number(start.offset || 0),
    },
    end: {
      block: String(end.block || ''),
      sourceLine: end.sourceLine ? String(end.sourceLine) : null,
      offset: Number(end.offset || 0),
    },
    blocks: Array.isArray(marker.blocks) ? marker.blocks.map((entry) => ({
      block: String(entry?.block || ''),
      tag: entry?.tag || null,
      sourceLine: entry?.sourceLine ? String(entry.sourceLine) : null,
      textPreview: String(entry?.textPreview || ''),
    })) : [],
    sourceContext: Array.isArray(marker.sourceContext)
      ? marker.sourceContext.map((entry) => ({
        line: Number(entry?.line || 0),
        text: String(entry?.text || ''),
      }))
      : [],
    createdAt: String(marker.createdAt || new Date().toISOString()),
    status: marker.status === 'stale' ? 'stale' : 'active',
  };
}

function restoreMarkerRange(marker) {
  const startBlock = renderedBlockById(marker?.start?.block);
  const endBlock = renderedBlockById(marker?.end?.block);
  if (!startBlock || !endBlock) return null;
  const startPoint = resolveBlockOffset(startBlock, marker.start.offset);
  const endPoint = resolveBlockOffset(endBlock, marker.end.offset);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  try {
    range.setStart(startPoint.container, startPoint.offset);
    range.setEnd(endPoint.container, endPoint.offset);
  } catch (error) {
    return null;
  }
  if (range.collapsed) return null;
  return range;
}

function collectSelectionBlocks(startBlock, endBlock) {
  const blocks = renderedBlocks();
  const startIndex = blocks.findIndex((block) => block.dataset.mdBlock === startBlock?.dataset.mdBlock);
  const endIndex = blocks.findIndex((block) => block.dataset.mdBlock === endBlock?.dataset.mdBlock);
  if (startIndex === -1 || endIndex === -1) return [];
  const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return blocks.slice(from, to + 1);
}

function sourceContextForLine(markdown, line, radius = 4) {
  return sourceForLine(markdown, line, radius);
}

function renderedContainerForNode(node) {
  const rendered = document.querySelector('#rendered');
  if (!rendered || !node) return null;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element || !rendered.contains(element)) return null;
  return rendered;
}

function selectionIsInsideRendered(selection) {
  return Boolean(
    selection
    && selection.rangeCount > 0
    && renderedContainerForNode(selection.anchorNode)
    && renderedContainerForNode(selection.focusNode)
  );
}

function selectionToMarkerDraft(selection, markdown, currentSourcePath) {
  if (!selection || selection.rangeCount === 0) {
    return { error: 'Select text inside the rendered Markdown preview first.' };
  }
  if (!selectionIsInsideRendered(selection)) {
    return { error: 'Markers can only be created from the rendered preview pane.' };
  }
  if (!currentSourcePath) {
    return { error: 'Open a Markdown file before creating a marker.' };
  }

  const selectedText = selectionPlainText(selection);
  if (!selectedText) {
    return { error: 'The current rendered selection is empty.' };
  }

  const range = selection.getRangeAt(0).cloneRange();
  const startBlock = nearestMdBlock(range.startContainer);
  const endBlock = nearestMdBlock(range.endContainer);
  if (!startBlock || !endBlock) {
    return { error: 'Could not resolve rendered blocks for the current selection.' };
  }

  const selectedBlocks = collectSelectionBlocks(startBlock, endBlock);
  const startLine = startBlock.dataset.mdLine || null;
  const endLine = endBlock.dataset.mdLine || null;
  const sourceLineForContext = startLine || endLine || null;

  return {
    marker: ensureMarkerRecord({
      id: markerId(),
      sourcePath: currentSourcePath,
      sourceFileName: markerSourceFileName(currentSourcePath),
      selectedText,
      start: {
        block: startBlock.dataset.mdBlock || '',
        sourceLine: startLine,
        offset: textOffsetInBlock(startBlock, range.startContainer, range.startOffset),
      },
      end: {
        block: endBlock.dataset.mdBlock || '',
        sourceLine: endLine,
        offset: textOffsetInBlock(endBlock, range.endContainer, range.endOffset),
      },
      blocks: selectedBlocks.map(blockMetadata),
      sourceContext: sourceLineForContext ? sourceContextForLine(markdown, sourceLineForContext, 4) : [],
      createdAt: new Date().toISOString(),
      status: 'active',
    }),
  };
}

function clearRenderedMarkerFallbacks() {
  Array.from(document.querySelectorAll(`#rendered [${MARKER_FALLBACK_ATTR}]`)).forEach((element) => {
    element.removeAttribute(MARKER_FALLBACK_ATTR);
  });
}

function renderMarkerHighlights(markers, sourcePath) {
  const rendered = document.querySelector('#rendered');
  if (!rendered) return { nextMarkers: markers, activeCount: 0, staleCount: 0 };

  clearRenderedMarkerFallbacks();

  const currentMarkers = [];
  const nextMarkers = [];
  let staleCount = 0;

  markers.forEach((marker) => {
    if (marker.sourcePath !== sourcePath) {
      nextMarkers.push(marker);
      return;
    }

    const range = restoreMarkerRange(marker);
    if (range) {
      currentMarkers.push({ marker, range });
      nextMarkers.push(marker.status === 'active' ? marker : { ...marker, status: 'active' });
      if (!supportsCssHighlights()) {
        (marker.blocks || []).forEach((entry) => {
          const block = renderedBlockById(entry.block);
          if (block) block.setAttribute(MARKER_FALLBACK_ATTR, '1');
        });
      }
      return;
    }

    staleCount += 1;
    // Preserve stale markers instead of deleting them: the old anchor still
    // matters as evidence that the source changed and the selection can no
    // longer be restored precisely.
    nextMarkers.push(marker.status === 'stale' ? marker : { ...marker, status: 'stale' });

    // CSS Highlight API is preferred; when it is unavailable, mark the
    // affected blocks so the user still gets a visible review cue.
    if (!supportsCssHighlights()) {
      (marker.blocks || []).forEach((entry) => {
        const block = renderedBlockById(entry.block);
        if (block) block.setAttribute(MARKER_FALLBACK_ATTR, '1');
      });
    }
  });

  if (supportsCssHighlights()) {
    CSS.highlights.delete(MARKER_HIGHLIGHT_NAME);
    const ranges = currentMarkers.map(({ range }) => range);
    if (ranges.length > 0) {
      CSS.highlights.set(MARKER_HIGHLIGHT_NAME, new Highlight(...ranges));
    }
  }

  return {
    nextMarkers,
    activeCount: currentMarkers.length,
    staleCount,
  };
}

function firstCurrentMarkerId(markers, sourcePath) {
  const current = markersForSourcePath(markers, sourcePath);
  return current.length ? current[current.length - 1].id : null;
}

function readPaneRatioMap() {
  // Pane ratios are review-session preferences, so keep them per source path.
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(PANE_RATIO_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed.ratios && typeof parsed.ratios === 'object' ? parsed.ratios : {};
    }
    return {};
  } catch (error) {
    console.warn('Markdown pane ratio read failed:', error);
    return {};
  }
}

function clampPaneRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PANE_RATIO;
  return Math.min(0.8, Math.max(0.2, parsed));
}

function clampPaneRatioForWidth(value, availableWidth) {
  const available = Math.max(0, Number(availableWidth) || 0);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PANE_RATIO;
  if (available < MIN_PANE_WIDTH * 2) return clampPaneRatio(parsed);

  const minRatio = Math.max(0.2, MIN_PANE_WIDTH / available);
  const maxRatio = Math.min(0.8, 1 - MIN_PANE_WIDTH / available);
  if (maxRatio < minRatio) return clampPaneRatio(parsed);
  return Math.min(maxRatio, Math.max(minRatio, parsed));
}

function readPaneRatio(sourcePath = '') {
  const ratios = readPaneRatioMap();
  // The default review layout gives the rendered preview more room than the
  // source editor. User adjustments still win once a per-document ratio exists.
  return clampPaneRatio(ratios[sourcePath] ?? DEFAULT_PANE_RATIO);
}

function writePaneRatio(sourcePath, value) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const ratios = readPaneRatioMap();
  const nextRatios = {
    ...ratios,
    [sourcePath]: clampPaneRatio(value),
  };
  window.localStorage.setItem(PANE_RATIO_STORAGE_KEY, JSON.stringify({
    version: 1,
    ratios: nextRatios,
  }));
}

function getCodeMirrorEditor() {
  const root = document.querySelector('.editor-pane .CodeMirror');
  return root?.CodeMirror || null;
}

function App() {
  const [markdown, setMarkdown] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [filePathInput, setFilePathInput] = useState('');
  const [gotoLineInput, setGotoLineInput] = useState('');
  const [cursorLine, setCursorLine] = useState(1);
  const [lineCount, setLineCount] = useState(1);
  const [markerRegistry, setMarkerRegistry] = useState(() => readMarkerRegistry());
  const [autoReload, setAutoReload] = useState(true);
  const [hotReloadAvailable, setHotReloadAvailable] = useState(false);
  const [lastHotReloadAt, setLastHotReloadAt] = useState(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [paneRatio, setPaneRatio] = useState(DEFAULT_PANE_RATIO);
  const [readOnly, setReadOnly] = useState(false);
  const [rootPath, setRootPath] = useState('');
  const [allowExt, setAllowExt] = useState('');
  const [status, setStatus] = useState('loading...');
  const [renderErrors, setRenderErrors] = useState([]);
  const sourcePathRef = useRef('');
  const markerRegistryRef = useRef(markerRegistry);
  const paneRatioRef = useRef(paneRatio);
  const autoReloadRef = useRef(true);
  const syncScrollRef = useRef(true);
  const mainRef = useRef(null);
  const paneDragRef = useRef(null);

  const plugins = useMemo(() => [gfm(), math(), mermaid()], []);
  const sourceFileName = basename(sourcePath);
  const currentMarkers = useMemo(() => markersForSourcePath(markerRegistry, sourcePath), [markerRegistry, sourcePath]);

  async function loadMarkdown(nextPath = sourcePath) {
    // The API response headers are authoritative for path/root/read-only state;
    // a visible URL can still point at a file the server rejected.
    setStatus('loading...');
    const requestedPath = String(nextPath || '').trim();
    const url = requestedPath
      ? `/api/markdown?path=${encodeURIComponent(requestedPath)}`
      : '/api/markdown';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const nextMarkdown = await response.text();
    const nextSourcePath = decodeURIComponent(response.headers.get('x-source-path') || '');
    setMarkdown(nextMarkdown);
    setSourcePath(nextSourcePath);
    setFilePathInput(nextSourcePath);
    setPaneRatio(readPaneRatio(nextSourcePath));
    setHotReloadAvailable(response.headers.get('x-watch-enabled') === '1');
    setReadOnly(response.headers.get('x-read-only') === '1');
    setRootPath(decodeURIComponent(response.headers.get('x-preview-root') || ''));
    setAllowExt(response.headers.get('x-allow-ext') || '');
    setStatus(`loaded: ${nextMarkdown.length.toLocaleString()} chars`);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('path', nextSourcePath);
    window.history.replaceState(null, '', nextUrl);
  }

  async function saveMarkdown() {
    if (readOnly) {
      setStatus('read-only: save disabled');
      return;
    }
    setStatus('saving...');
    const response = await fetch(`/api/save?path=${encodeURIComponent(sourcePath)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      body: markdown,
    });
    if (!response.ok) throw new Error(await response.text());
    setStatus(`saved: ${markdown.length.toLocaleString()} chars`);
  }

  async function openPathFromInput(event) {
    event.preventDefault();
    await loadMarkdown(filePathInput);
  }

  function syncEditorLineStats() {
    const editor = getCodeMirrorEditor();
    if (!editor) return { cursorLine: 1, lineCount: 1 };
    const nextCursorLine = (editor.getCursor()?.line ?? 0) + 1;
    const nextLineCount = Math.max(1, editor.lineCount?.() ?? 1);
    setCursorLine(nextCursorLine);
    setLineCount(nextLineCount);
    return { cursorLine: nextCursorLine, lineCount: nextLineCount };
  }

  function gotoLine(rawLine, { focus = true } = {}) {
    const editor = getCodeMirrorEditor();
    if (!editor) {
      const error = 'Editor is not ready yet.';
      setStatus(error);
      return { ok: false, error };
    }
    const maxLine = Math.max(1, editor.lineCount?.() ?? 1);
    const line = Math.min(maxLine, Math.max(1, Number.parseInt(String(rawLine || ''), 10) || 1));
    editor.setCursor({ line: line - 1, ch: 0 });
    editor.scrollIntoView({ line: Math.max(0, line - 1), ch: 0 }, 120);
    if (focus) editor.focus();
    setGotoLineInput(String(line));
    setCursorLine(line);
    setLineCount(maxLine);
    setStatus(`jumped to line ${line}`);
    return { ok: true, line, lineCount: maxLine };
  }

  function handleGotoLineSubmit(event) {
    event.preventDefault();
    gotoLine(gotoLineInput);
  }

  function commitMarkerRegistry(nextRegistry) {
    const normalized = normalizeMarkerRegistry(nextRegistry);
    markerRegistryRef.current = normalized;
    setMarkerRegistry(normalized);
    writeMarkerRegistry(normalized);
    return normalized;
  }

  function markCurrentSelection() {
    const selection = window.getSelection();
    const draft = selectionToMarkerDraft(selection, markdown, sourcePathRef.current);
    if (draft.error) {
      setStatus(draft.error);
      return { ok: false, error: draft.error };
    }

    const nextMarker = draft.marker;
    const nextRegistry = commitMarkerRegistry([...markerRegistryRef.current, nextMarker]);
    setStatus(`marker added: ${nextMarker.selectedText.slice(0, 80) || nextMarker.id}`);
    return { ok: true, marker: nextMarker, markerCount: nextRegistry.length };
  }

  function clearMarkerById(markerIdToRemove) {
    const id = String(markerIdToRemove || '').trim();
    if (!id) return { ok: false, error: 'Marker id is required.' };
    const nextRegistry = commitMarkerRegistry(markerRegistryRef.current.filter((marker) => marker.id !== id));
    setStatus(`marker removed: ${id}`);
    return { ok: true, removed: id, markerCount: nextRegistry.length };
  }

  function clearMarkersForDocument(targetPath = sourcePathRef.current) {
    const path = String(targetPath || '').trim();
    const previousCount = markerRegistryRef.current.length;
    const nextRegistry = commitMarkerRegistry(markerRegistryRef.current.filter((marker) => marker.sourcePath !== path));
    setStatus(path ? `markers cleared for document: ${markerSourceFileName(path)}` : 'markers cleared');
    return { ok: true, removedCount: previousCount - nextRegistry.length };
  }

  function refreshMarkersFromRegistry() {
    const nextRegistry = normalizeMarkerRegistry(readMarkerRegistry());
    markerRegistryRef.current = nextRegistry;
    setMarkerRegistry(nextRegistry);
    return nextRegistry;
  }

  function currentPaneLayoutRatio() {
    return paneRatioRef.current;
  }

  function applyPaneLayout(nextRatio = paneRatioRef.current) {
    const main = mainRef.current;
    if (!main) return;
    const availableWidth = Math.max(0, main.clientWidth - SPLIT_HANDLE_WIDTH);
    if (availableWidth <= 0) return;
    const ratio = clampPaneRatioForWidth(nextRatio, availableWidth);
    paneRatioRef.current = ratio;
    let leftWidth = Math.round(availableWidth * ratio);
    if (availableWidth >= MIN_PANE_WIDTH * 2) {
      leftWidth = Math.min(availableWidth - MIN_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, leftWidth));
    }
    const rightWidth = Math.max(0, availableWidth - leftWidth);
    main.style.gridTemplateColumns = `${leftWidth}px ${SPLIT_HANDLE_WIDTH}px ${rightWidth}px`;
  }

  function updatePaneRatio(nextRatio) {
    const main = mainRef.current;
    const availableWidth = main ? Math.max(1, main.clientWidth - SPLIT_HANDLE_WIDTH) : MIN_PANE_WIDTH * 2;
    const ratio = clampPaneRatioForWidth(nextRatio, availableWidth);
    paneRatioRef.current = ratio;
    setPaneRatio(ratio);
    if (sourcePathRef.current) {
      writePaneRatio(sourcePathRef.current, ratio);
    }
    applyPaneLayout(ratio);
    return ratio;
  }

  function handlePaneKeyDown(event) {
    const step = event.shiftKey ? PANE_KEYBOARD_STEP * 2.5 : PANE_KEYBOARD_STEP;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      updatePaneRatio(paneRatioRef.current - step);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      updatePaneRatio(paneRatioRef.current + step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      updatePaneRatio(0.2);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      updatePaneRatio(0.8);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      updatePaneRatio(DEFAULT_PANE_RATIO);
    }
  }

  function startPaneDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const main = mainRef.current;
    if (!main) return;

    const beginDrag = (clientX) => {
      const rect = main.getBoundingClientRect();
      const availableWidth = Math.max(1, rect.width - SPLIT_HANDLE_WIDTH);
      const offset = clientX - rect.left - SPLIT_HANDLE_WIDTH / 2;
      updatePaneRatio(clampPaneRatioForWidth(offset / availableWidth, availableWidth));
    };

    paneDragRef.current = { beginDrag };
    document.body.style.cursor = 'col-resize';

    const onMove = (moveEvent) => {
      if (!paneDragRef.current) return;
      beginDrag(moveEvent.clientX);
    };
    const endDrag = () => {
      paneDragRef.current = null;
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', endDrag, { once: true });
    document.addEventListener('pointercancel', endDrag, { once: true });
    beginDrag(event.clientX);
  }

  function rerenderCurrentMarkers() {
    const nextRegistry = refreshMarkersFromRegistry();
    const rendered = renderMarkerHighlights(nextRegistry, sourcePathRef.current);
    if (!markerRegistryEquals(rendered.nextMarkers, nextRegistry)) {
      markerRegistryRef.current = rendered.nextMarkers;
      setMarkerRegistry(rendered.nextMarkers);
      writeMarkerRegistry(rendered.nextMarkers);
    }
    setStatus(`markers refreshed: ${rendered.activeCount} active / ${rendered.staleCount} stale`);
    return {
      ok: true,
      markerCount: rendered.activeCount,
      staleMarkerCount: rendered.staleCount,
    };
  }

  useEffect(() => {
    loadMarkdown(pathFromLocation()).catch((error) => {
      setStatus('error');
      setRenderErrors((prev) => [...prev, String(error?.stack || error)]);
    });
  }, []);

  useEffect(() => {
    sourcePathRef.current = sourcePath;
    document.title = sourcePath ? `${basename(sourcePath)} - Markdown Preview Bridge` : 'Markdown Preview Bridge';
  }, [sourcePath]);

  useEffect(() => {
    autoReloadRef.current = autoReload;
  }, [autoReload]);

  useEffect(() => {
    syncScrollRef.current = syncScroll;
  }, [syncScroll]);

  useEffect(() => {
    markerRegistryRef.current = markerRegistry;
  }, [markerRegistry]);

  useEffect(() => {
    paneRatioRef.current = paneRatio;
    // Keep the review layout stable across reloads and tab switches.
    if (sourcePath) writePaneRatio(sourcePath, paneRatio);
    applyPaneLayout(paneRatio);
  }, [paneRatio, sourcePath]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== MARKER_STORAGE_KEY && event.key !== PANE_RATIO_STORAGE_KEY) return;
      if (event.key === MARKER_STORAGE_KEY) {
        const nextMarkers = refreshMarkersFromRegistry();
        const rendered = renderMarkerHighlights(nextMarkers, sourcePathRef.current);
        if (!markerRegistryEquals(rendered.nextMarkers, nextMarkers)) {
          markerRegistryRef.current = rendered.nextMarkers;
          setMarkerRegistry(rendered.nextMarkers);
          writeMarkerRegistry(rendered.nextMarkers);
        }
      }
      if (event.key === PANE_RATIO_STORAGE_KEY) {
        setPaneRatio(readPaneRatio(sourcePathRef.current));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!import.meta.hot) return undefined;
    const onFileChanged = (payload) => {
      // The server watches one active file at a time. Keep the tab-side check so
      // a tab never reloads because another Markdown file changed.
      if (!autoReloadRef.current) return;
      if (payload?.sourcePath !== sourcePathRef.current) return;
      setLastHotReloadAt(new Date(payload?.changedAt || Date.now()).toISOString());
      setStatus('file changed; reloading...');
      loadMarkdown(sourcePathRef.current).catch((error) => {
        setStatus('hot reload error');
        setRenderErrors((prev) => [...prev, String(error?.stack || error)]);
      });
    };
    import.meta.hot.on('markdown-preview:file-changed', onFileChanged);
    return () => {
      import.meta.hot.off?.('markdown-preview:file-changed', onFileChanged);
    };
  }, []);

  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;

    function setup() {
      const editorScroll = document.querySelector('.editor-pane .CodeMirror-scroll');
      const viewerScroll = document.querySelector('.viewer-pane');
      if (!editorScroll || !viewerScroll) return false;

      let locked = false;
      const scrollRange = (element) => Math.max(1, element.scrollHeight - element.clientHeight);
      const sync = (source, target) => {
        // Source and rendered content have different heights. Ratio sync is a
        // review navigation aid, not a pixel-accurate correspondence.
        if (!syncScrollRef.current || locked) return;
        locked = true;
        target.scrollTop = (source.scrollTop / scrollRange(source)) * scrollRange(target);
        window.setTimeout(() => {
          locked = false;
        }, 0);
      };
      const onEditorScroll = () => sync(editorScroll, viewerScroll);
      const onViewerScroll = () => sync(viewerScroll, editorScroll);
      editorScroll.addEventListener('scroll', onEditorScroll, { passive: true });
      viewerScroll.addEventListener('scroll', onViewerScroll, { passive: true });
      cleanup = () => {
        editorScroll.removeEventListener('scroll', onEditorScroll);
        viewerScroll.removeEventListener('scroll', onViewerScroll);
      };
      return true;
    }

    if (setup()) return () => cleanup();
    const id = window.setInterval(() => {
      if (cancelled || setup()) {
        window.clearInterval(id);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      cleanup();
    };
  }, [markdown]);

  useEffect(() => {
    let cancelled = false;
    let detach = () => {};

    function attach() {
      const editor = getCodeMirrorEditor();
      if (!editor) return false;
      const update = () => syncEditorLineStats();
      update();
      editor.on('cursorActivity', update);
      editor.on('changes', update);
      detach = () => {
        editor.off('cursorActivity', update);
        editor.off('changes', update);
      };
      return true;
    }

    if (attach()) return () => detach();
    const id = window.setInterval(() => {
      if (cancelled || attach()) {
        window.clearInterval(id);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      detach();
    };
  }, [sourcePath]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      // Rendering and KaTeX/Mermaid work can settle after React commits, so
      // annotate shortly after the Viewer updates instead of during render.
      annotateRenderedDom(markdown, sourcePath);
      const rendered = renderMarkerHighlights(markerRegistryRef.current, sourcePath);
      if (!markerRegistryEquals(rendered.nextMarkers, markerRegistryRef.current)) {
        markerRegistryRef.current = rendered.nextMarkers;
        setMarkerRegistry(rendered.nextMarkers);
        writeMarkerRegistry(rendered.nextMarkers);
      }
      applyPaneLayout(paneRatioRef.current);
      void (async () => {
        await renderMermaidInRenderedDom((error) => {
          setRenderErrors((prev) => [...prev, `Mermaid render error: ${String(error?.message || error)}`]);
        });
        await renderMathInRenderedDom();
      })();
    }, 120);
    return () => window.clearTimeout(id);
  }, [markdown, sourcePath, markerRegistry]);

  useEffect(() => {
    const onResize = () => applyPaneLayout(paneRatioRef.current);
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const main = mainRef.current;
    if (!main) return undefined;
    const observer = new ResizeObserver(onResize);
    observer.observe(main);
    window.addEventListener('resize', onResize);
    onResize();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    // Keep Playwright traffic small and stable. Agents should call this bridge
    // instead of asking the CLI for full DOM snapshots on large Markdown files.
    window.__mdPreviewBridge = {
      diagnostics() {
        const rendered = document.querySelector('#rendered');
        const allMarkers = normalizeMarkerRegistry(markerRegistryRef.current);
        const currentDocMarkers = markersForSourcePath(allMarkers, sourcePathRef.current);
        const editor = getCodeMirrorEditor();
        return {
          sourcePath,
          sourceFileName,
          pageTitle: document.title,
          status,
          hasEditor: true,
          autoReload,
          hotReloadAvailable,
          lastHotReloadAt,
          syncScroll,
          readOnly,
          rootPath,
          allowExt,
          markdownLength: markdown.length,
          renderedTextLength: rendered?.innerText.length || 0,
          headingCount: rendered?.querySelectorAll('h1,h2,h3,h4,h5,h6').length || 0,
          codeBlockCount: rendered?.querySelectorAll('pre, code').length || 0,
          tableCount: rendered?.querySelectorAll('table').length || 0,
          imageCount: rendered?.querySelectorAll('img').length || 0,
          mathCount: rendered?.querySelectorAll('.katex, .katex-display').length || 0,
          mermaidCount: rendered?.querySelectorAll('.bytemd-mermaid, .mermaid, svg[id*="mermaid"]').length || 0,
          markerCount: currentDocMarkers.length,
          allMarkerCount: allMarkers.length,
          staleMarkerCount: allMarkers.filter((marker) => marker.status === 'stale').length,
          paneRatio: currentPaneLayoutRatio(),
          cursorLine: editor ? (editor.getCursor()?.line ?? 0) + 1 : cursorLine,
          lineCount: editor ? Math.max(1, editor.lineCount?.() ?? 1) : lineCount,
          renderErrors,
        };
      },
      selectionDetails() {
        const selection = window.getSelection?.();
        return {
          rawText: normalizeText(selection?.toString() || ''),
          plainText: selectionPlainText(selection),
          inRenderedViewer: selectionIsInsideRendered(selection),
          containsMath: Boolean(selection?.rangeCount && selection.getRangeAt(0).cloneContents()?.querySelector?.('.katex-mathml')),
        };
      },
      headings() {
        return Array.from(document.querySelectorAll('#rendered h1,#rendered h2,#rendered h3,#rendered h4'))
          .slice(0, 120)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: normalizeText(element.textContent),
            sourcePath,
            sourceLine: element.dataset.mdLine || null,
            block: element.dataset.mdBlock || null,
          }));
      },
      findText(query) {
        const needle = normalizeText(query).toLowerCase();
        if (!needle) return [];
        return Array.from(document.querySelectorAll('#rendered [data-md-block]'))
          .filter((element) => normalizeText(element.innerText || element.textContent).toLowerCase().includes(needle))
          .slice(0, 40)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: normalizeText(element.innerText || element.textContent).slice(0, 300),
            sourcePath,
            sourceLine: element.dataset.mdLine || null,
            block: element.dataset.mdBlock || null,
          }));
      },
      getSelectionContext() {
        const selection = window.getSelection();
        const text = normalizeText(selection?.toString() || '');
        const anchor = selection?.anchorNode;
        const block = nearestMdBlock(anchor);
        return {
          text,
          sourcePath,
          inRenderedViewer: Boolean(block),
          sourceLine: block?.dataset.mdLine || null,
          block: block?.dataset.mdBlock || null,
          blockText: normalizeText(block?.innerText || block?.textContent || '').slice(0, 500),
          sourceContext: block?.dataset.mdLine ? sourceForLine(markdown, block.dataset.mdLine, 4) : [],
        };
      },
      addMarkerFromSelection() {
        const result = markCurrentSelection();
        if (!result.ok) {
          return result;
        }
        return result.marker;
      },
      markers() {
        return markersForSourcePath(markerRegistryRef.current, sourcePathRef.current);
      },
      allMarkers() {
        // Expose every marker so another tab can inspect review state while
        // this tab is focused on a different Markdown file.
        return normalizeMarkerRegistry(markerRegistryRef.current);
      },
      clearMarker(markerId) {
        return clearMarkerById(markerId);
      },
      clearMarkersForDocument(path = sourcePathRef.current) {
        return clearMarkersForDocument(path);
      },
      jumpToMarker(markerId) {
        const id = String(markerId || '').trim();
        if (!id) return { ok: false, error: 'Marker id is required.' };
        const marker = normalizeMarkerRegistry(markerRegistryRef.current).find((entry) => entry.id === id);
        if (!marker) {
          return { ok: false, error: `Marker not found: ${id}` };
        }
        const range = restoreMarkerRange(marker);
        if (range) {
          const startBlock = nearestMdBlock(range.startContainer);
          startBlock?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return { ok: true, id, status: marker.status };
        }
        const fallbackBlock = renderedBlockById(marker.start?.block);
        fallbackBlock?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { ok: false, id, status: 'stale' };
      },
      rerenderMarkers() {
        return rerenderCurrentMarkers();
      },
      sourceForLine(line, radius = 4) {
        return sourceForLine(markdown, line, radius);
      },
      getMarkdown() {
        return markdown;
      },
      gotoLine(line, options = {}) {
        return gotoLine(line, options);
      },
      reloadMarkdown: loadMarkdown,
    };
  }, [allowExt, autoReload, cursorLine, hotReloadAvailable, lastHotReloadAt, lineCount, markdown, paneRatio, readOnly, renderErrors, rootPath, sourcePath, status, syncScroll, markerRegistry, currentMarkers]);

  return (
    <div className="app-shell">
      <header>
        <div>
          <h1>Markdown Preview Bridge</h1>
          <div className="source-file" tabIndex={0} aria-label={sourcePath || 'No Markdown file selected'}>
            <span className="source-file-name">{sourcePath ? sourceFileName : '(no file)'}</span>
            {sourcePath ? <div className="source-path-overlay">{sourcePath}</div> : null}
          </div>
        </div>
        <form className="file-picker" onSubmit={openPathFromInput}>
          <label htmlFor="markdown-file-path">File path</label>
          <input
            id="markdown-file-path"
            value={filePathInput}
            onChange={(event) => setFilePathInput(event.target.value)}
            placeholder="/absolute/path/to/document.md"
          />
          <button type="submit">Open</button>
        </form>
        <div className="actions">
          <form className="line-jump" onSubmit={handleGotoLineSubmit}>
            <label htmlFor="markdown-goto-line">Line</label>
            <input
              id="markdown-goto-line"
              inputMode="numeric"
              pattern="[0-9]*"
              value={gotoLineInput}
              onChange={(event) => setGotoLineInput(event.target.value)}
              placeholder={String(cursorLine)}
              title={`Jump to a source line (1-${lineCount})`}
            />
            <button type="submit">Go</button>
            <span className="line-jump-meta">
              {cursorLine}/{lineCount}
            </span>
          </form>
          <span className="status">{status}</span>
          {readOnly ? <span className="status read-only-badge">read-only</span> : null}
          <label className="auto-reload">
            <input
              type="checkbox"
              checked={autoReload}
              onChange={(event) => setAutoReload(event.target.checked)}
            />
            Auto reload
          </label>
          <label className="auto-reload">
            <input
              type="checkbox"
              checked={syncScroll}
              onChange={(event) => setSyncScroll(event.target.checked)}
            />
            Sync scroll
          </label>
          <button onClick={() => loadMarkdown(sourcePath)}>Reload</button>
          <button onClick={() => saveMarkdown()} disabled={readOnly}>Save</button>
        </div>
      </header>
      <section className="marker-strip" aria-label="Marker controls and summary">
        <div className="marker-toolbar">
          <button type="button" onClick={markCurrentSelection}>Mark selection</button>
          <button
            type="button"
            onClick={() => {
              const id = firstCurrentMarkerId(markerRegistryRef.current, sourcePathRef.current);
              if (!id) {
                setStatus('No marker exists for the current document.');
                return;
              }
              clearMarkerById(id);
            }}
            disabled={currentMarkers.length === 0}
          >
            Clear marker
          </button>
          <button
            type="button"
            onClick={() => clearMarkersForDocument()}
            disabled={currentMarkers.length === 0}
          >
            Clear doc markers
          </button>
          <span className="marker-count">Markers: {currentMarkers.length}</span>
          <span className="marker-count">All: {markerRegistry.length}</span>
        </div>
        {currentMarkers.length > 0 ? (
          <details className="marker-panel" open>
            <summary>Current document markers</summary>
            <ul className="marker-list">
              {currentMarkers.map((marker) => (
                <li key={marker.id} className={`marker-item marker-item--${marker.status}`}>
                  <div className="marker-item-main">
                    <div className="marker-item-text">{marker.selectedText || '(empty selection)'}</div>
                    <div className="marker-item-meta">
                      {marker.status}
                      {' · '}
                      {marker.start?.sourceLine ? `line ${marker.start.sourceLine}` : 'line ?'}
                      {' · '}
                      {marker.sourceFileName}
                    </div>
                  </div>
                  <div className="marker-item-actions">
                    <button type="button" onClick={() => window.__mdPreviewBridge.jumpToMarker(marker.id)}>Jump</button>
                    <button type="button" onClick={() => clearMarkerById(marker.id)}>Clear</button>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      <main ref={mainRef} className="split-layout">
        <section className="pane editor-pane">
          <Editor
            value={markdown}
            plugins={plugins}
            onChange={setMarkdown}
            mode="tab"
            placeholder="Edit Markdown source here"
            editorConfig={{
              lineNumbers: true,
              lineWrapping: true,
            }}
          />
        </section>
        <div
          className="split-handle"
          role="separator"
          aria-label="Resize source and preview panes"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(paneRatio * 100)}
          aria-valuetext={`Source ${Math.round(paneRatio * 100)}%, preview ${Math.round((1 - paneRatio) * 100)}%`}
          title="Drag to resize panes. Double-click or press Enter to reset to the 2:3 review layout."
          tabIndex={0}
          onPointerDown={startPaneDrag}
          onKeyDown={handlePaneKeyDown}
          onDoubleClick={() => updatePaneRatio(DEFAULT_PANE_RATIO)}
        >
          <span className="split-handle-grip" aria-hidden="true" />
        </div>
        <section className="pane viewer-pane">
          <article id="rendered" className="markdown-body">
            <Viewer value={markdown} plugins={plugins} />
          </article>
        </section>
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Markdown Preview Bridge root container not found');
}
const root = container.__mdPreviewBridgeRoot || createRoot(container);
container.__mdPreviewBridgeRoot = root;
root.render(<App />);
