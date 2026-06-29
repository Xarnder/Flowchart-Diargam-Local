import { EDGE_LAYOUTS, isFlowchartDiagram, parseFlowchartEdges } from './edgeStyling.js';

const POSITIONS_STORAGE_KEY = 'mermaid-studio-node-positions';
const CLUSTER_PADDING = 12;
const VIEWBOX_PADDING = 24;

/** In-memory positions survive source re-renders within the same browser session. */
const sessionPositions = {};

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

    const label = clusterEl.querySelector('.cluster-label');
    if (label && clusterEl.dataset.defaultLabelTransform) {
      label.setAttribute('transform', clusterEl.dataset.defaultLabelTransform);
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

  const label = clusterEl.querySelector('.cluster-label');
  if (label) {
    setTranslate(label, topLeft.x + width / 2, topLeft.y);
  }
}

function resizeSubgraphContainers(svg, positionables, diagramKey) {
  const membership = parseSubgraphMembership(diagramKey);
  membership.forEach((nodeIds, clusterId) => {
    const clusterEl = positionables.get(clusterId);
    if (!clusterEl?.classList.contains('cluster')) return;
    resizeClusterToFitNodes(svg, clusterEl, nodeIds, positionables);
  });
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

function syncManualLayout(svg, positionables, edgeLayout, diagramKey) {
  resizeSubgraphContainers(svg, positionables, diagramKey);
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

export function teardownNodePositioning() {
  captureSessionPositions(activeController?.positionables);
  activeController?.destroy();
  activeController = null;
}

export function setupNodePositioning({
  previewWrap,
  svg,
  diagramKey,
  edgeLayout,
  enabled,
  panelEl,
  resetBtn,
}) {
  teardownNodePositioning();

  if (!enabled || !svg || !isFlowchartDiagram(diagramKey) || !panelEl) {
    panelEl?.classList.add('hidden');
    return null;
  }

  const positionables = collectPositionables(svg);
  if (positionables.size === 0) {
    panelEl.classList.add('hidden');
    return null;
  }

  panelEl.classList.remove('hidden');
  previewWrap.dataset.manualPositions = 'true';

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
      previewWrap.removeAttribute('data-manual-positions');
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
  }

  function syncFromNode(id) {
    const el = positionables.get(id);
    if (!el) return;
    const { x, y } = parseTranslate(el.getAttribute('transform'));
    const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.querySelector('[data-axis="x"]').value = String(Math.round(x));
    row.querySelector('[data-axis="y"]').value = String(Math.round(y));
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
    const x = Number(row.querySelector('[data-axis="x"]').value);
    const y = Number(row.querySelector('[data-axis="y"]').value);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      moveNode(id, x, y);
    }
  }

  function onReset() {
    clearStoredPositions(diagramKey, [...positionables.keys()]);
    restoreClusterDefaults(svg);
    positionables.forEach((el, id) => {
      const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
      if (!row) return;
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
    const target = event.target.closest('g.node, g.cluster');
    if (!target || !previewWrap.contains(target)) return;

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
    const dragging = previewWrap.querySelector('.is-dragging');
    dragging?.classList.remove('is-dragging');
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
