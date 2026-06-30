import {
  EDGE_LAYOUTS,
  isClassDiagram,
  isFlowchartDiagram,
  parseClassDiagramEdges,
  parseFlowchartEdges,
  supportsBlockPositioning,
} from './edgeStyling.js';
import {
  applyCanvasToSvg,
  boundsFromContentBounds,
  boundsFromSvgViewBox,
  clampClusterRectToCanvas,
  clampNodeTranslateToCanvas,
  computeResizedCanvasBounds,
  removeCanvasOverlay,
  setCanvasHandlesInteractive,
  unionCanvasBounds,
  updateCanvasOverlay,
} from './canvasBounds.js';
import { buildEdgePath, computeSpreadEdgeAnchors } from './edgeRouting.js';
import { createLayoutHistory } from './layoutHistory.js';
import {
  clientToSvg,
  parseTranslate,
  rootDeltaToParent,
  rootToParentLocal,
  viewportToUser,
} from './svgCoords.js';

const POSITIONS_STORAGE_KEY = 'mermaid-studio-node-positions';
const CLUSTER_PADDING = 12;
const VIEWBOX_PADDING = 24;
const CLUSTER_MIN_SIZE = 56;
const HANDLE_SIZE = 9;

const HANDLE_CURSORS = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

/** In-memory positions survive source re-renders within the same browser session. */
const sessionPositions = {};
const sessionClusterRects = {};
const sessionCanvasBounds = {};
const sessionCanvasSourceHash = {};

let activeDiagramStorageId = null;

function clearSessionLayout() {
  for (const key of Object.keys(sessionPositions)) {
    delete sessionPositions[key];
  }
  for (const key of Object.keys(sessionClusterRects)) {
    delete sessionClusterRects[key];
  }
  for (const key of Object.keys(sessionCanvasBounds)) {
    delete sessionCanvasBounds[key];
  }
  for (const key of Object.keys(sessionCanvasSourceHash)) {
    delete sessionCanvasSourceHash[key];
  }
}

export function setActiveDiagramId(diagramId) {
  activeDiagramStorageId = diagramId || null;
  clearSessionLayout();
}

export function exportDiagramLayout(source) {
  const store = loadAllPositions();
  return {
    byNode: { ...(store.byNode || {}) },
    byCluster: { ...(store.byCluster || {}) },
    canvasBounds: store.canvasBounds ? { ...store.canvasBounds } : null,
    canvasBoundsSourceHash: store.canvasBoundsSourceHash || null,
    structural: store[structuralDiagramKey(source)] || null,
  };
}

export function importDiagramLayout(layout = {}, source = '') {
  const nextStore = {
    byNode: { ...(layout.byNode || {}) },
    byCluster: { ...(layout.byCluster || {}) },
    canvasBounds: layout.canvasBounds ? { ...layout.canvasBounds } : null,
    canvasBoundsSourceHash: layout.canvasBoundsSourceHash || null,
  };

  const structural = layout.structural;
  if (structural && typeof structural === 'object') {
    const structuralKey = source
      ? structuralDiagramKey(source)
      : layout.structuralKey;
    if (structuralKey) {
      nextStore[structuralKey] = { ...structural };
    }
  }

  saveAllPositions(nextStore);
  clearSessionLayout();
}

export function captureDiagramLayoutForSave(source, positionables) {
  const layout = exportDiagramLayout(source);
  if (!positionables) return layout;

  const liveNodes = readPositions(positionables);
  const liveClusters = readManualClusterRects(positionables);
  layout.byNode = { ...layout.byNode, ...liveNodes };
  layout.byCluster = { ...layout.byCluster, ...liveClusters };
  if (activeController?.getCanvasBounds) {
    layout.canvasBounds = activeController.getCanvasBounds();
  }
  layout.structural = liveNodes;
  layout.structuralKey = structuralDiagramKey(source);
  return layout;
}

const RESERVED_IDS = new Set([
  'subgraph',
  'end',
  'graph',
  'flowchart',
  'classdiagram',
  'class',
  'direction',
  'namespace',
  'tb',
  'td',
  'lr',
  'rl',
  'bt',
]);

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function setTranslate(el, x, y) {
  el.setAttribute('transform', `translate(${x}, ${y})`);
}

function readClusterRect(clusterEl) {
  const rect = clusterEl.querySelector(':scope > rect');
  if (!rect) return null;

  return {
    x: Number(rect.getAttribute('x')),
    y: Number(rect.getAttribute('y')),
    width: Number(rect.getAttribute('width')),
    height: Number(rect.getAttribute('height')),
  };
}

function applyClusterRect(clusterEl, bounds) {
  const rect = clusterEl.querySelector(':scope > rect');
  if (!rect || !bounds) return;

  rect.setAttribute('x', String(bounds.x));
  rect.setAttribute('y', String(bounds.y));
  rect.setAttribute('width', String(Math.max(bounds.width, CLUSTER_MIN_SIZE)));
  rect.setAttribute('height', String(Math.max(bounds.height, CLUSTER_MIN_SIZE)));
}

function positionClusterLabel(clusterEl) {
  const bounds = readClusterRect(clusterEl);
  if (!bounds) return;

  const label = clusterEl.querySelector('.cluster-label');
  if (!label) return;

  const text = label.querySelector('text');
  if (text) {
    text.setAttribute('text-anchor', 'middle');
    const outerTspan = text.querySelector(':scope > tspan');
    if (outerTspan) {
      outerTspan.setAttribute('x', '0');
    }
    text.querySelectorAll('tspan tspan').forEach((tspan) => {
      tspan.removeAttribute('x');
    });
  }

  setTranslate(label, bounds.x + bounds.width / 2, bounds.y);

  const inner = label.querySelector(':scope > g');
  if (inner && text) {
    try {
      const box = text.getBBox();
      if (box.width > 0) {
        const offsetX = -box.x - box.width / 2;
        inner.setAttribute('transform', `translate(${offsetX}, 0)`);
        return;
      }
    } catch {
      // getBBox can fail before the SVG is painted.
    }
    inner.removeAttribute('transform');
  }
}

function ensureClusterHandles(clusterEl) {
  let handles = clusterEl.querySelector('.cluster-handles');
  if (handles) return handles;

  handles = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  handles.setAttribute('class', 'cluster-handles');

  for (const handleId of Object.keys(HANDLE_CURSORS)) {
    const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    handle.setAttribute('class', 'cluster-resize-handle');
    handle.setAttribute('data-handle', handleId);
    handle.setAttribute('rx', '2');
    handles.appendChild(handle);
  }

  clusterEl.appendChild(handles);
  return handles;
}

function updateClusterHandles(clusterEl) {
  const bounds = readClusterRect(clusterEl);
  const handles = clusterEl.querySelector('.cluster-handles');
  if (!bounds || !handles) return;

  const half = HANDLE_SIZE / 2;
  const positions = {
    nw: [bounds.x - half, bounds.y - half],
    n: [bounds.x + bounds.width / 2 - half, bounds.y - half],
    ne: [bounds.x + bounds.width - half, bounds.y - half],
    e: [bounds.x + bounds.width - half, bounds.y + bounds.height / 2 - half],
    se: [bounds.x + bounds.width - half, bounds.y + bounds.height - half],
    s: [bounds.x + bounds.width / 2 - half, bounds.y + bounds.height - half],
    sw: [bounds.x - half, bounds.y + bounds.height - half],
    w: [bounds.x - half, bounds.y + bounds.height / 2 - half],
  };

  handles.querySelectorAll('.cluster-resize-handle').forEach((handle) => {
    const id = handle.dataset.handle;
    const [x, y] = positions[id] || [0, 0];
    handle.setAttribute('x', String(x));
    handle.setAttribute('y', String(y));
    handle.setAttribute('width', String(HANDLE_SIZE));
    handle.setAttribute('height', String(HANDLE_SIZE));
    handle.style.cursor = HANDLE_CURSORS[id] || 'pointer';
  });
}

function removeClusterHandles(clusterEl) {
  clusterEl.querySelector('.cluster-handles')?.remove();
}

function syncClusterHandleVisibility(clusterEl) {
  if (subgraphHandlesEnabled) {
    ensureClusterHandles(clusterEl);
    updateClusterHandles(clusterEl);
  } else {
    removeClusterHandles(clusterEl);
  }
}

/** Remove editor-only overlays before SVG/PNG export. */
export function stripPositioningEditorArtifacts(svgEl) {
  if (!svgEl) return;
  svgEl.querySelectorAll('.cluster-handles').forEach((el) => el.remove());
  removeCanvasOverlay(svgEl);
}

function computeResizedClusterRect(start, handle, dx, dy) {
  let { x, y, width, height } = start;

  if (handle.includes('e')) {
    width = Math.max(CLUSTER_MIN_SIZE, start.width + dx);
  }
  if (handle.includes('w')) {
    const nextWidth = Math.max(CLUSTER_MIN_SIZE, start.width - dx);
    x = start.x + start.width - nextWidth;
    width = nextWidth;
  }
  if (handle.includes('s')) {
    height = Math.max(CLUSTER_MIN_SIZE, start.height + dy);
  }
  if (handle.includes('n')) {
    const nextHeight = Math.max(CLUSTER_MIN_SIZE, start.height - dy);
    y = start.y + start.height - nextHeight;
    height = nextHeight;
  }

  return { x, y, width, height };
}

function applyManualClusterRects(positionables, rects) {
  for (const [id, bounds] of Object.entries(rects)) {
    const clusterEl = positionables.get(id);
    if (!clusterEl?.classList.contains('cluster') || !bounds) continue;

    clusterEl.dataset.manualRect = '1';
    applyClusterRect(clusterEl, bounds);
    positionClusterLabel(clusterEl);
    syncClusterHandleVisibility(clusterEl);
  }
}

function shiftClusterRectByRootDelta(svg, clusterEl, deltaX, deltaY, startRect = null) {
  const bounds = startRect || readClusterRect(clusterEl);
  if (!bounds) return;

  const origin = rootToParentLocal(svg, clusterEl, 0, 0);
  const shifted = rootToParentLocal(svg, clusterEl, deltaX, deltaY);
  const dx = shifted.x - origin.x;
  const dy = shifted.y - origin.y;
  if (dx === 0 && dy === 0) return;

  clusterEl.dataset.manualRect = '1';
  applyClusterRect(clusterEl, {
    x: bounds.x + dx,
    y: bounds.y + dy,
    width: bounds.width,
    height: bounds.height,
  });
  positionClusterLabel(clusterEl);
  syncClusterHandleVisibility(clusterEl);
}

export function getLogicalNodeId(el) {
  const id = el.id || el.getAttribute('data-id') || '';
  if (!id) return '';

  // Mermaid flowchart nodes: mermaid-graph-2-flowchart-U-0
  const flowchartMatch = /flowchart-(.+)-\d+$/.exec(id);
  if (flowchartMatch) return flowchartMatch[1];

  // Mermaid class nodes: mermaid-graph-2-classId-ContentOwnership-0
  const classMatch = /classId-(.+)-\d+$/.exec(id);
  if (classMatch) return classMatch[1];

  // Mermaid subgraphs: mermaid-graph-2-Current
  const subgraphMatch = /^mermaid-graph-\d+-(.+)$/.exec(id);
  if (subgraphMatch && !id.includes('flowchart-') && !id.includes('classId-')) {
    return subgraphMatch[1];
  }

  const parts = id.split('-');
  return parts[parts.length - 1] || id;
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

function getPositionableShapeEl(el) {
  if (el.classList.contains('cluster')) {
    return el.querySelector(':scope > rect');
  }

  return el.querySelector(':scope > rect, :scope > polygon, :scope > circle, :scope > ellipse');
}

/** Border rect for edge anchoring — shape geometry in viewport space (matches path CTM math). */
function getPositionableBorderRect(el) {
  const shape = getPositionableShapeEl(el);
  return getAbsoluteRect(shape || el);
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

function distanceToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function closestNodeId(point, positionables) {
  let bestId = null;
  let bestDistance = Infinity;

  positionables.forEach((el, id) => {
    const rect = getAbsoluteRect(el);
    const distance = distanceToRect(point, rect);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  });

  return bestId;
}

function resolvePositionableId(id, positionables) {
  if (!id) return null;
  if (positionables.has(id)) return id;

  const lower = id.toLowerCase();
  for (const key of positionables.keys()) {
    if (key.toLowerCase() === lower) return key;
  }

  return null;
}

function readPathEndpoints(pathEl) {
  if (typeof pathEl.getPointAtLength !== 'function') return null;

  const length = pathEl.getTotalLength();
  if (!length) return null;

  const start = pathEl.getPointAtLength(0);
  const end = pathEl.getPointAtLength(length);
  return {
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
  };
}

function parseEdgeEndpointsFromPathId(pathId, positionables) {
  const match = /-L_(.+)_\d+$/.exec(pathId || '');
  if (!match) return null;

  const parts = match[1].split('_');
  for (let i = 1; i < parts.length; i += 1) {
    const start = resolvePositionableId(parts.slice(0, i).join('_'), positionables);
    const end = resolvePositionableId(parts.slice(i).join('_'), positionables);
    if (start && end && start !== end) {
      return { start, end };
    }
  }

  return null;
}

function parseClassEdgeEndpointsFromPathId(pathId, positionables) {
  const match = /id_(.+)_\d+$/.exec(pathId || '');
  if (!match) return null;

  const parts = match[1].split('_');
  for (let i = 1; i < parts.length; i += 1) {
    const start = resolvePositionableId(parts.slice(0, i).join('_'), positionables);
    const end = resolvePositionableId(parts.slice(i).join('_'), positionables);
    if (start && end && start !== end) {
      return { start, end };
    }
  }

  return null;
}

function bindClassDiagramEdges(svg, positionables, diagramKey) {
  const paths = [...svg.querySelectorAll('g.edgePaths path, path.relation')];
  const diagramEdges = parseClassDiagramEdges(diagramKey);
  let diagramEdgeIndex = 0;

  paths.forEach((pathEl) => {
    let start = null;
    let end = null;

    const fromPathId = parseClassEdgeEndpointsFromPathId(pathEl.id, positionables);
    if (fromPathId) {
      start = fromPathId.start;
      end = fromPathId.end;
    }

    if (!start || !end) {
      const fallback = diagramEdges[diagramEdgeIndex];
      diagramEdgeIndex += 1;
      start = resolvePositionableId(fallback?.start, positionables);
      end = resolvePositionableId(fallback?.end, positionables);
    }

    if (!start || !end) {
      const points = readPathEndpoints(pathEl);
      if (points) {
        const svgEl = pathEl.ownerSVGElement;
        const rootStart = toSvgRootPoint(svgEl, pathEl, points.start.x, points.start.y);
        const rootEnd = toSvgRootPoint(svgEl, pathEl, points.end.x, points.end.y);
        start = start || closestNodeId(rootStart, positionables);
        end = end || closestNodeId(rootEnd, positionables);
      }
    }

    if (start && end && start !== end) {
      pathEl.dataset.edgeStart = start;
      pathEl.dataset.edgeEnd = end;
    }
  });
}

function bindDiagramEdges(svg, positionables, diagramKey) {
  if (isFlowchartDiagram(diagramKey)) {
    bindFlowchartEdges(svg, positionables, diagramKey);
    return;
  }

  if (isClassDiagram(diagramKey)) {
    bindClassDiagramEdges(svg, positionables, diagramKey);
  }
}

export function bindFlowchartEdges(svg, positionables, diagramKey) {
  const paths = [...svg.querySelectorAll('path.flowchart-link')];
  const diagramEdges = parseFlowchartEdges(diagramKey);
  let diagramEdgeIndex = 0;

  paths.forEach((pathEl) => {
    let start = null;
    let end = null;

    const fromPathId = parseEdgeEndpointsFromPathId(pathEl.id, positionables);
    if (fromPathId) {
      start = fromPathId.start;
      end = fromPathId.end;
    }

    if (!start || !end) {
      const fallback = diagramEdges[diagramEdgeIndex];
      diagramEdgeIndex += 1;
      start = resolvePositionableId(fallback?.start, positionables);
      end = resolvePositionableId(fallback?.end, positionables);
    }

    if (!start || !end) {
      const points = readPathEndpoints(pathEl);
      if (points) {
        const svg = pathEl.ownerSVGElement;
        const rootStart = toSvgRootPoint(svg, pathEl, points.start.x, points.start.y);
        const rootEnd = toSvgRootPoint(svg, pathEl, points.end.x, points.end.y);
        start = start || closestNodeId(rootStart, positionables);
        end = end || closestNodeId(rootEnd, positionables);
      }
    }

    if (start && end && start !== end) {
      pathEl.dataset.edgeStart = start;
      pathEl.dataset.edgeEnd = end;
    }
  });
}

function extractPositionableIds(source) {
  const ids = new Set();

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const subgraphMatch = /^subgraph\s+([A-Za-z][\w-]*)/i.exec(trimmed);
    if (subgraphMatch) {
      ids.add(subgraphMatch[1]);
    }

    const classMatch = /^class\s+([A-Za-z][\w-]*)/i.exec(trimmed);
    if (classMatch) {
      ids.add(classMatch[1]);
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[|\(|\{)/g)) {
      if (!RESERVED_IDS.has(match[1].toLowerCase())) {
        ids.add(match[1]);
      }
    }

    const edgeParts = trimmed.split(/(?:-->|---|===|-.->|<-->|--o|--x|<\|--|--\|>|\.\.>|--\*>)/);
    for (const part of edgeParts) {
      const id = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (id && !RESERVED_IDS.has(id.toLowerCase())) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

function structuralDiagramKey(source) {
  return hashString(extractPositionableIds(source).sort().join('\n'));
}

function captureSessionPositions(positionables) {
  if (!positionables) return;
  Object.assign(sessionPositions, readPositions(positionables));
  Object.assign(sessionClusterRects, readManualClusterRects(positionables));
}

function readManualClusterRects(positionables) {
  const rects = {};
  positionables.forEach((el, id) => {
    if (!el.classList.contains('cluster') || !el.dataset.manualRect) return;
    const bounds = readClusterRect(el);
    if (bounds) rects[id] = bounds;
  });
  return rects;
}

function resolveStoredClusterRects(diagramKey, clusterIds) {
  const store = loadAllPositions();
  const merged = {};

  const byCluster = store.byCluster || {};
  for (const id of clusterIds) {
    if (byCluster[id]) merged[id] = byCluster[id];
  }

  for (const id of clusterIds) {
    if (sessionClusterRects[id]) merged[id] = sessionClusterRects[id];
  }

  return merged;
}

function setStoredClusterRects(diagramKey, rects) {
  replaceStoredClusterRects(rects, Object.keys(rects));
}

function replaceStoredClusterRects(rects, clusterIds) {
  const store = loadAllPositions();
  if (!store.byCluster) store.byCluster = {};

  for (const id of clusterIds) {
    if (rects[id]) {
      store.byCluster[id] = rects[id];
      sessionClusterRects[id] = rects[id];
    } else {
      delete store.byCluster[id];
      delete sessionClusterRects[id];
    }
  }

  saveAllPositions(store);
}

function clearStoredClusterRects(clusterIds) {
  const store = loadAllPositions();
  if (store.byCluster) {
    for (const id of clusterIds) {
      delete store.byCluster[id];
      delete sessionClusterRects[id];
    }
  }
  saveAllPositions(store);
}

function diagramSourceHash(diagramKey) {
  return hashString(diagramKey);
}

function hasSourceChangedSinceLayout(diagramKey) {
  const storedHash = resolveStoredCanvasSourceHash(diagramKey);
  if (!storedHash) return false;
  return storedHash !== diagramSourceHash(diagramKey);
}

function needsCanvasRecapture(diagramKey) {
  if (!resolveStoredCanvasBounds(diagramKey)) return true;
  if (!resolveStoredCanvasSourceHash(diagramKey)) return true;
  return hasSourceChangedSinceLayout(diagramKey);
}

function resolveStoredCanvasBounds(diagramKey) {
  const store = loadAllPositions();
  if (store.canvasBounds) return { ...store.canvasBounds };
  if (sessionCanvasBounds[diagramKey]) return { ...sessionCanvasBounds[diagramKey] };
  return null;
}

function resolveStoredCanvasSourceHash(diagramKey) {
  const store = loadAllPositions();
  if (store.canvasBoundsSourceHash) return store.canvasBoundsSourceHash;
  return sessionCanvasSourceHash[diagramKey] || null;
}

function setStoredCanvasBounds(diagramKey, bounds) {
  if (!bounds) return;

  const sourceHash = diagramSourceHash(diagramKey);
  const store = loadAllPositions();
  store.canvasBounds = { ...bounds };
  store.canvasBoundsSourceHash = sourceHash;
  sessionCanvasBounds[diagramKey] = { ...bounds };
  sessionCanvasSourceHash[diagramKey] = sourceHash;
  saveAllPositions(store);
}

function clearStoredCanvasBounds(diagramKey) {
  const store = loadAllPositions();
  delete store.canvasBounds;
  delete store.canvasBoundsSourceHash;
  delete sessionCanvasBounds[diagramKey];
  delete sessionCanvasSourceHash[diagramKey];
  saveAllPositions(store);
}

function computeContentBounds(svg) {
  let bounds = null;

  svg.querySelectorAll('g.node, g.cluster').forEach((el) => {
    bounds = mergeBounds(bounds, toUserSpaceBounds(svg, getAbsoluteRect(el)));
  });

  svg.querySelectorAll('g.edgeLabel, .edgeLabel').forEach((el) => {
    bounds = mergeBounds(bounds, toUserSpaceBounds(svg, getAbsoluteRect(el)));
  });

  svg.querySelectorAll('path.flowchart-link, g.edgePaths path, path.relation').forEach((pathEl) => {
    bounds = mergeBounds(bounds, toUserSpaceBounds(svg, getPathAbsoluteRect(pathEl)));
  });

  return bounds;
}

function toUserSpaceBounds(svg, viewportRect) {
  if (!viewportRect || !svg) return null;

  const corners = [
    viewportToUser(svg, viewportRect.x, viewportRect.y),
    viewportToUser(svg, viewportRect.x + viewportRect.width, viewportRect.y),
    viewportToUser(svg, viewportRect.x + viewportRect.width, viewportRect.y + viewportRect.height),
    viewportToUser(svg, viewportRect.x, viewportRect.y + viewportRect.height),
  ];

  return {
    x: Math.min(...corners.map((point) => point.x)),
    y: Math.min(...corners.map((point) => point.y)),
    width: Math.max(...corners.map((point) => point.x)) - Math.min(...corners.map((point) => point.x)),
    height: Math.max(...corners.map((point) => point.y)) - Math.min(...corners.map((point) => point.y)),
  };
}

function captureInitialCanvasBounds(svg, mermaidViewBoxBounds) {
  const contentBounds = boundsFromContentBounds(computeContentBounds(svg));
  return unionCanvasBounds(mermaidViewBoxBounds, contentBounds);
}

function resolveCanvasBounds(diagramKey, svg, mermaidViewBoxBounds) {
  const bounds = captureInitialCanvasBounds(svg, mermaidViewBoxBounds);
  if (bounds) {
    setStoredCanvasBounds(diagramKey, bounds);
  }
  return bounds;
}

function resolveStoredPositions(diagramKey, positionableIds) {
  const store = loadAllPositions();
  const merged = {};

  const legacy = store[hashString(diagramKey)];
  if (legacy) Object.assign(merged, legacy);

  const structural = store[structuralDiagramKey(diagramKey)];
  if (structural) Object.assign(merged, structural);

  const byNode = store.byNode || {};
  for (const id of positionableIds) {
    if (byNode[id]) merged[id] = byNode[id];
  }

  for (const id of positionableIds) {
    if (sessionPositions[id]) merged[id] = sessionPositions[id];
  }

  return merged;
}

function loadRootPositionStore() {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeRootPositionStore(root) {
  localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(root));
}

function loadAllPositions() {
  const root = loadRootPositionStore();
  if (!activeDiagramStorageId) {
    return root;
  }

  if (!root.diagrams) root.diagrams = {};
  if (!root.diagrams[activeDiagramStorageId]) {
    root.diagrams[activeDiagramStorageId] = {
      byNode: {},
      byCluster: {},
      canvasBounds: null,
      canvasBoundsSourceHash: null,
    };
  }

  return root.diagrams[activeDiagramStorageId];
}

function saveAllPositions(store) {
  if (!activeDiagramStorageId) {
    writeRootPositionStore(store);
    return;
  }

  const root = loadRootPositionStore();
  if (!root.diagrams) root.diagrams = {};
  root.diagrams[activeDiagramStorageId] = store;
  writeRootPositionStore(root);
}

function setStoredPositions(diagramKey, positions, positionableIds = Object.keys(positions)) {
  const store = loadAllPositions();
  if (!store.byNode) store.byNode = {};

  for (const id of positionableIds) {
    const pos = positions[id];
    if (pos) {
      store.byNode[id] = pos;
      sessionPositions[id] = pos;
    }
  }

  const structuralKey = structuralDiagramKey(diagramKey);
  store[structuralKey] = { ...(store[structuralKey] || {}), ...positions };
  saveAllPositions(store);
}

function clearStoredPositions(diagramKey, positionableIds) {
  const store = loadAllPositions();
  if (store.byNode) {
    for (const id of positionableIds) {
      delete store.byNode[id];
      delete sessionPositions[id];
    }
  }

  delete store[hashString(diagramKey)];
  delete store[structuralDiagramKey(diagramKey)];
  saveAllPositions(store);
}

function getPathAbsoluteRect(pathEl) {
  const svg = pathEl.ownerSVGElement;
  if (!svg || typeof pathEl.getBBox !== 'function') return null;

  const box = pathEl.getBBox();
  const corners = [
    toSvgRootPoint(svg, pathEl, box.x, box.y),
    toSvgRootPoint(svg, pathEl, box.x + box.width, box.y),
    toSvgRootPoint(svg, pathEl, box.x + box.width, box.y + box.height),
    toSvgRootPoint(svg, pathEl, box.x, box.y + box.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);

  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function mergeBounds(bounds, rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width)) return bounds;

  const next = bounds ?? {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.width,
    maxY: rect.y + rect.height,
  };

  next.minX = Math.min(next.minX, rect.x);
  next.minY = Math.min(next.minY, rect.y);
  next.maxX = Math.max(next.maxX, rect.x + rect.width);
  next.maxY = Math.max(next.maxY, rect.y + rect.height);
  return next;
}

function parseSubgraphMembership(source) {
  const membership = new Map();
  let currentSubgraph = null;

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const subgraphMatch = /^subgraph\s+([A-Za-z][\w-]*)/i.exec(trimmed);
    if (subgraphMatch) {
      currentSubgraph = subgraphMatch[1];
      membership.set(currentSubgraph, []);
      continue;
    }

    if (/^end$/i.test(trimmed)) {
      currentSubgraph = null;
      continue;
    }

    if (!currentSubgraph) continue;

    const nodeDefs = [...trimmed.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[|\(|\{|-->|---|===|-.->)/g)];
    for (const match of nodeDefs) {
      const id = match[1];
      if (['subgraph', 'end'].includes(id.toLowerCase())) continue;
      const members = membership.get(currentSubgraph);
      if (!members.includes(id)) members.push(id);
    }

    const edgeParts = trimmed.split(/(?:-->|---|===|-.->|<-->|--o|--x)/);
    for (const part of edgeParts) {
      const id = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (!id || ['subgraph', 'end'].includes(id.toLowerCase())) continue;
      const members = membership.get(currentSubgraph);
      if (!members.includes(id)) members.push(id);
    }
  }

  return membership;
}

function storeClusterDefaults(svg) {
  svg.querySelectorAll('g.clusters g.cluster').forEach((clusterEl) => {
    const rect = clusterEl.querySelector(':scope > rect');
    if (!rect) return;

    clusterEl.dataset.defaultRect = JSON.stringify({
      x: rect.getAttribute('x'),
      y: rect.getAttribute('y'),
      width: rect.getAttribute('width'),
      height: rect.getAttribute('height'),
    });

    const label = clusterEl.querySelector('.cluster-label');
    if (label) {
      clusterEl.dataset.defaultLabelTransform = label.getAttribute('transform') || '';
    }
  });

  if (!svg.dataset.defaultViewBox) {
    svg.dataset.defaultViewBox = svg.getAttribute('viewBox') || '';
  }
}

function restoreClusterDefaults(svg) {
  svg.querySelectorAll('g.clusters g.cluster').forEach((clusterEl) => {
    const rect = clusterEl.querySelector(':scope > rect');
    if (!rect || !clusterEl.dataset.defaultRect) return;

    const defaults = JSON.parse(clusterEl.dataset.defaultRect);
    rect.setAttribute('x', defaults.x);
    rect.setAttribute('y', defaults.y);
    rect.setAttribute('width', defaults.width);
    rect.setAttribute('height', defaults.height);

    delete clusterEl.dataset.manualRect;
    removeClusterHandles(clusterEl);

    const label = clusterEl.querySelector('.cluster-label');
    if (label) {
      if (clusterEl.dataset.defaultLabelTransform) {
        label.setAttribute('transform', clusterEl.dataset.defaultLabelTransform);
      }
      label.querySelector(':scope > g')?.removeAttribute('transform');
    }
  });

  if (svg.dataset.defaultViewBox) {
    svg.setAttribute('viewBox', svg.dataset.defaultViewBox);
  }
}

function expandSvgViewBox(svg) {
  const bounds = captureInitialCanvasBounds(svg, boundsFromSvgViewBox(svg));
  if (bounds) applyCanvasToSvg(svg, bounds);
}

function ensureManualSvgDimensions(svg, canvasBounds) {
  if (!svg) return;
  if (canvasBounds) {
    applyCanvasToSvg(svg, canvasBounds);
    return;
  }
  expandSvgViewBox(svg);
}

function syncManualLayout(svg, positionables, edgeLayout, diagramKey) {
  rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
}

function collectPositionables(svg) {
  const nodes = [...svg.querySelectorAll('g.node, g.cluster')].filter((el) => getLogicalNodeId(el));
  const byId = new Map();
  nodes.forEach((el) => {
    const id = getLogicalNodeId(el);
    if (!byId.has(id)) byId.set(id, el);
  });
  return byId;
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

function getFlowchartPathCoordEl(pathEl) {
  return pathEl;
}

function toEdgePathLocalPoint(svg, pathEl, rootX, rootY) {
  return fromSvgRootPoint(svg, getFlowchartPathCoordEl(pathEl), rootX, rootY);
}

export function rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey = '') {
  if (!svg || positionables.size === 0) return;

  const paths = [
    ...new Set([
      ...svg.querySelectorAll('path.flowchart-link'),
      ...svg.querySelectorAll('path.relation'),
    ]),
  ];

  if (diagramKey) {
    bindDiagramEdges(svg, positionables, diagramKey);
  }

  const edgeRects = [];
  const pathEntries = [];

  paths.forEach((pathEl) => {
    const startId = pathEl.dataset.edgeStart;
    const endId = pathEl.dataset.edgeEnd;
    if (!startId || !endId) return;

    const sourceEl = positionables.get(startId);
    const targetEl = positionables.get(endId);
    if (!sourceEl || !targetEl) return;

    const sourceRect = getPositionableBorderRect(sourceEl);
    const targetRect = getPositionableBorderRect(targetEl);
    edgeRects.push({ startId, endId, sourceRect, targetRect });
    pathEntries.push({ pathEl, sourceRect, targetRect });
  });

  if (pathEntries.length === 0) return;

  const anchors = computeSpreadEdgeAnchors(edgeRects);

  pathEntries.forEach(({ pathEl }, index) => {
    const { startPoint, endPoint } = anchors[index];

    pathEl.removeAttribute('transform');
    pathEl.style.transform = '';

    const localStart = toEdgePathLocalPoint(svg, pathEl, startPoint.x, startPoint.y);
    const localEnd = toEdgePathLocalPoint(svg, pathEl, endPoint.x, endPoint.y);
    pathEl.setAttribute('d', buildEdgePath(localStart, localEnd, edgeLayout));

    const startId = pathEl.dataset.edgeStart;
    const endId = pathEl.dataset.edgeEnd;
    const sourceEl = positionables.get(startId);
    const targetEl = positionables.get(endId);
    if (sourceEl && targetEl) {
      updateEdgeLabel(
        svg,
        startId,
        endId,
        pathEl,
        getPositionableBorderRect(sourceEl),
        getPositionableBorderRect(targetEl),
      );
    }
  });
}

export function spreadFlowchartEdgeAnchors(svg, diagramKey, edgeLayout) {
  if (!svg || !diagramKey) return;
  const positionables = collectPositionables(svg);
  if (positionables.size === 0) return;
  bindDiagramEdges(svg, positionables, diagramKey);
  rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
}

/** Size the preview SVG from its stored canvas bounds. */
export function fitPreviewSvgToContent(svg, canvasBounds) {
  ensureManualSvgDimensions(svg, canvasBounds);
}

function isClassEdgePath(pathEl) {
  const cls = pathEl.getAttribute('class') || '';
  return cls.includes('relation');
}

function getPathLinkId(pathEl) {
  const id = pathEl.id || '';
  const match = /^mermaid-graph-\d+-(.+)$/.exec(id);
  return match ? match[1] : id;
}

function findEdgeLabelForPath(svg, pathEl, startId, endId) {
  const linkId = getPathLinkId(pathEl);
  const labels = [...svg.querySelectorAll('g.edgeLabel')];

  const byDataId = labels.find((el) => {
    const dataId = el.querySelector(':scope > g.label, g.label')?.getAttribute('data-id');
    return Boolean(dataId && dataId === linkId);
  });
  if (byDataId) return byDataId;

  return (
    labels.find((el) => {
      const cls = el.getAttribute('class') || '';
      return cls.includes(`LS-${startId}`) && cls.includes(`LE-${endId}`);
    }) || null
  );
}

function centerEdgeLabelContent(inner) {
  const measureEl = inner.querySelector('text') || inner;
  try {
    const box = measureEl.getBBox();
    if (box.width <= 0) return;

    const yMatch = /translate\([^,]+,\s*([-\d.]+)/.exec(inner.getAttribute('transform') || '');
    const offsetY = yMatch ? Number(yMatch[1]) : -10.25;
    setTranslate(inner, -box.x - box.width / 2, offsetY);
  } catch {
    // getBBox can fail before paint.
  }
}

function updateEdgeLabel(svg, startId, endId, pathEl, sourceRect, targetRect) {
  const label = findEdgeLabelForPath(svg, pathEl, startId, endId);
  if (!label) return;

  let rootMid = null;
  if (sourceRect && targetRect) {
    rootMid = {
      x: (sourceRect.cx + targetRect.cx) / 2,
      y: (sourceRect.cy + targetRect.cy) / 2,
    };
  }

  if (!rootMid && typeof pathEl.getPointAtLength === 'function') {
    const pathMid = pathEl.getPointAtLength(pathEl.getTotalLength() / 2);
    rootMid = toSvgRootPoint(svg, pathEl, pathMid.x, pathMid.y);
  }

  if (!rootMid) return;

  const inner = label.querySelector('g.label') || label.firstElementChild;
  if (!inner) return;

  const labelLayer = label.parentElement || svg;
  const anchor = fromSvgRootPoint(svg, labelLayer, rootMid.x, rootMid.y);
  setTranslate(label, anchor.x, anchor.y);
  centerEdgeLabelContent(inner);
}

function findClusterForNode(nodeId, diagramKey, positionables) {
  const membership = parseSubgraphMembership(diagramKey);
  for (const [clusterId, nodeIds] of membership) {
    if (nodeIds.includes(nodeId)) {
      return positionables.get(clusterId) || null;
    }
  }
  return null;
}

function readPositions(positionables) {
  const positions = {};
  positionables.forEach((el, id) => {
    const { x, y } = parseTranslate(el.getAttribute('transform'));
    positions[id] = { x: Math.round(x), y: Math.round(y) };
  });
  return positions;
}

function applyPositions(positionables, positions) {
  positionables.forEach((el, id) => {
    const pos = positions[id];
    if (!pos) return;
    setTranslate(el, pos.x, pos.y);
  });
}

let activeController = null;
let activeHistoryControls = null;
let subgraphHandlesEnabled = false;

const layoutHistoryByKey = new Map();

function getLayoutHistoryForDiagram(diagramKey) {
  const key = activeDiagramStorageId || `source:${structuralDiagramKey(diagramKey)}`;
  if (!layoutHistoryByKey.has(key)) {
    layoutHistoryByKey.set(key, createLayoutHistory(20));
  }
  return layoutHistoryByKey.get(key);
}

function captureLayoutSnapshot(positionables, canvasBounds) {
  return {
    byNode: readPositions(positionables),
    byCluster: readManualClusterRects(positionables),
    canvasBounds: canvasBounds ? { ...canvasBounds } : null,
  };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function restoreClusterFromDefaults(clusterEl) {
  const rect = clusterEl.querySelector(':scope > rect');
  if (!rect || !clusterEl.dataset.defaultRect) return;

  const defaults = JSON.parse(clusterEl.dataset.defaultRect);
  rect.setAttribute('x', defaults.x);
  rect.setAttribute('y', defaults.y);
  rect.setAttribute('width', defaults.width);
  rect.setAttribute('height', defaults.height);

  delete clusterEl.dataset.manualRect;
  removeClusterHandles(clusterEl);

  const label = clusterEl.querySelector('.cluster-label');
  if (label && clusterEl.dataset.defaultLabelTransform) {
    label.setAttribute('transform', clusterEl.dataset.defaultLabelTransform);
    label.querySelector(':scope > g')?.removeAttribute('transform');
  }
}

function applyLayoutSnapshot(svg, positionables, snapshot, diagramKey, edgeLayout) {
  applyPositions(positionables, snapshot.byNode || {});

  const clusterIds = [...positionables.entries()]
    .filter(([, el]) => el.classList.contains('cluster'))
    .map(([id]) => id);

  positionables.forEach((el, id) => {
    if (!el.classList.contains('cluster')) return;

    const bounds = snapshot.byCluster?.[id];
    if (bounds) {
      el.dataset.manualRect = '1';
      applyClusterRect(el, bounds);
      positionClusterLabel(el);
      syncClusterHandleVisibility(el);
      return;
    }

    if (el.dataset.manualRect) {
      restoreClusterFromDefaults(el);
    }
  });

  const clusterRects = snapshot.byCluster || {};
  setStoredPositions(diagramKey, snapshot.byNode || {}, [...positionables.keys()]);
  replaceStoredClusterRects(clusterRects, clusterIds);

  if (snapshot.canvasBounds) {
    setStoredCanvasBounds(diagramKey, snapshot.canvasBounds);
    applyCanvasToSvg(svg, snapshot.canvasBounds);
  }

  syncManualLayout(svg, positionables, edgeLayout, diagramKey);
  return snapshot.canvasBounds || null;
}

export function refreshLayoutHistoryButtons() {
  activeHistoryControls?.updateButtons?.();
}

export function undoLayoutChange() {
  return activeHistoryControls?.undo() ?? false;
}

export function redoLayoutChange() {
  return activeHistoryControls?.redo() ?? false;
}

export const LAYOUT_EDIT_MODES = {
  POSITION_BLOCKS: 'position-blocks',
  MOVE_SUBGRAPHS: 'move-subgraphs',
  RESIZE_SUBGRAPHS: 'resize-subgraphs',
  CANVAS_SIZE: 'canvas-size',
};

export function diagramHasStoredLayout(diagramKey) {
  if (!diagramKey || !supportsBlockPositioning(diagramKey)) return false;

  const nodeIds = extractPositionableIds(diagramKey);
  const membership = parseSubgraphMembership(diagramKey);
  const clusterIds = [...membership.keys()];
  const positionableIds = [...new Set([...nodeIds, ...clusterIds])];
  const stored = resolveStoredPositions(diagramKey, positionableIds);
  const storedClusters = resolveStoredClusterRects(diagramKey, clusterIds);
  const storedCanvas = resolveStoredCanvasBounds(diagramKey);

  return (
    Object.keys(stored).length > 0 ||
    Object.keys(storedClusters).length > 0 ||
    Boolean(storedCanvas)
  );
}

export function getDiagramCanvasBounds(diagramKey) {
  return resolveStoredCanvasBounds(diagramKey);
}

export function ensureDiagramCanvasBounds() {
  return activeController?.ensureCanvasBounds?.() ?? null;
}

export function recalculateDiagramCanvasBounds() {
  return activeController?.recalculateCanvas?.() ?? null;
}

export function updateNodePositioningEditMode(editMode) {
  activeController?.setEditMode?.(editMode);
}

export function getActivePositionables() {
  return activeController?.positionables || null;
}

export function teardownNodePositioning(options = {}) {
  if (!options.skipCapture) {
    captureSessionPositions(activeController?.positionables);
  }
  activeController?.destroy();
  activeController = null;
  activeHistoryControls = null;
  subgraphHandlesEnabled = false;
}

export function setupNodePositioning({
  previewWrap,
  svg,
  diagramKey,
  edgeLayout,
  editMode = null,
  panelEl,
  resetBtn,
  undoBtn,
  redoBtn,
  onLayoutChange,
  onRerender,
}) {
  if (activeController) {
    teardownNodePositioning({ skipCapture: true });
  }

  if (!svg || !supportsBlockPositioning(diagramKey) || !panelEl) {
    panelEl?.classList.add('hidden');
    previewWrap.removeAttribute('data-manual-positions');
    previewWrap.removeAttribute('data-move-subgraphs');
    previewWrap.removeAttribute('data-subgraph-resize');
    previewWrap.removeAttribute('data-canvas-size');
    previewWrap.removeAttribute('data-custom-layout');
    return null;
  }

  const positionables = collectPositionables(svg);
  if (positionables.size === 0) {
    panelEl.classList.add('hidden');
    return null;
  }

  const mermaidViewBoxBounds = boundsFromSvgViewBox(svg);
  const sourceChanged = hasSourceChangedSinceLayout(diagramKey);

  let currentEditMode = editMode;
  let canvasBounds = needsCanvasRecapture(diagramKey) ? null : resolveStoredCanvasBounds(diagramKey);
  let hasStoredLayout = false;

  if (sourceChanged) {
    const staleIds = [...positionables.keys()];
    const staleClusterIds = [...positionables.entries()]
      .filter(([, el]) => el.classList.contains('cluster'))
      .map(([id]) => id);
    clearStoredPositions(diagramKey, staleIds);
    clearStoredClusterRects(staleClusterIds);
  }

  function shouldClampToCanvas() {
    return Boolean(currentEditMode && currentEditMode !== LAYOUT_EDIT_MODES.CANVAS_SIZE);
  }

  function snapshotLayout() {
    return captureLayoutSnapshot(positionables, canvasBounds);
  }

  function applyEditModeState(nextEditMode) {
    currentEditMode = nextEditMode;
    subgraphHandlesEnabled = nextEditMode === LAYOUT_EDIT_MODES.RESIZE_SUBGRAPHS;

    previewWrap.removeAttribute('data-manual-positions');
    previewWrap.removeAttribute('data-move-subgraphs');
    previewWrap.removeAttribute('data-subgraph-resize');
    previewWrap.removeAttribute('data-canvas-size');

    if (nextEditMode === LAYOUT_EDIT_MODES.POSITION_BLOCKS) {
      previewWrap.dataset.manualPositions = 'true';
      panelEl.classList.remove('hidden');
    } else {
      panelEl.classList.add('hidden');
    }

    if (nextEditMode === LAYOUT_EDIT_MODES.MOVE_SUBGRAPHS) {
      previewWrap.dataset.moveSubgraphs = 'true';
    }

    if (nextEditMode === LAYOUT_EDIT_MODES.RESIZE_SUBGRAPHS) {
      previewWrap.dataset.subgraphResize = 'true';
    }

    if (nextEditMode === LAYOUT_EDIT_MODES.CANVAS_SIZE) {
      previewWrap.dataset.canvasSize = 'true';
    }

    if (canvasBounds) {
      previewWrap.dataset.customLayout = 'true';
      applyCanvasToSvg(svg, canvasBounds);
    } else {
      previewWrap.removeAttribute('data-custom-layout');
    }

    setCanvasHandlesInteractive(svg, nextEditMode === LAYOUT_EDIT_MODES.CANVAS_SIZE);

    positionables.forEach((el) => {
      if (el.classList.contains('cluster')) {
        syncClusterHandleVisibility(el);
      }
    });
  }

  storeClusterDefaults(svg);
  bindDiagramEdges(svg, positionables, diagramKey);

  positionables.forEach((el) => {
    const { x, y } = parseTranslate(el.getAttribute('transform'));
    el.dataset.defaultX = String(Math.round(x));
    el.dataset.defaultY = String(Math.round(y));
    el.classList.add('positionable-node');
  });

  const stored = resolveStoredPositions(diagramKey, [...positionables.keys()]);
  const clusterIds = [...positionables.entries()]
    .filter(([, el]) => el.classList.contains('cluster'))
    .map(([id]) => id);
  const storedClusters = resolveStoredClusterRects(diagramKey, clusterIds);
  const hasStoredPositions =
    Object.keys(stored).length > 0 || Object.keys(storedClusters).length > 0;

  if (Object.keys(stored).length > 0) {
    applyPositions(positionables, stored);
  }

  if (Object.keys(storedClusters).length > 0) {
    applyManualClusterRects(positionables, storedClusters);
  }

  // Initial canvas capture is deferred until after edge routing (see ensureDiagramCanvasBounds).

  hasStoredLayout = hasStoredPositions || Boolean(canvasBounds);

  if (canvasBounds) {
    applyCanvasToSvg(svg, canvasBounds);
  }

  applyEditModeState(currentEditMode);

  const layoutHistory = getLayoutHistoryForDiagram(diagramKey);

  let panelHistoryBefore = null;
  let panelHistoryTimer = null;

  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = !layoutHistory.canUndo();
    if (redoBtn) redoBtn.disabled = !layoutHistory.canRedo();
  }

  function commitLayoutChange(beforeSnapshot) {
    if (!beforeSnapshot) return;
    const after = snapshotLayout();
    if (snapshotsEqual(beforeSnapshot, after)) return;
    layoutHistory.pushBefore(beforeSnapshot);
    updateHistoryButtons();
  }

  function restoreFromHistory(targetSnapshot) {
    if (!targetSnapshot) return;
    const nextCanvas = applyLayoutSnapshot(svg, positionables, targetSnapshot, diagramKey, edgeLayout);
    if (nextCanvas) canvasBounds = nextCanvas;

    const finalizeRestore = () => {
      if (canvasBounds) applyCanvasToSvg(svg, canvasBounds);
      renderPanel();
      positionables.forEach((_, id) => syncFromNode(id));
      persistPositions();
      updateHistoryButtons();
    };

    requestAnimationFrame(finalizeRestore);
  }

  function performUndo() {
    if (!layoutHistory.canUndo()) return false;
    const current = snapshotLayout();
    const previous = layoutHistory.undo(current);
    restoreFromHistory(previous);
    return true;
  }

  function performRedo() {
    if (!layoutHistory.canRedo()) return false;
    const current = snapshotLayout();
    const next = layoutHistory.redo(current);
    restoreFromHistory(next);
    return true;
  }

  function onUndoClick() {
    performUndo();
  }

  function onRedoClick() {
    performRedo();
  }

  activeHistoryControls = {
    undo: performUndo,
    redo: performRedo,
    updateButtons: updateHistoryButtons,
  };
  updateHistoryButtons();

  const controller = {
    positionables,
    getCanvasBounds: () => (canvasBounds ? { ...canvasBounds } : null),
    ensureCanvasBounds() {
      if (canvasBounds) return canvasBounds;

      canvasBounds = captureInitialCanvasBounds(svg, mermaidViewBoxBounds);
      if (canvasBounds) {
        setStoredCanvasBounds(diagramKey, canvasBounds);
        applyCanvasToSvg(svg, canvasBounds);
        applyEditModeState(currentEditMode);
        hasStoredLayout = true;
        previewWrap.dataset.customLayout = 'true';
        persistPositions();
      }
      return canvasBounds;
    },
    recalculateCanvas() {
      const before = snapshotLayout();
      spreadFlowchartEdgeAnchors(svg, diagramKey, edgeLayout);
      canvasBounds = captureInitialCanvasBounds(svg, boundsFromSvgViewBox(svg));
      if (canvasBounds) {
        setStoredCanvasBounds(diagramKey, canvasBounds);
        applyCanvasToSvg(svg, canvasBounds);
        applyEditModeState(currentEditMode);
        rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
      }
      commitLayoutChange(before);
      persistPositions();
      return canvasBounds;
    },
    setEditMode(nextEditMode) {
      applyEditModeState(nextEditMode);
    },
    destroy() {
      cancelDragEdgeSync?.();
      clearTimeout(panelHistoryTimer);
      panelHistoryBefore = null;
      undoBtn?.removeEventListener('click', onUndoClick);
      redoBtn?.removeEventListener('click', onRedoClick);
      positionables.forEach((el) => {
        if (el.classList.contains('cluster')) removeClusterHandles(el);
      });
      removeCanvasOverlay(svg);
      previewWrap.removeAttribute('data-manual-positions');
      previewWrap.removeAttribute('data-move-subgraphs');
      previewWrap.removeAttribute('data-subgraph-resize');
      previewWrap.removeAttribute('data-canvas-size');
      previewWrap.removeAttribute('data-custom-layout');
      previewWrap.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      panelEl.removeEventListener('input', onPanelInput);
      resetBtn?.removeEventListener('click', onReset);
    },
  };

  let dragState = null;

  function persistPositions() {
    const positions = readPositions(positionables);
    setStoredPositions(diagramKey, positions, [...positionables.keys()]);

    const clusterIds = [...positionables.entries()]
      .filter(([, el]) => el.classList.contains('cluster'))
      .map(([id]) => id);
    const clusterRects = readManualClusterRects(positionables);
    replaceStoredClusterRects(clusterRects, clusterIds);
    if (canvasBounds) {
      setStoredCanvasBounds(diagramKey, canvasBounds);
    }

    hasStoredLayout = true;
    previewWrap.dataset.customLayout = 'true';

    onLayoutChange?.();
  }

  function syncClusterPanel(id) {
    const el = positionables.get(id);
    if (!el?.classList.contains('cluster')) return;

    const bounds = readClusterRect(el);
    const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
    if (!row || !bounds) return;

    const widthInput = row.querySelector('[data-axis="w"]');
    const heightInput = row.querySelector('[data-axis="h"]');
    if (widthInput) widthInput.value = String(Math.round(bounds.width));
    if (heightInput) heightInput.value = String(Math.round(bounds.height));
  }

  function syncFromNode(id) {
    const el = positionables.get(id);
    if (!el) return;

    if (el.classList.contains('cluster')) {
      syncClusterPanel(id);
      return;
    }

    const { x, y } = parseTranslate(el.getAttribute('transform'));
    const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.querySelector('[data-axis="x"]').value = String(Math.round(x));
    row.querySelector('[data-axis="y"]').value = String(Math.round(y));
  }

  function resizeCluster(id, width, height, options = {}) {
    const clusterEl = positionables.get(id);
    if (!clusterEl?.classList.contains('cluster')) return;

    const bounds = readClusterRect(clusterEl);
    if (!bounds) return;

    const before = options.skipHistory ? null : snapshotLayout();

    clusterEl.dataset.manualRect = '1';
    let nextBounds = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(CLUSTER_MIN_SIZE, width),
      height: Math.max(CLUSTER_MIN_SIZE, height),
    };
    if (shouldClampToCanvas()) {
      nextBounds = clampClusterRectToCanvas(nextBounds, canvasBounds);
    }
    applyClusterRect(clusterEl, nextBounds);
    positionClusterLabel(clusterEl);
    syncClusterHandleVisibility(clusterEl);
    syncManualLayout(svg, positionables, edgeLayout, diagramKey);
    syncClusterPanel(id);
    persistPositions();
    if (!options.skipHistory) commitLayoutChange(before);
  }

  function moveNode(id, x, y, options = {}) {
    const el = positionables.get(id);
    if (!el) return;

    const before = options.skipHistory ? null : snapshotLayout();
    const next = shouldClampToCanvas()
      ? clampNodeTranslateToCanvas(svg, el, x, y, canvasBounds)
      : { x, y };
    setTranslate(el, next.x, next.y);
    syncManualLayout(svg, positionables, edgeLayout, diagramKey);
    syncFromNode(id);
    persistPositions();
    if (!options.skipHistory) commitLayoutChange(before);
  }

  function onPanelInput(event) {
    const input = event.target.closest('input[data-axis]');
    if (!input) return;
    const id = input.dataset.nodeId;
    const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
    if (!row) return;

    if (!panelHistoryBefore) {
      panelHistoryBefore = snapshotLayout();
    }

    const el = positionables.get(id);
    if (el?.classList.contains('cluster')) {
      const width = Number(row.querySelector('[data-axis="w"]')?.value);
      const height = Number(row.querySelector('[data-axis="h"]')?.value);
      if (Number.isFinite(width) && Number.isFinite(height)) {
        resizeCluster(id, width, height, { skipHistory: true });
      }
    } else {
      const x = Number(row.querySelector('[data-axis="x"]').value);
      const y = Number(row.querySelector('[data-axis="y"]').value);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        moveNode(id, x, y, { skipHistory: true });
      }
    }

    clearTimeout(panelHistoryTimer);
    panelHistoryTimer = setTimeout(() => {
      commitLayoutChange(panelHistoryBefore);
      panelHistoryBefore = null;
    }, 400);
  }

  function onReset() {
    const before = snapshotLayout();
    layoutHistory.pushBefore(before);
    updateHistoryButtons();

    const clusterIds = [...positionables.entries()]
      .filter(([, el]) => el.classList.contains('cluster'))
      .map(([id]) => id);

    clearStoredPositions(diagramKey, [...positionables.keys()]);
    clearStoredClusterRects(clusterIds);
    clearStoredCanvasBounds(diagramKey);
    void onRerender?.();
  }

  function renderPanel() {
    const rows = [...positionables.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, el]) => {
        if (el.classList.contains('cluster')) {
          const bounds = readClusterRect(el);
          const width = Math.round(bounds?.width ?? 0);
          const height = Math.round(bounds?.height ?? 0);
          return `
            <div class="position-row position-row-cluster" data-node-id="${id}">
              <label class="position-node-id" for="pos-${id}-w">${id}</label>
              <input type="number" id="pos-${id}-w" data-node-id="${id}" data-axis="w" value="${width}" step="1" min="${CLUSTER_MIN_SIZE}" title="Subgraph width" />
              <input type="number" id="pos-${id}-h" data-node-id="${id}" data-axis="h" value="${height}" step="1" min="${CLUSTER_MIN_SIZE}" title="Subgraph height" />
            </div>
          `;
        }

        const { x, y } = parseTranslate(el.getAttribute('transform'));
        const defaultX = Number(el.dataset.defaultX ?? x);
        const defaultY = Number(el.dataset.defaultY ?? y);
        return `
          <div class="position-row" data-node-id="${id}" data-default-x="${defaultX}" data-default-y="${defaultY}">
            <label class="position-node-id" for="pos-${id}-x">${id}</label>
            <input type="number" id="pos-${id}-x" data-node-id="${id}" data-axis="x" value="${Math.round(x)}" step="1" title="X position" />
            <input type="number" id="pos-${id}-y" data-node-id="${id}" data-axis="y" value="${Math.round(y)}" step="1" title="Y position" />
          </div>
        `;
      })
      .join('');

    panelEl.querySelector('.position-rows').innerHTML = rows || '<p class="position-empty">No blocks found.</p>';
  }

  renderPanel();

  let dragEdgeSyncFrame = null;

  function scheduleDragEdgeSync() {
    if (dragEdgeSyncFrame != null) return;
    dragEdgeSyncFrame = requestAnimationFrame(() => {
      dragEdgeSyncFrame = null;
      const svgEl = previewWrap.querySelector('svg');
      if (!svgEl) return;
      rerouteFlowchartEdges(svgEl, positionables, edgeLayout, diagramKey);
    });
  }

  function cancelDragEdgeSync() {
    if (dragEdgeSyncFrame == null) return;
    cancelAnimationFrame(dragEdgeSyncFrame);
    dragEdgeSyncFrame = null;
  }

  function onPointerDown(event) {
    if (!currentEditMode) return;

    const canvasHandle = event.target.closest('.canvas-resize-handle');
    if (canvasHandle) {
      if (currentEditMode !== LAYOUT_EDIT_MODES.CANVAS_SIZE || !canvasBounds) return;

      event.preventDefault();
      event.stopPropagation();

      const svgEl = previewWrap.querySelector('svg');
      const point = clientToSvg(svgEl, event.clientX, event.clientY);
      if (!point) return;

      dragState = {
        mode: 'resize-canvas',
        handle: canvasHandle.dataset.handle,
        startBounds: { ...canvasBounds },
        startPointer: { x: point.x, y: point.y },
        historyBefore: snapshotLayout(),
      };

      previewWrap.setPointerCapture?.(event.pointerId);
      return;
    }

    const handle = event.target.closest('.cluster-resize-handle');
    if (handle) {
      if (currentEditMode !== LAYOUT_EDIT_MODES.RESIZE_SUBGRAPHS) return;

      const clusterEl = handle.closest('g.cluster');
      const id = getLogicalNodeId(clusterEl);
      if (!clusterEl || !positionables.has(id)) return;

      event.preventDefault();
      event.stopPropagation();

      const svgEl = previewWrap.querySelector('svg');
      const point = clientToSvg(svgEl, event.clientX, event.clientY);
      if (!point) return;

      const startRect = readClusterRect(clusterEl);
      if (!startRect) return;

      dragState = {
        mode: 'resize-cluster',
        clusterId: id,
        clusterEl,
        handle: handle.dataset.handle,
        startRect,
        startPointer: { x: point.x, y: point.y },
        historyBefore: snapshotLayout(),
      };

      clusterEl.classList.add('is-resizing');
      previewWrap.setPointerCapture?.(event.pointerId);
      return;
    }

    if (
      currentEditMode === LAYOUT_EDIT_MODES.RESIZE_SUBGRAPHS ||
      currentEditMode === LAYOUT_EDIT_MODES.CANVAS_SIZE
    ) {
      return;
    }

    let target = event.target.closest('g.node, g.cluster');
    if (!target || !previewWrap.contains(target)) return;
    if (event.target.closest('.cluster-handles')) return;

    let id = getLogicalNodeId(target);
    if (!positionables.has(id)) return;

    event.preventDefault();
    const svgEl = previewWrap.querySelector('svg');
    const point = clientToSvg(svgEl, event.clientX, event.clientY);
    if (!point) return;

    if (currentEditMode === LAYOUT_EDIT_MODES.MOVE_SUBGRAPHS) {
      if (target.classList.contains('node')) {
        const clusterEl = findClusterForNode(id, diagramKey, positionables);
        if (!clusterEl) return;
        target = clusterEl;
        id = getLogicalNodeId(target);
      } else if (!target.classList.contains('cluster')) {
        return;
      }

      const startRect = readClusterRect(target);
      if (!startRect) return;

      dragState = {
        mode: 'move-cluster',
        clusterId: id,
        clusterEl: target,
        startRect,
        startPointer: { x: point.x, y: point.y },
        historyBefore: snapshotLayout(),
      };

      target.classList.add('is-dragging');
      previewWrap.setPointerCapture?.(event.pointerId);
      return;
    }

    if (currentEditMode === LAYOUT_EDIT_MODES.POSITION_BLOCKS) {
      if (!target.classList.contains('node')) return;

      dragState = {
        mode: 'move',
        primaryId: id,
        startPointer: { x: point.x, y: point.y },
        historyBefore: snapshotLayout(),
        bundled: [[id, target]].map(([nodeId, el]) => ({
          id: nodeId,
          el,
          parent: el.parentElement,
          startTranslate: parseTranslate(el.getAttribute('transform')),
        })),
      };

      target.classList.add('is-dragging');
      previewWrap.setPointerCapture?.(event.pointerId);
    }
  }

  function onPointerMove(event) {
    if (!dragState) return;
    event.preventDefault();

    const svgEl = previewWrap.querySelector('svg');
    const point = clientToSvg(svgEl, event.clientX, event.clientY);
    if (!point) return;

    if (dragState.mode === 'resize-canvas') {
      const deltaX = point.x - dragState.startPointer.x;
      const deltaY = point.y - dragState.startPointer.y;
      canvasBounds = computeResizedCanvasBounds(
        dragState.startBounds,
        dragState.handle,
        deltaX,
        deltaY,
      );
      applyCanvasToSvg(svgEl, canvasBounds);
      return;
    }

    if (dragState.mode === 'resize-cluster') {
      const localPoint = rootToParentLocal(svgEl, dragState.clusterEl, point.x, point.y);
      const localStart = rootToParentLocal(
        svgEl,
        dragState.clusterEl,
        dragState.startPointer.x,
        dragState.startPointer.y,
      );
      const dx = localPoint.x - localStart.x;
      const dy = localPoint.y - localStart.y;
      let nextRect = computeResizedClusterRect(dragState.startRect, dragState.handle, dx, dy);
      if (shouldClampToCanvas()) {
        nextRect = clampClusterRectToCanvas(nextRect, canvasBounds);
      }

      dragState.clusterEl.dataset.manualRect = '1';
      applyClusterRect(dragState.clusterEl, nextRect);
      positionClusterLabel(dragState.clusterEl);
      updateClusterHandles(dragState.clusterEl);
      return;
    }

    const deltaX = point.x - dragState.startPointer.x;
    const deltaY = point.y - dragState.startPointer.y;

    if (dragState.mode === 'move-cluster') {
      const origin = rootToParentLocal(svgEl, dragState.clusterEl, 0, 0);
      const shifted = rootToParentLocal(svgEl, dragState.clusterEl, deltaX, deltaY);
      const dx = shifted.x - origin.x;
      const dy = shifted.y - origin.y;
      let nextRect = {
        x: dragState.startRect.x + dx,
        y: dragState.startRect.y + dy,
        width: dragState.startRect.width,
        height: dragState.startRect.height,
      };
      if (shouldClampToCanvas()) {
        nextRect = clampClusterRectToCanvas(nextRect, canvasBounds);
      }
      dragState.clusterEl.dataset.manualRect = '1';
      applyClusterRect(dragState.clusterEl, nextRect);
      positionClusterLabel(dragState.clusterEl);
      updateClusterHandles(dragState.clusterEl);
      return;
    }

    dragState.bundled.forEach((item) => {
      const delta = rootDeltaToParent(svgEl, item.parent, deltaX, deltaY);
      let nextX = item.startTranslate.x + delta.dx;
      let nextY = item.startTranslate.y + delta.dy;
      if (shouldClampToCanvas()) {
        ({ x: nextX, y: nextY } = clampNodeTranslateToCanvas(
          svgEl,
          item.el,
          nextX,
          nextY,
          canvasBounds,
        ));
      }
      setTranslate(item.el, nextX, nextY);
    });

    scheduleDragEdgeSync();
  }

  function onPointerUp(event) {
    if (!dragState) return;

    const finishedDrag = dragState;
    cancelDragEdgeSync();
    previewWrap.querySelector('.is-dragging')?.classList.remove('is-dragging');
    previewWrap.querySelector('.is-resizing')?.classList.remove('is-resizing');
    dragState = null;

    const svgEl = previewWrap.querySelector('svg');
    if (svgEl && finishedDrag.mode === 'move') {
      syncManualLayout(svgEl, positionables, edgeLayout, diagramKey);
    }

    if (finishedDrag.mode === 'move') {
      finishedDrag.bundled.forEach((item) => syncFromNode(item.id));
    } else if (finishedDrag.mode === 'resize-cluster') {
      syncClusterPanel(finishedDrag.clusterId);
    }

    commitLayoutChange(finishedDrag.historyBefore);

    persistPositions();
    previewWrap.releasePointerCapture?.(event.pointerId);
  }

  panelEl.addEventListener('input', onPanelInput);
  resetBtn?.addEventListener('click', onReset);
  undoBtn?.addEventListener('click', onUndoClick);
  redoBtn?.addEventListener('click', onRedoClick);
  previewWrap.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  activeController = controller;
  return controller;
}
