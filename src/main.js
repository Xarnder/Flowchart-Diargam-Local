import mermaid from 'mermaid';
import {
  applyDistinctEdgeStyles,
  BLOCK_LAYOUTS,
  EDGE_LAYOUTS,
  enhanceFlowchartSource,
  isFlowchartDiagram,
  resolveLayoutOptions,
} from './edgeStyling.js';
import { setupNodePositioning, teardownNodePositioning } from './nodePositioning.js';
import './style.css';

const MAX_CHARS = 50_000;
const DEBOUNCE_MS = 350;
const STORAGE_KEY = 'mermaid-studio-source';
const THEME_STORAGE_KEY = 'mermaid-studio-export-theme';
const EDGE_LAYOUT_STORAGE_KEY = 'mermaid-studio-edge-layout';
const BLOCK_LAYOUT_STORAGE_KEY = 'mermaid-studio-block-layout';
const MANUAL_POSITIONS_STORAGE_KEY = 'mermaid-studio-manual-positions';
const SPLIT_RATIO_STORAGE_KEY = 'mermaid-studio-split-ratio';
const SOURCE_COLLAPSED_STORAGE_KEY = 'mermaid-studio-source-collapsed';
const DEFAULT_THEME = 'dark';
const DEFAULT_EDGE_LAYOUT = EDGE_LAYOUTS.curvy;
const DEFAULT_BLOCK_LAYOUT = BLOCK_LAYOUTS.original;

const EXPORT_THEMES = {
  light: { label: 'Light', mermaid: 'default', background: '#ffffff' },
  dark: { label: 'Dark', mermaid: 'dark', background: '#1e1e2e' },
  transparent: { label: 'Transparent', mermaid: 'dark', background: null },
};

const DEFAULT_SOURCE = `flowchart TB
    subgraph Current["Current MVP"]
        U["User\\nrole + school"]
        S["Student\\nparent FK"]
        U --> S
    end

    subgraph Proposed["Proposed"]
        I["Identity"]
        R["Relationship"]
        E["Entitlement"]
        I --> R --> E
    end

    Current -.-> Proposed`;

const EXAMPLES = {
  'Flowchart (default)': DEFAULT_SOURCE,
  'Sequence diagram': `sequenceDiagram
    participant P as Parent
    participant API as NestJS API
    participant S as Stripe
    participant E as EntitlementModule

    P->>API: Purchase video
    API->>S: Checkout session
    S->>P: Payment UI
    P->>S: Pay
    S->>API: Webhook
    API->>E: Grant entitlement
    P->>API: Request playback
    API->>P: Signed URL`,
  'ER diagram': `erDiagram
    PersonIdentity ||--o{ Relationship : has
    ChildIdentity ||--o{ Relationship : has
    PersonIdentity ||--o{ Entitlement : granted
    VideoJob ||--o{ Entitlement : target

    PersonIdentity {
        string sylId PK
        string displayName
        string email
    }

    Entitlement {
        string sylId PK
        string status
        datetime grantedAt
    }`,
  'Gantt chart': `gantt
    title Migration phases
    dateFormat YYYY-MM-DD
    section Foundation
    Architecture sign-off     :a1, 2026-06-01, 14d
    Additive schema           :a2, after a1, 21d
    section Cutover
    Dual-write                :b1, after a2, 28d
    Dual-read                 :b2, after b1, 21d
    Legacy removal            :b3, after b2, 14d`,
};

let renderCounter = 0;
let debounceTimer = null;
let lastSource = '';
let currentExportTheme = DEFAULT_THEME;
let currentEdgeLayout = DEFAULT_EDGE_LAYOUT;
let currentBlockLayout = DEFAULT_BLOCK_LAYOUT;

function getRenderLayoutOptions(els) {
  return resolveLayoutOptions({
    edgeLayout: els.edgeLayout?.value ?? DEFAULT_EDGE_LAYOUT,
    blockLayout: els.blockLayout?.value ?? DEFAULT_BLOCK_LAYOUT,
  });
}

/** Native SVG text labels — HTML foreignObject labels break in saved SVG / PNG export. */
function initMermaid(themeName, layoutOptions) {
  const layout = resolveLayoutOptions(layoutOptions);
  const useCurvyCurve = layout.edgeLayout === EDGE_LAYOUTS.curvy;
  const useSpacedBlocks = layout.blockLayout === BLOCK_LAYOUTS.spaced;

  mermaid.initialize({
    startOnLoad: false,
    maxTextSize: MAX_CHARS,
    theme: themeName,
    securityLevel: 'strict',
    htmlLabels: false,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    flowchart: {
      htmlLabels: false,
      curve: useCurvyCurve ? 'basis' : 'linear',
      ...(useSpacedBlocks ? { padding: 16, nodeSpacing: 50, rankSpacing: 50 } : {}),
    },
    sequence: {
      actorFontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      noteFontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      messageFontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    },
  });
}

initMermaid(EXPORT_THEMES[DEFAULT_THEME].mermaid);

function buildUi() {
  const app = document.getElementById('app');
  const themeOptions = Object.entries(EXPORT_THEMES)
    .map(([key, { label }]) => {
      const selected = key === DEFAULT_THEME ? ' selected' : '';
      return `<option value="${key}"${selected}>${label}</option>`;
    })
    .join('');

  app.innerHTML = `
    <header>
      <h1>Mermaid Studio <span>— local preview & export</span></h1>
      <div class="header-actions">
        <span class="badge">100% on-device · no account · free</span>
        <button type="button" id="btn-clear" title="Clear editor">Clear</button>
        <button type="button" id="btn-copy-svg" disabled>Copy SVG</button>
        <button type="button" id="btn-export-svg" disabled>Save SVG</button>
        <button type="button" class="primary" id="btn-export-png" disabled>Save PNG</button>
      </div>
    </header>

    <div class="toolbar">
      <label class="field-label" for="example-select">Example</label>
      <select id="example-select">
        <option value="">— load example —</option>
        ${Object.keys(EXAMPLES)
          .map((name) => `<option value="${name}">${name}</option>`)
          .join('')}
      </select>

      <label class="field-label" for="export-theme">Export theme</label>
      <select id="export-theme" title="Light and dark bake a background into PNG/SVG exports">
        ${themeOptions}
      </select>

      <label class="field-label" for="edge-layout">Edge layout</label>
      <select id="edge-layout" title="Curved uses smooth lines; Straight uses classic orthogonal routing">
        <option value="curvy" selected>Curved</option>
        <option value="straight">Straight</option>
      </select>

      <label class="field-label" for="block-layout">Block layout</label>
      <select id="block-layout" title="Original keeps classic Mermaid node positions; Spaced uses wider layout">
        <option value="original" selected>Original</option>
        <option value="spaced">Spaced</option>
      </select>

      <label class="checkbox-label" for="manual-positions" title="Drag blocks or set X/Y coordinates; arrows follow automatically">
        <input type="checkbox" id="manual-positions" />
        Position blocks
      </label>

      <label class="field-label" for="scale-input">PNG scale</label>
      <input type="number" id="scale-input" min="1" max="4" step="1" value="2" title="Higher = sharper PNG" />

      <button type="button" id="btn-render">Render now</button>
    </div>

    <div class="main" id="main-split">
      <section class="panel panel-source" id="panel-source">
        <div class="panel-header">
          <span>Source</span>
          <div class="panel-header-actions">
            <span id="char-count" class="char-count ok">0 / ${MAX_CHARS.toLocaleString()}</span>
            <button type="button" id="btn-collapse-source" class="panel-btn" title="Hide source panel">Hide source</button>
          </div>
        </div>
        <textarea id="editor" spellcheck="false" placeholder="Paste Mermaid code here…"></textarea>
      </section>

      <div class="split-handle" id="split-handle" role="separator" aria-orientation="vertical" aria-label="Resize source and preview panels" tabindex="0"></div>

      <section class="panel panel-preview" id="panel-preview">
        <div class="panel-header">
          <div class="panel-header-leading">
            <button type="button" id="btn-show-source" class="panel-btn hidden" title="Show source panel">Show source</button>
            <span>Preview</span>
          </div>
          <span id="preview-status"><span class="status-dot"></span>Waiting</span>
        </div>
        <div id="preview-wrap" data-theme="${DEFAULT_THEME}">
          <div class="preview-scrollport">
            <div id="preview-canvas" class="preview-canvas">
              <p class="preview-placeholder">Live preview appears here as you type.</p>
            </div>
          </div>
        </div>
        <div id="position-panel" class="position-panel hidden">
          <div class="position-panel-header">
            <span>Block positions</span>
            <span class="position-hint">Drag blocks in preview or edit X/Y</span>
            <button type="button" id="btn-reset-positions">Reset positions</button>
          </div>
          <div class="position-rows"></div>
        </div>
      </section>
    </div>

    <footer>
      <span>Processing runs entirely in your browser. Nothing is uploaded.</span>
      <span>Mermaid limit: ${MAX_CHARS.toLocaleString()} characters per diagram</span>
    </footer>
  `;
}

function getElements() {
  return {
    editor: document.getElementById('editor'),
    previewWrap: document.getElementById('preview-wrap'),
    previewCanvas: document.getElementById('preview-canvas'),
    mainSplit: document.getElementById('main-split'),
    splitHandle: document.getElementById('split-handle'),
    btnCollapseSource: document.getElementById('btn-collapse-source'),
    btnShowSource: document.getElementById('btn-show-source'),
    charCount: document.getElementById('char-count'),
    previewStatus: document.getElementById('preview-status'),
    btnExportPng: document.getElementById('btn-export-png'),
    btnExportSvg: document.getElementById('btn-export-svg'),
    btnCopySvg: document.getElementById('btn-copy-svg'),
    btnClear: document.getElementById('btn-clear'),
    btnRender: document.getElementById('btn-render'),
    exampleSelect: document.getElementById('example-select'),
    exportTheme: document.getElementById('export-theme'),
    edgeLayout: document.getElementById('edge-layout'),
    blockLayout: document.getElementById('block-layout'),
    manualPositions: document.getElementById('manual-positions'),
    positionPanel: document.getElementById('position-panel'),
    btnResetPositions: document.getElementById('btn-reset-positions'),
    scaleInput: document.getElementById('scale-input'),
  };
}

function setExportButtonsEnabled(els, enabled) {
  els.btnExportPng.disabled = !enabled;
  els.btnExportSvg.disabled = !enabled;
  els.btnCopySvg.disabled = !enabled;
}

function updateCharCount(el, count) {
  el.textContent = `${count.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
  el.classList.remove('ok', 'warn', 'error');
  if (count > MAX_CHARS) {
    el.classList.add('error');
  } else if (count > MAX_CHARS * 0.9) {
    el.classList.add('warn');
  } else {
    el.classList.add('ok');
  }
}

function setStatus(el, state, message) {
  const dotClass = state === 'ok' ? 'live' : state === 'error' ? 'error' : '';
  el.innerHTML = `<span class="status-dot ${dotClass}"></span>${message}`;
}

function showPreviewError(canvas, message) {
  canvas.innerHTML = `<div class="preview-error">${escapeHtml(message)}</div>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getExportThemeConfig(themeKey) {
  return EXPORT_THEMES[themeKey] ?? EXPORT_THEMES[DEFAULT_THEME];
}

function applyPreviewSurface(wrap, themeKey) {
  wrap.dataset.theme = themeKey;
}

function mountNodePositioning(text, els, layoutOptions) {
  const svg = els.previewCanvas.querySelector('svg');
  const enabled = Boolean(els.manualPositions?.checked) && isFlowchartDiagram(text);

  setupNodePositioning({
    previewWrap: els.previewWrap,
    svg,
    diagramKey: text,
    edgeLayout: layoutOptions.edgeLayout,
    enabled,
    panelEl: els.positionPanel,
    resetBtn: els.btnResetPositions,
  });
}

async function renderDiagram(
  source,
  els,
  themeKey = currentExportTheme,
  layoutOptions = getRenderLayoutOptions(els),
) {
  const text = source.trim();
  lastSource = text;
  currentExportTheme = themeKey;
  currentEdgeLayout = layoutOptions.edgeLayout;
  currentBlockLayout = layoutOptions.blockLayout;

  applyPreviewSurface(els.previewWrap, themeKey);
  initMermaid(getExportThemeConfig(themeKey).mermaid, layoutOptions);

  if (!text) {
    setExportButtonsEnabled(els, false);
    teardownNodePositioning();
    els.positionPanel?.classList.add('hidden');
    els.previewCanvas.innerHTML =
      '<p class="preview-placeholder">Paste Mermaid code in the editor to see a preview.</p>';
    setStatus(els.previewStatus, 'idle', 'Empty');
    return false;
  }

  if (text.length > MAX_CHARS) {
    setExportButtonsEnabled(els, false);
    showPreviewError(
      els.previewCanvas,
      `Diagram exceeds the ${MAX_CHARS.toLocaleString()} character limit (${text.length.toLocaleString()} chars).\n\nShorten the source or split into multiple diagrams.`,
    );
    setStatus(els.previewStatus, 'error', 'Too large');
    return false;
  }

  const id = `mermaid-graph-${++renderCounter}`;
  setStatus(els.previewStatus, 'idle', 'Rendering…');

  try {
    const renderSource = enhanceFlowchartSource(text, layoutOptions);
    const { svg } = await mermaid.render(id, renderSource);
    if (Boolean(els.manualPositions?.checked) && isFlowchartDiagram(text)) {
      teardownNodePositioning();
    }
    els.previewCanvas.innerHTML = svg;

    const manualPositions = Boolean(els.manualPositions?.checked);
    const svgEl = els.previewCanvas.querySelector('svg');
    applyDistinctEdgeStyles(svgEl, { ...layoutOptions, manualPositions });
    mountNodePositioning(text, els, layoutOptions);
    setExportButtonsEnabled(els, true);
    setStatus(els.previewStatus, 'ok', `${getExportThemeConfig(themeKey).label} preview`);
    return true;
  } catch (err) {
    setExportButtonsEnabled(els, false);
    showPreviewError(els.previewCanvas, err?.message || String(err));
    setStatus(els.previewStatus, 'error', 'Syntax error');
    return false;
  }
}

function scheduleRender(source, els) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    renderDiagram(source, els, els.exportTheme.value);
  }, DEBOUNCE_MS);
}

function parseSvgDimensions(svgEl) {
  const viewBox = svgEl.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3], viewBox };
    }
  }

  const width = parseFloat(String(svgEl.getAttribute('width') || '800').replace(/px$/, ''));
  const height = parseFloat(String(svgEl.getAttribute('height') || '600').replace(/px$/, ''));
  return { width, height, viewBox: `0 0 ${width} ${height}` };
}

/** Insert background after style/defs so it does not cover content. */
function insertBackgroundRect(svgEl, backgroundColor, width, height) {
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(width));
  bg.setAttribute('height', String(height));
  bg.setAttribute('fill', backgroundColor);

  const firstGraphic = [...svgEl.children].find(
    (node) => node.tagName !== 'style' && node.tagName !== 'defs',
  );
  svgEl.insertBefore(bg, firstGraphic ?? null);
}

/**
 * Serialize the live preview SVG (WYSIWYG export).
 * Clones the rendered DOM node so styles and native SVG text are preserved.
 */
function prepareLiveSvgForExport(previewCanvas, backgroundColor) {
  const liveSvg = previewCanvas.querySelector('svg');
  if (!liveSvg) {
    throw new Error('Nothing to export — render a diagram first');
  }

  const cloned = liveSvg.cloneNode(true);
  const { width, height, viewBox } = parseSvgDimensions(liveSvg);

  cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  cloned.setAttribute('width', String(width));
  cloned.setAttribute('height', String(height));
  cloned.setAttribute('viewBox', viewBox);

  if (backgroundColor) {
    insertBackgroundRect(cloned, backgroundColor, width, height);
  }

  return new XMLSerializer().serializeToString(cloned);
}

async function getExportSvg(source, themeKey, previewCanvas, els) {
  const layoutOptions = getRenderLayoutOptions(els);
  const needsRender =
    themeKey !== currentExportTheme ||
    layoutOptions.edgeLayout !== currentEdgeLayout ||
    layoutOptions.blockLayout !== currentBlockLayout ||
    source.trim() !== lastSource.trim() ||
    !previewCanvas.querySelector('svg');

  if (needsRender) {
    const ok = await renderDiagram(source, els, themeKey);
    if (!ok) {
      throw new Error('Could not render diagram for export');
    }
  }

  const { background } = getExportThemeConfig(themeKey);
  return prepareLiveSvgForExport(previewCanvas, background);
}

async function svgToPng(svgString, scale) {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid SVG generated for PNG export');
  }

  const svgEl = doc.querySelector('svg');
  const { width, height } = parseSvgDimensions(svgEl);

  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to rasterize SVG for PNG export'));
    image.src = svgDataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.drawImage(img, 0, 0, width, height);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('PNG export failed'));
      },
      'image/png',
      1,
    );
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(text, filename, mimeType) {
  downloadBlob(new Blob([text], { type: mimeType }), filename);
}

function timestampFilename(ext, themeKey) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `mermaid-diagram-${themeKey}-${stamp}.${ext}`;
}

function initLayoutControls(els) {
  const { mainSplit, splitHandle, btnCollapseSource, btnShowSource } = els;
  let ratio = Number(localStorage.getItem(SPLIT_RATIO_STORAGE_KEY));
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    ratio = 0.5;
  }

  let collapsed = localStorage.getItem(SOURCE_COLLAPSED_STORAGE_KEY) === '1';
  let dragging = false;

  function isStackedLayout() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function applySplit(nextRatio) {
    ratio = Math.min(0.85, Math.max(0.15, nextRatio));
    if (isStackedLayout()) {
      mainSplit.style.gridTemplateColumns = '1fr';
      mainSplit.style.gridTemplateRows = `minmax(180px, ${ratio}fr) 6px minmax(220px, ${1 - ratio}fr)`;
    } else {
      mainSplit.style.gridTemplateRows = '';
      mainSplit.style.gridTemplateColumns = `minmax(220px, ${ratio}fr) 6px minmax(280px, ${1 - ratio}fr)`;
    }
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));
  }

  function applyCollapsed(nextCollapsed) {
    collapsed = nextCollapsed;
    mainSplit.classList.toggle('source-collapsed', collapsed);
    btnShowSource.classList.toggle('hidden', !collapsed);
    btnCollapseSource.classList.toggle('hidden', collapsed);
    splitHandle.setAttribute('aria-hidden', collapsed ? 'true' : 'false');

    if (collapsed) {
      mainSplit.style.gridTemplateColumns = '1fr';
      mainSplit.style.gridTemplateRows = '';
    } else {
      applySplit(ratio);
    }

    localStorage.setItem(SOURCE_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  }

  function ratioFromPointer(clientX, clientY) {
    const rect = mainSplit.getBoundingClientRect();
    if (isStackedLayout()) {
      return (clientY - rect.top) / rect.height;
    }
    return (clientX - rect.left) / rect.width;
  }

  splitHandle.addEventListener('mousedown', (event) => {
    if (collapsed) return;
    dragging = true;
    splitHandle.classList.add('is-dragging');
    document.body.classList.add('is-resizing-panels');
    event.preventDefault();
  });

  splitHandle.addEventListener('keydown', (event) => {
    if (collapsed) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      applySplit(ratio - 0.03);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      applySplit(ratio + 0.03);
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging || collapsed) return;
    applySplit(ratioFromPointer(event.clientX, event.clientY));
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitHandle.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-panels');
  });

  window.addEventListener('resize', () => {
    if (!collapsed) applySplit(ratio);
  });

  btnCollapseSource.addEventListener('click', () => applyCollapsed(true));
  btnShowSource.addEventListener('click', () => {
    applyCollapsed(false);
    els.editor.focus();
  });

  applyCollapsed(collapsed);
}

function bindEvents(els) {
  initLayoutControls(els);
  const saved = localStorage.getItem(STORAGE_KEY);
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const savedEdgeLayout = localStorage.getItem(EDGE_LAYOUT_STORAGE_KEY);
  const savedBlockLayout = localStorage.getItem(BLOCK_LAYOUT_STORAGE_KEY);
  const savedManualPositions = localStorage.getItem(MANUAL_POSITIONS_STORAGE_KEY);
  els.exportTheme.value =
    savedTheme && EXPORT_THEMES[savedTheme] ? savedTheme : DEFAULT_THEME;
  els.edgeLayout.value =
    savedEdgeLayout && EDGE_LAYOUTS[savedEdgeLayout] ? savedEdgeLayout : DEFAULT_EDGE_LAYOUT;
  els.blockLayout.value =
    savedBlockLayout && BLOCK_LAYOUTS[savedBlockLayout]
      ? savedBlockLayout
      : DEFAULT_BLOCK_LAYOUT;
  els.manualPositions.checked = savedManualPositions === '1';

  els.editor.value = saved || DEFAULT_SOURCE;
  updateCharCount(els.charCount, els.editor.value.length);
  renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));

  els.editor.addEventListener('input', () => {
    const { value } = els.editor;
    localStorage.setItem(STORAGE_KEY, value);
    updateCharCount(els.charCount, value.length);
    scheduleRender(value, els);
  });

  els.exportTheme.addEventListener('change', () => {
    localStorage.setItem(THEME_STORAGE_KEY, els.exportTheme.value);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.edgeLayout.addEventListener('change', () => {
    localStorage.setItem(EDGE_LAYOUT_STORAGE_KEY, els.edgeLayout.value);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.blockLayout.addEventListener('change', () => {
    localStorage.setItem(BLOCK_LAYOUT_STORAGE_KEY, els.blockLayout.value);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.manualPositions.addEventListener('change', () => {
    localStorage.setItem(MANUAL_POSITIONS_STORAGE_KEY, els.manualPositions.checked ? '1' : '0');
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.btnRender.addEventListener('click', () => {
    renderDiagram(els.editor.value, els, els.exportTheme.value);
  });

  els.exampleSelect.addEventListener('change', () => {
    const name = els.exampleSelect.value;
    if (!name || !EXAMPLES[name]) return;
    els.editor.value = EXAMPLES[name];
    localStorage.setItem(STORAGE_KEY, els.editor.value);
    updateCharCount(els.charCount, els.editor.value.length);
    renderDiagram(els.editor.value, els, els.exportTheme.value);
    els.exampleSelect.value = '';
  });

  els.btnClear.addEventListener('click', () => {
    if (!els.editor.value.trim()) return;
    if (!confirm('Clear the editor?')) return;
    els.editor.value = '';
    localStorage.removeItem(STORAGE_KEY);
    updateCharCount(els.charCount, 0);
    renderDiagram('', els, els.exportTheme.value);
    els.editor.focus();
  });

  els.btnCopySvg.addEventListener('click', async () => {
    if (!els.editor.value.trim()) return;

    els.btnCopySvg.disabled = true;
    try {
      const exportSvg = await getExportSvg(
        els.editor.value,
        els.exportTheme.value,
        els.previewCanvas,
        els,
      );
      await navigator.clipboard.writeText(exportSvg);
      setStatus(els.previewStatus, 'ok', 'SVG copied');
      setTimeout(
        () =>
          setStatus(
            els.previewStatus,
            'ok',
            `${getExportThemeConfig(els.exportTheme.value).label} preview`,
          ),
        1500,
      );
    } catch (err) {
      alert(err?.message || 'Copy failed');
    } finally {
      els.btnCopySvg.disabled = !els.previewCanvas.querySelector('svg');
    }
  });

  els.btnExportSvg.addEventListener('click', async () => {
    if (!els.editor.value.trim()) return;

    const themeKey = els.exportTheme.value;
    els.btnExportSvg.disabled = true;
    els.btnExportSvg.textContent = 'Saving…';

    try {
      const exportSvg = await getExportSvg(
        els.editor.value,
        themeKey,
        els.previewCanvas,
        els,
      );
      downloadText(exportSvg, timestampFilename('svg', themeKey), 'image/svg+xml;charset=utf-8');
      setStatus(els.previewStatus, 'ok', 'SVG saved');
    } catch (err) {
      alert(err?.message || 'SVG export failed');
      setStatus(els.previewStatus, 'error', 'Export failed');
    } finally {
      els.btnExportSvg.disabled = false;
      els.btnExportSvg.textContent = 'Save SVG';
    }
  });

  els.btnExportPng.addEventListener('click', async () => {
    if (!els.editor.value.trim()) return;

    const themeKey = els.exportTheme.value;
    const scale = Math.min(4, Math.max(1, Number(els.scaleInput.value) || 2));

    els.btnExportPng.disabled = true;
    els.btnExportPng.textContent = 'Saving…';

    try {
      const exportSvg = await getExportSvg(
        els.editor.value,
        themeKey,
        els.previewCanvas,
        els,
      );
      const pngBlob = await svgToPng(exportSvg, scale);
      downloadBlob(pngBlob, timestampFilename('png', themeKey));
      setStatus(els.previewStatus, 'ok', 'PNG saved');
    } catch (err) {
      alert(err?.message || 'PNG export failed');
      setStatus(els.previewStatus, 'error', 'Export failed');
    } finally {
      els.btnExportPng.disabled = false;
      els.btnExportPng.textContent = 'Save PNG';
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      renderDiagram(els.editor.value, els, els.exportTheme.value);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (els.editor.value.trim()) els.btnExportPng.click();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (els.editor.value.trim()) els.btnExportSvg.click();
    }
  });
}

buildUi();
bindEvents(getElements());
