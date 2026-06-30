import mermaid from 'mermaid';
import { EDGE_LAYOUTS } from './edgeStyling.js';
import { getActivePositionables } from './nodePositioning.js';
import { buildEdgePath, computeSpreadEdgeAnchors } from './edgeRouting.js';

export const ORTHOGONAL_LAYOUT = 'orthogonal';
const EDGE_LAYOUT_STORAGE_KEY = 'mermaid-studio-edge-layout';

let mermaidInitPatched = false;
let previewObserver = null;
let rewritingPaths = false;

function currentEdgeLayout() {
  return (
    document.getElementById('edge-layout')?.value ||
    localStorage.getItem(EDGE_LAYOUT_STORAGE_KEY) ||
    EDGE_LAYOUTS.curvy
  );
}

function toSvgRootPoint(svg, el, x, y) {
  if (!svg || typeof svg.createSVGPoint !== 'function') {
    return { x, y };
  }

  const point = svg.createSVGPoint();
  point.x = x;
  point.y = y;
  const ctm = el.getCTM();
  if (!ctm) return { x, y };
  const transformed = point.matrixTransform(ctm);
  return { x: transformed.x, y: transformed.y };
}

function fromSvgRootPoint(svg, el, x, y) {
  if (!svg || typeof svg.createSVGPoint !== 'function') {
    return { x, y };
  }

  const point = svg.createSVGPoint();
  point.x = x;
  point.y = y;
  const ctm = el.getCTM();
  if (!ctm) return { x, y };
  const transformed = point.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

function getAbsoluteRect(el) {
  const box = el.getBBox();
  const svg = el.ownerSVGElement;
  const corners = [
    toSvgRootPoint(svg, el, box.x, box.y),
    toSvgRootPoint(svg, el, box.x + box.width, box.y),
    toSvgRootPoint(svg, el, box.x + box.width, box.y + box.height),
    toSvgRootPoint(svg, el, box.x, box.y + box.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;

  return {
    x,
    y,
    width,
    height,
    cx: x + width / 2,
    cy: y + height / 2,
  };
}

function getBorderPoint(rect, targetX, targetY) {
  const cx = rect.cx;
  const cy = rect.cy;
  const dx = targetX - cx;
  const dy = targetY - cy;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }

  const hw = Math.max(rect.width / 2, 1);
  const hh = Math.max(rect.height / 2, 1);
  const scale = Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx / scale, y: cy + dy / scale };
}

function isClassEdgePath(pathEl) {
  const cls = pathEl.getAttribute('class') || '';
  return cls.includes('relation') || Boolean(pathEl.closest('g.edgePaths'));
}

function resolveMermaidFlowchartCurve(edgeLayout) {
  switch (edgeLayout) {
    case ORTHOGONAL_LAYOUT:
      return 'step';
    case EDGE_LAYOUTS.straight:
      return 'linear';
    case EDGE_LAYOUTS.curvy:
    default:
      return 'basis';
  }
}

function patchMermaidInitialize() {
  if (mermaidInitPatched) return;
  mermaidInitPatched = true;

  const originalInitialize = mermaid.initialize.bind(mermaid);
  mermaid.initialize = (config) => {
    const nextConfig = { ...config, flowchart: { ...(config.flowchart || {}) } };
    const edgeLayout = currentEdgeLayout();
    nextConfig.flowchart.curve = resolveMermaidFlowchartCurve(edgeLayout);
    return originalInitialize(nextConfig);
  };
}

function ensureEdgeLayoutOption() {
  const select = document.getElementById('edge-layout');
  if (!select) return;

  if (!select.querySelector(`option[value="${ORTHOGONAL_LAYOUT}"]`)) {
    const option = document.createElement('option');
    option.value = ORTHOGONAL_LAYOUT;
    option.textContent = 'Original (90°)';
    select.appendChild(option);
  }

  select.title =
    'Curved: smooth arcs · Straight: direct lines · Original: Mermaid 90° right-angle routing';

  const saved = localStorage.getItem(EDGE_LAYOUT_STORAGE_KEY);
  if (saved === ORTHOGONAL_LAYOUT) {
    select.value = ORTHOGONAL_LAYOUT;
  }
}

function rewriteEdgePaths(svg, edgeLayout) {
  if (!svg) return;

  const positionables = getActivePositionables();
  const paths = [
    ...svg.querySelectorAll('path.flowchart-link'),
    ...svg.querySelectorAll('g.edgePaths path, path.relation'),
  ];

  const edgeRects = [];
  const pathEntries = [];

  paths.forEach((pathEl) => {
    const startId = pathEl.dataset.edgeStart;
    const endId = pathEl.dataset.edgeEnd;
    if (!positionables || !startId || !endId) return;

    const sourceEl = positionables.get(startId);
    const targetEl = positionables.get(endId);
    if (!sourceEl || !targetEl) return;

    const sourceRect = getAbsoluteRect(sourceEl);
    const targetRect = getAbsoluteRect(targetEl);
    edgeRects.push({ startId, endId, sourceRect, targetRect });
    pathEntries.push({ pathEl });
  });

  if (pathEntries.length > 0) {
    const anchors = computeSpreadEdgeAnchors(edgeRects);
    pathEntries.forEach(({ pathEl }, index) => {
      const { startPoint, endPoint } = anchors[index];

      pathEl.removeAttribute('transform');
      pathEl.style.transform = '';

      if (isClassEdgePath(pathEl)) {
        pathEl.setAttribute('d', buildEdgePath(startPoint, endPoint, edgeLayout));
      } else {
        const localStart = fromSvgRootPoint(svg, pathEl, startPoint.x, startPoint.y);
        const localEnd = fromSvgRootPoint(svg, pathEl, endPoint.x, endPoint.y);
        pathEl.setAttribute('d', buildEdgePath(localStart, localEnd, edgeLayout));
      }
    });
    return;
  }

  paths.forEach((pathEl) => {
    if (edgeLayout !== ORTHOGONAL_LAYOUT && edgeLayout !== EDGE_LAYOUTS.straight) {
      return;
    }

    const match = /^M\s*([-\d.]+)[,\s]+([-\d.]+).*?([-\d.]+)[,\s]+([-\d.]+)\s*$/.exec(
      pathEl.getAttribute('d') || '',
    );
    if (!match) return;

    const start = { x: Number(match[1]), y: Number(match[2]) };
    const end = { x: Number(match[3]), y: Number(match[4]) };
    pathEl.setAttribute('d', buildEdgePath(start, end, edgeLayout));
  });
}

function schedulePathRewrite(svg) {
  const edgeLayout = currentEdgeLayout();
  if (
    edgeLayout !== ORTHOGONAL_LAYOUT &&
    !(edgeLayout === EDGE_LAYOUTS.straight && document.getElementById('manual-positions')?.checked)
  ) {
    return;
  }

  if (rewritingPaths) return;

  requestAnimationFrame(() => {
    if (rewritingPaths) return;
    rewritingPaths = true;
    try {
      rewriteEdgePaths(svg, edgeLayout);
    } finally {
      rewritingPaths = false;
    }
  });
}

function ensurePreviewObserver() {
  if (previewObserver) return;

  const attach = () => {
    const previewWrap = document.getElementById('preview-wrap');
    if (!previewWrap) return false;

    previewObserver = new MutationObserver(() => {
      const svg = previewWrap.querySelector('svg');
      if (svg) schedulePathRewrite(svg);
    });

    previewObserver.observe(previewWrap, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['d', 'transform'],
    });

    const svg = previewWrap.querySelector('svg');
    if (svg) schedulePathRewrite(svg);
    return true;
  };

  if (!attach()) {
    const bootObserver = new MutationObserver(() => {
      if (attach()) bootObserver.disconnect();
    });
    bootObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
}

export function installOrthogonalEdgeMode() {
  EDGE_LAYOUTS.orthogonal = ORTHOGONAL_LAYOUT;

  patchMermaidInitialize();
  ensureEdgeLayoutOption();
  ensurePreviewObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureEdgeLayoutOption, { once: true });
  }

  document.addEventListener('change', (event) => {
    if (event.target?.id !== 'edge-layout' && event.target?.id !== 'manual-positions') return;
    const svg = document.getElementById('preview-wrap')?.querySelector('svg');
    if (svg) schedulePathRewrite(svg);
  });
}

installOrthogonalEdgeMode();
