import mermaid from 'mermaid';
import './style.css';

const MAX_CHARS = 50_000;
const DEBOUNCE_MS = 350;
const STORAGE_KEY = 'mermaid-studio-source';
const THEME_STORAGE_KEY = 'mermaid-studio-export-theme';
const DEFAULT_THEME = 'dark';

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

/** Native SVG text labels — HTML foreignObject labels break in saved SVG / PNG export. */
function initMermaid(themeName) {
  mermaid.initialize({
    startOnLoad: false,
    maxTextSize: MAX_CHARS,
    theme: themeName,
    securityLevel: 'strict',
    htmlLabels: false,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    flowchart: {
      htmlLabels: false,
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

      <label class="field-label" for="scale-input">PNG scale</label>
      <input type="number" id="scale-input" min="1" max="4" step="1" value="2" title="Higher = sharper PNG" />

      <button type="button" id="btn-render">Render now</button>
    </div>

    <div class="main">
      <section class="panel">
        <div class="panel-header">
          <span>Source</span>
          <span id="char-count" class="char-count ok">0 / ${MAX_CHARS.toLocaleString()}</span>
        </div>
        <textarea id="editor" spellcheck="false" placeholder="Paste Mermaid code here…"></textarea>
      </section>

      <section class="panel">
        <div class="panel-header">
          <span>Preview</span>
          <span id="preview-status"><span class="status-dot"></span>Waiting</span>
        </div>
        <div id="preview-wrap" data-theme="${DEFAULT_THEME}">
          <p class="preview-placeholder">Live preview appears here as you type.</p>
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
    charCount: document.getElementById('char-count'),
    previewStatus: document.getElementById('preview-status'),
    btnExportPng: document.getElementById('btn-export-png'),
    btnExportSvg: document.getElementById('btn-export-svg'),
    btnCopySvg: document.getElementById('btn-copy-svg'),
    btnClear: document.getElementById('btn-clear'),
    btnRender: document.getElementById('btn-render'),
    exampleSelect: document.getElementById('example-select'),
    exportTheme: document.getElementById('export-theme'),
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

function showPreviewError(wrap, message) {
  wrap.innerHTML = `<div class="preview-error">${escapeHtml(message)}</div>`;
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

async function renderDiagram(source, els, themeKey = currentExportTheme) {
  const text = source.trim();
  lastSource = text;
  currentExportTheme = themeKey;

  applyPreviewSurface(els.previewWrap, themeKey);
  initMermaid(getExportThemeConfig(themeKey).mermaid);

  if (!text) {
    setExportButtonsEnabled(els, false);
    els.previewWrap.innerHTML =
      '<p class="preview-placeholder">Paste Mermaid code in the editor to see a preview.</p>';
    setStatus(els.previewStatus, 'idle', 'Empty');
    return false;
  }

  if (text.length > MAX_CHARS) {
    setExportButtonsEnabled(els, false);
    showPreviewError(
      els.previewWrap,
      `Diagram exceeds the ${MAX_CHARS.toLocaleString()} character limit (${text.length.toLocaleString()} chars).\n\nShorten the source or split into multiple diagrams.`,
    );
    setStatus(els.previewStatus, 'error', 'Too large');
    return false;
  }

  const id = `mermaid-graph-${++renderCounter}`;
  setStatus(els.previewStatus, 'idle', 'Rendering…');

  try {
    const { svg } = await mermaid.render(id, text);
    els.previewWrap.innerHTML = svg;
    setExportButtonsEnabled(els, true);
    setStatus(els.previewStatus, 'ok', `${getExportThemeConfig(themeKey).label} preview`);
    return true;
  } catch (err) {
    setExportButtonsEnabled(els, false);
    showPreviewError(els.previewWrap, err?.message || String(err));
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
function prepareLiveSvgForExport(previewWrap, backgroundColor) {
  const liveSvg = previewWrap.querySelector('svg');
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

async function getExportSvg(source, themeKey, previewWrap, els) {
  const needsRender =
    themeKey !== currentExportTheme || source.trim() !== lastSource.trim() || !previewWrap.querySelector('svg');

  if (needsRender) {
    const ok = await renderDiagram(source, els, themeKey);
    if (!ok) {
      throw new Error('Could not render diagram for export');
    }
  }

  const { background } = getExportThemeConfig(themeKey);
  return prepareLiveSvgForExport(previewWrap, background);
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

function bindEvents(els) {
  const saved = localStorage.getItem(STORAGE_KEY);
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  els.exportTheme.value =
    savedTheme && EXPORT_THEMES[savedTheme] ? savedTheme : DEFAULT_THEME;

  els.editor.value = saved || DEFAULT_SOURCE;
  updateCharCount(els.charCount, els.editor.value.length);
  renderDiagram(els.editor.value, els, els.exportTheme.value);

  els.editor.addEventListener('input', () => {
    const { value } = els.editor;
    localStorage.setItem(STORAGE_KEY, value);
    updateCharCount(els.charCount, value.length);
    scheduleRender(value, els);
  });

  els.exportTheme.addEventListener('change', () => {
    localStorage.setItem(THEME_STORAGE_KEY, els.exportTheme.value);
    renderDiagram(els.editor.value, els, els.exportTheme.value);
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
        els.previewWrap,
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
      els.btnCopySvg.disabled = !els.previewWrap.querySelector('svg');
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
        els.previewWrap,
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
        els.previewWrap,
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
