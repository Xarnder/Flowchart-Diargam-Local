import { EDGE_LAYOUTS, isFlowchartDiagram, parseFlowchartEdges } from './edgeStyling.js';

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

const RESERVED_IDS = new Set(['subgraph', 'end', 'graph', 'flowchart', 'tb', 'td', 'lr', 'rl', 'bt']);

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function parseTranslate(transform) {
  const match = /translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/.exec(transform || '');
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2] ?? 0) : 0,
  };
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

function getNodeBoundsInClusterSpace(svg, clusterEl, nodeIds, positionables) {
  let bounds = null;

  for (const id of nodeIds) {
    const nodeEl = positionables.get(id);
    if (!nodeEl?.classList.contains('node')) continue;

    const nodeRect = getAbsoluteRect(nodeEl);
    const topLeft = fromSvgRootPoint(svg, clusterEl, nodeRect.x, nodeRect.y);
    const bottomRight = fromSvgRootPoint(
      svg,
      clusterEl,
      nodeRect.x + nodeRect.width,
      nodeRect.y + nodeRect.height,
    );

    bounds = mergeBounds(bounds, {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    });
  }

  if (!bounds) return null;

  return {
    x: bounds.minX - CLUSTER_PADDING,
    y: bounds.minY - CLUSTER_PADDING,
    width: bounds.maxX - bounds.minX + CLUSTER_PADDING * 2,
    height: bounds.maxY - bounds.minY + CLUSTER_PADDING * 2,
  };
}

function unionClusterRect(manualRect, nodeRect) {
  if (!nodeRect) return manualRect;

  const minX = Math.min(manualRect.x, nodeRect.x);
  const minY = Math.min(manualRect.y, nodeRect.y);
  const maxX = Math.max(manualRect.x + manualRect.width, nodeRect.x + nodeRect.width);
  const maxY = Math.max(manualRect.y + manualRect.height, nodeRect.y + nodeRect.height);

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, CLUSTER_MIN_SIZE),
    height: Math.max(maxY - minY, CLUSTER_MIN_SIZE),
  };
}

export function getLogicalNodeId(el) {
  const id = el.id || el.getAttribute('data-id') || '';
  if (!id) return '';

  // Mermaid nodes: mermaid-graph-2-flowchart-U-0
  const flowchartMatch = /flowchart-(.+)-\d+$/.exec(id);
  if (flowchartMatch) return flowchartMatch[1];

  // Mermaid subgraphs: mermaid-graph-2-Current
  const subgraphMatch = /^mermaid-graph-\d+-(.+)$/.exec(id);
  if (subgraphMatch && !id.includes('flowchart-')) {
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

    for (const match of trimmed.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[|\(|\{)/g)) {
      if (!RESERVED_IDS.has(match[1].toLowerCase())) {
        ids.add(match[1]);
      }
    }

    const edgeParts = trimmed.split(/(?:-->|---|===|-.->|<-->|--o|--x)/);
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
  const store = loadAllPositions();
  if (!store.byCluster) store.byCluster = {};

  for (const [id, bounds] of Object.entries(rects)) {
    store.byCluster[id] = bounds;
    sessionClusterRects[id] = bounds;
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

function loadAllPositions() {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveAllPositions(store) {
  localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(store));
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

function resizeClusterToFitNodes(svg, clusterEl, nodeIds, positionables) {
  const rect = clusterEl.querySelector(':scope > rect');
  if (!rect || nodeIds.length === 0) return;

  let bounds = null;
  for (const id of nodeIds) {
    const nodeEl = positionables.get(id);
    if (!nodeEl?.classList.contains('node')) continue;
    bounds = mergeBounds(bounds, getAbsoluteRect(nodeEl));
  }

  if (!bounds) return;

  bounds.minX -= CLUSTER_PADDING;
  bounds.minY -= CLUSTER_PADDING;
  bounds.maxX += CLUSTER_PADDING;
  bounds.maxY += CLUSTER_PADDING;

  if (clusterEl.dataset.defaultRect) {
    const defaults = JSON.parse(clusterEl.dataset.defaultRect);
    const defaultTopLeft = toSvgRootPoint(svg, clusterEl, Number(defaults.x), Number(defaults.y));
    const defaultBottomRight = toSvgRootPoint(
      svg,
      clusterEl,
      Number(defaults.x) + Number(defaults.width),
      Number(defaults.y) + Number(defaults.height),
    );
    bounds = mergeBounds(bounds, {
      x: defaultTopLeft.x,
      y: defaultTopLeft.y,
      width: defaultBottomRight.x - defaultTopLeft.x,
      height: defaultBottomRight.y - defaultTopLeft.y,
    });
  }

  const topLeft = fromSvgRootPoint(svg, clusterEl, bounds.minX, bounds.minY);
  const bottomRight = fromSvgRootPoint(svg, clusterEl, bounds.maxX, bounds.maxY);
  const width = Math.max(bottomRight.x - topLeft.x, 1);
  const height = Math.max(bottomRight.y - topLeft.y, 1);

  rect.setAttribute('x', String(topLeft.x));
  rect.setAttribute('y', String(topLeft.y));
  rect.setAttribute('width', String(width));
  rect.setAttribute('height', String(height));

  positionClusterLabel(clusterEl);
}

function applyClusterLayout(
  svg,
  clusterEl,
  clusterId,
  nodeIds,
  positionables,
  manualRect,
) {
  if (manualRect) {
    const nodeBounds = getNodeBoundsInClusterSpace(svg, clusterEl, nodeIds, positionables);
    applyClusterRect(clusterEl, unionClusterRect(manualRect, nodeBounds));
  } else {
    resizeClusterToFitNodes(svg, clusterEl, nodeIds, positionables);
  }

  positionClusterLabel(clusterEl);
  syncClusterHandleVisibility(clusterEl);
}

function syncSubgraphContainers(svg, positionables, diagramKey) {
  const membership = parseSubgraphMembership(diagramKey);
  const storedRects = resolveStoredClusterRects(diagramKey, [...membership.keys()]);

  membership.forEach((nodeIds, clusterId) => {
    const clusterEl = positionables.get(clusterId);
    if (!clusterEl?.classList.contains('cluster')) return;

    const manualRect = storedRects[clusterId];
    if (manualRect) {
      clusterEl.dataset.manualRect = '1';
    }

    applyClusterLayout(svg, clusterEl, clusterId, nodeIds, positionables, manualRect);
  });
}

function resizeSubgraphContainers(svg, positionables, diagramKey) {
  syncSubgraphContainers(svg, positionables, diagramKey);
}

function expandSvgViewBox(svg) {
  let bounds = null;

  svg.querySelectorAll('g.node').forEach((el) => {
    bounds = mergeBounds(bounds, getAbsoluteRect(el));
  });

  svg.querySelectorAll('g.cluster > rect').forEach((rect) => {
    bounds = mergeBounds(bounds, getAbsoluteRect(rect));
  });

  svg.querySelectorAll('path.flowchart-link').forEach((pathEl) => {
    bounds = mergeBounds(bounds, getPathAbsoluteRect(pathEl));
  });

  if (!bounds) return;

  const x = bounds.minX - VIEWBOX_PADDING;
  const y = bounds.minY - VIEWBOX_PADDING;
  const width = bounds.maxX - bounds.minX + VIEWBOX_PADDING * 2;
  const height = bounds.maxY - bounds.minY + VIEWBOX_PADDING * 2;

  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
}

function syncManualLayout(svg, positionables, edgeLayout, diagramKey, options = {}) {
  if (!options.skipClusterSync) {
    syncSubgraphContainers(svg, positionables, diagramKey);
  }
  rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
  expandSvgViewBox(svg);
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

function buildEdgePath(start, end, edgeLayout) {
  if (edgeLayout === EDGE_LAYOUTS.straight) {
    const midX = (start.x + end.x) / 2;
    return `M${start.x},${start.y}L${midX},${start.y}L${midX},${end.y}L${end.x},${end.y}`;
  }

  const midY = (start.y + end.y) / 2;
  return `M${start.x},${start.y}C${start.x},${midY} ${end.x},${midY} ${end.x},${end.y}`;
}

export function rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey = '') {
  if (!svg || positionables.size === 0) return;

  const paths = [...svg.querySelectorAll('path.flowchart-link')];
  const needsBinding = paths.some((pathEl) => !pathEl.dataset.edgeStart || !pathEl.dataset.edgeEnd);
  if (needsBinding && diagramKey) {
    bindFlowchartEdges(svg, positionables, diagramKey);
  }

  paths.forEach((pathEl) => {
    const startId = pathEl.dataset.edgeStart;
    const endId = pathEl.dataset.edgeEnd;
    if (!startId || !endId) return;

    const sourceEl = positionables.get(startId);
    const targetEl = positionables.get(endId);
    if (!sourceEl || !targetEl) return;

    const sourceRect = getAbsoluteRect(sourceEl);
    const targetRect = getAbsoluteRect(targetEl);
    const startPoint = getBorderPoint(sourceRect, targetRect.cx, targetRect.cy);
    const endPoint = getBorderPoint(targetRect, sourceRect.cx, sourceRect.cy);
    const localStart = fromSvgRootPoint(svg, pathEl, startPoint.x, startPoint.y);
    const localEnd = fromSvgRootPoint(svg, pathEl, endPoint.x, endPoint.y);

    pathEl.removeAttribute('transform');
    pathEl.style.transform = '';
    pathEl.setAttribute('d', buildEdgePath(localStart, localEnd, edgeLayout));
    updateEdgeLabel(svg, startId, endId, pathEl);
  });
}

function updateEdgeLabel(svg, startId, endId, pathEl) {
  const labels = [...svg.querySelectorAll('g.edgeLabel')];
  const label = labels.find((el) => {
    const cls = el.getAttribute('class') || '';
    return cls.includes(`LS-${startId}`) && cls.includes(`LE-${endId}`);
  });
  if (!label || typeof pathEl.getPointAtLength !== 'function') return;

  const pathMid = pathEl.getPointAtLength(pathEl.getTotalLength() / 2);
  const rootMid = toSvgRootPoint(svg, pathEl, pathMid.x, pathMid.y);
  const inner = label.querySelector('g.label') || label.firstElementChild;
  if (!inner) return;

  const box = inner.getBBox();
  const labelPoint = fromSvgRootPoint(svg, inner, rootMid.x, rootMid.y);
  setTranslate(inner, labelPoint.x - box.width / 2, labelPoint.y - box.height / 2);
}

function getNodesInCluster(clusterEl, positionables) {
  const clusterRect = getAbsoluteRect(clusterEl);
  return [...positionables.entries()]
    .filter(([, el]) => el.classList.contains('node'))
    .filter(([, nodeEl]) => {
      const nodeRect = getAbsoluteRect(nodeEl);
      return (
        nodeRect.cx >= clusterRect.x &&
        nodeRect.cx <= clusterRect.x + clusterRect.width &&
        nodeRect.cy >= clusterRect.y &&
        nodeRect.cy <= clusterRect.y + clusterRect.height
      );
    });
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
let subgraphHandlesEnabled = false;

export function teardownNodePositioning() {
  captureSessionPositions(activeController?.positionables);
  activeController?.destroy();
  activeController = null;
  subgraphHandlesEnabled = false;
}

export function setupNodePositioning({
  previewWrap,
  svg,
  diagramKey,
  edgeLayout,
  enabled,
  showSubgraphHandles = false,
  panelEl,
  resetBtn,
}) {
  teardownNodePositioning();

  if (!enabled || !svg || !isFlowchartDiagram(diagramKey) || !panelEl) {
    panelEl?.classList.add('hidden');
    previewWrap.removeAttribute('data-manual-positions');
    previewWrap.removeAttribute('data-subgraph-resize');
    return null;
  }

  subgraphHandlesEnabled = Boolean(showSubgraphHandles);

  const positionables = collectPositionables(svg);
  if (positionables.size === 0) {
    panelEl.classList.add('hidden');
    return null;
  }

  panelEl.classList.remove('hidden');
  previewWrap.dataset.manualPositions = 'true';
  if (showSubgraphHandles) {
    previewWrap.dataset.subgraphResize = 'true';
  } else {
    previewWrap.removeAttribute('data-subgraph-resize');
  }

  storeClusterDefaults(svg);
  bindFlowchartEdges(svg, positionables, diagramKey);

  positionables.forEach((el) => {
    const { x, y } = parseTranslate(el.getAttribute('transform'));
    el.dataset.defaultX = String(Math.round(x));
    el.dataset.defaultY = String(Math.round(y));
    el.classList.add('positionable-node');
  });

  const stored = resolveStoredPositions(diagramKey, [...positionables.keys()]);
  if (Object.keys(stored).length > 0) {
    applyPositions(positionables, stored);
  }

  syncManualLayout(svg, positionables, edgeLayout, diagramKey);

  const controller = {
    positionables,
    destroy() {
      positionables.forEach((el) => {
        if (el.classList.contains('cluster')) removeClusterHandles(el);
      });
      previewWrap.removeAttribute('data-manual-positions');
      previewWrap.removeAttribute('data-subgraph-resize');
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

    const clusterRects = readManualClusterRects(positionables);
    if (Object.keys(clusterRects).length > 0) {
      setStoredClusterRects(diagramKey, clusterRects);
    }
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

  function resizeCluster(id, width, height) {
    const clusterEl = positionables.get(id);
    if (!clusterEl?.classList.contains('cluster')) return;

    const bounds = readClusterRect(clusterEl);
    if (!bounds) return;

    clusterEl.dataset.manualRect = '1';
    applyClusterRect(clusterEl, {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(CLUSTER_MIN_SIZE, width),
      height: Math.max(CLUSTER_MIN_SIZE, height),
    });
    positionClusterLabel(clusterEl);
    syncClusterHandleVisibility(clusterEl);
    syncManualLayout(svg, positionables, edgeLayout, diagramKey, { skipClusterSync: true });
    syncClusterPanel(id);
    persistPositions();
  }

  function moveNode(id, x, y) {
    const el = positionables.get(id);
    if (!el) return;
    setTranslate(el, x, y);
    syncManualLayout(svg, positionables, edgeLayout, diagramKey);
    syncFromNode(id);
    persistPositions();
  }

  function onPanelInput(event) {
    const input = event.target.closest('input[data-axis]');
    if (!input) return;
    const id = input.dataset.nodeId;
    const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
    if (!row) return;

    const el = positionables.get(id);
    if (el?.classList.contains('cluster')) {
      const width = Number(row.querySelector('[data-axis="w"]')?.value);
      const height = Number(row.querySelector('[data-axis="h"]')?.value);
      if (Number.isFinite(width) && Number.isFinite(height)) {
        resizeCluster(id, width, height);
      }
      return;
    }

    const x = Number(row.querySelector('[data-axis="x"]').value);
    const y = Number(row.querySelector('[data-axis="y"]').value);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      moveNode(id, x, y);
    }
  }

  function onReset() {
    const clusterIds = [...positionables.entries()]
      .filter(([, el]) => el.classList.contains('cluster'))
      .map(([id]) => id);

    clearStoredPositions(diagramKey, [...positionables.keys()]);
    clearStoredClusterRects(clusterIds);
    restoreClusterDefaults(svg);
    positionables.forEach((el, id) => {
      delete el.dataset.manualRect;
      const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
      if (!row) return;
      if (el.classList.contains('cluster')) return;
      const x = Number(row.dataset.defaultX);
      const y = Number(row.dataset.defaultY);
      setTranslate(el, x, y);
    });
    syncManualLayout(svg, positionables, edgeLayout, diagramKey);
    renderPanel();
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

  function onPointerDown(event) {
    const handle = event.target.closest('.cluster-resize-handle');
    if (handle) {
      const clusterEl = handle.closest('g.cluster');
      const id = getLogicalNodeId(clusterEl);
      if (!clusterEl || !positionables.has(id)) return;

      event.preventDefault();
      event.stopPropagation();

      const svgEl = previewWrap.querySelector('svg');
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return;

      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      const startRect = readClusterRect(clusterEl);
      if (!startRect) return;

      dragState = {
        mode: 'resize-cluster',
        clusterId: id,
        clusterEl,
        handle: handle.dataset.handle,
        startRect,
        startPoint: { x: point.x, y: point.y },
      };

      clusterEl.classList.add('is-resizing');
      previewWrap.setPointerCapture?.(event.pointerId);
      return;
    }

    const target = event.target.closest('g.node, g.cluster');
    if (!target || !previewWrap.contains(target)) return;
    if (event.target.closest('.cluster-handles')) return;

    const id = getLogicalNodeId(target);
    if (!positionables.has(id)) return;

    event.preventDefault();
    const svgEl = previewWrap.querySelector('svg');
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;

    const start = parseTranslate(target.getAttribute('transform'));
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    const bundled =
      target.classList.contains('cluster') ? getNodesInCluster(target, positionables) : [[id, target]];

    dragState = {
      mode: 'move',
      primaryId: id,
      bundled: bundled.map(([nodeId, el]) => ({
        id: nodeId,
        el,
        startX: parseTranslate(el.getAttribute('transform')).x,
        startY: parseTranslate(el.getAttribute('transform')).y,
      })),
      offsetX: point.x - start.x,
      offsetY: point.y - start.y,
    };

    target.classList.add('is-dragging');
    previewWrap.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!dragState) return;
    event.preventDefault();

    const svgEl = previewWrap.querySelector('svg');
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;

    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());

    if (dragState.mode === 'resize-cluster') {
      const localPoint = fromSvgRootPoint(svg, dragState.clusterEl, point.x, point.y);
      const localStart = fromSvgRootPoint(
        svg,
        dragState.clusterEl,
        dragState.startPoint.x,
        dragState.startPoint.y,
      );
      const dx = localPoint.x - localStart.x;
      const dy = localPoint.y - localStart.y;
      const nextRect = computeResizedClusterRect(dragState.startRect, dragState.handle, dx, dy);

      dragState.clusterEl.dataset.manualRect = '1';
      applyClusterRect(dragState.clusterEl, nextRect);
      positionClusterLabel(dragState.clusterEl);
      updateClusterHandles(dragState.clusterEl);
      syncClusterPanel(dragState.clusterId);
      syncManualLayout(svg, positionables, edgeLayout, diagramKey, { skipClusterSync: true });
      return;
    }

    const nextX = point.x - dragState.offsetX;
    const nextY = point.y - dragState.offsetY;
    const primary = dragState.bundled.find((item) => item.id === dragState.primaryId);
    if (!primary) return;

    const deltaX = nextX - primary.startX;
    const deltaY = nextY - primary.startY;

    dragState.bundled.forEach((item) => {
      setTranslate(item.el, item.startX + deltaX, item.startY + deltaY);
      syncFromNode(item.id);
    });

    syncManualLayout(svg, positionables, edgeLayout, diagramKey);
  }

  function onPointerUp(event) {
    if (!dragState) return;
    previewWrap.querySelector('.is-dragging')?.classList.remove('is-dragging');
    previewWrap.querySelector('.is-resizing')?.classList.remove('is-resizing');
    dragState = null;
    persistPositions();
    previewWrap.releasePointerCapture?.(event.pointerId);
  }

  panelEl.addEventListener('input', onPanelInput);
  resetBtn?.addEventListener('click', onReset);
  previewWrap.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  activeController = controller;
  return controller;
}
