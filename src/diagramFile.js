import { BLOCK_LAYOUTS, EDGE_LAYOUTS } from './edgeStyling.js';

export const DIAGRAM_FORMAT = 'mermaid-studio';
export const DIAGRAM_VERSION = 1;
export const DIAGRAM_EXTENSION = '.msd';

export const DEFAULT_DIAGRAM_SOURCE = `flowchart TB
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

export function createDiagramDocument({
  name = 'Untitled',
  source = DEFAULT_DIAGRAM_SOURCE,
  settings = {},
  layout = {},
} = {}) {
  return {
    format: DIAGRAM_FORMAT,
    version: DIAGRAM_VERSION,
    name,
    source,
    settings: normalizeSettings(settings),
    layout: normalizeLayout(layout),
    updatedAt: new Date().toISOString(),
  };
}

export function parseDiagramDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid diagram file — expected JSON');
  }

  if (parsed?.format !== DIAGRAM_FORMAT) {
    throw new Error('Unrecognized diagram file format');
  }

  return {
    format: DIAGRAM_FORMAT,
    version: Number(parsed.version) || 1,
    name: String(parsed.name || 'Untitled'),
    source: String(parsed.source ?? ''),
    settings: normalizeSettings(parsed.settings),
    layout: normalizeLayout(parsed.layout),
    updatedAt: parsed.updatedAt || new Date().toISOString(),
  };
}

export function serializeDiagramDocument(doc) {
  const normalized = {
    ...doc,
    format: DIAGRAM_FORMAT,
    version: DIAGRAM_VERSION,
    settings: normalizeSettings(doc.settings),
    layout: normalizeLayout(doc.layout),
    updatedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function normalizeSettings(settings = {}) {
  return {
    exportTheme: settings.exportTheme || 'dark',
    edgeLayout: settings.edgeLayout || EDGE_LAYOUTS.curvy,
    blockLayout: settings.blockLayout || BLOCK_LAYOUTS.original,
    manualPositions: Boolean(settings.manualPositions),
    moveSubgraphs: Boolean(settings.moveSubgraphs),
    subgraphResize: Boolean(settings.subgraphResize),
    canvasSize: Boolean(settings.canvasSize),
  };
}

export function normalizeLayout(layout = {}) {
  const byNode = {};
  const byCluster = {};

  for (const [id, pos] of Object.entries(layout.byNode || {})) {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      byNode[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    }
  }

  for (const [id, rect] of Object.entries(layout.byCluster || {})) {
    if (
      rect &&
      Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      Number.isFinite(rect.width) &&
      Number.isFinite(rect.height)
    ) {
      byCluster[id] = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }
  }

  return {
    byNode,
    byCluster,
    canvasBounds: normalizeCanvasBounds(layout.canvasBounds),
    canvasBoundsSourceHash:
      typeof layout.canvasBoundsSourceHash === 'string' ? layout.canvasBoundsSourceHash : null,
  };
}

function normalizeCanvasBounds(bounds) {
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function captureSettingsFromUi(els) {
  return normalizeSettings({
    exportTheme: els.exportTheme?.value,
    edgeLayout: els.edgeLayout?.value,
    blockLayout: els.blockLayout?.value,
    manualPositions: els.manualPositions?.checked,
    moveSubgraphs: els.moveSubgraphs?.checked,
    subgraphResize: els.subgraphResize?.checked,
    canvasSize: els.canvasSize?.checked,
  });
}

export function applySettingsToUi(settings, els) {
  const normalized = normalizeSettings(settings);

  if (els.exportTheme && EXPORT_THEME_VALUES.has(normalized.exportTheme)) {
    els.exportTheme.value = normalized.exportTheme;
  }
  if (els.edgeLayout && EDGE_LAYOUT_VALUES.has(normalized.edgeLayout)) {
    els.edgeLayout.value = normalized.edgeLayout;
  }
  if (els.blockLayout && BLOCK_LAYOUT_VALUES.has(normalized.blockLayout)) {
    els.blockLayout.value = normalized.blockLayout;
  }
  if (els.manualPositions) {
    els.manualPositions.checked = normalized.manualPositions;
  }
  if (els.moveSubgraphs) {
    els.moveSubgraphs.checked = normalized.moveSubgraphs;
  }
  if (els.subgraphResize) {
    els.subgraphResize.checked = normalized.subgraphResize;
  }
  if (els.canvasSize) {
    els.canvasSize.checked = normalized.canvasSize;
  }
}

const EXPORT_THEME_VALUES = new Set(['light', 'dark', 'transparent']);
const EDGE_LAYOUT_VALUES = new Set(Object.values(EDGE_LAYOUTS));
const BLOCK_LAYOUT_VALUES = new Set(Object.values(BLOCK_LAYOUTS));

export function slugifyDiagramName(name) {
  const slug = String(name || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

export function filenameForDiagram(name, existing = new Set()) {
  const base = slugifyDiagramName(name);
  let candidate = `${base}${DIAGRAM_EXTENSION}`;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${index}${DIAGRAM_EXTENSION}`;
    index += 1;
  }
  return candidate;
}
