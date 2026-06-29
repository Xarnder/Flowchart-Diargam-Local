import { EDGE_LAYOUTS, isFlowchartDiagram, parseFlowchartEdges } from './edgeStyling.js';

const POSITIONS_STORAGE_KEY = 'mermaid-studio-node-positions';

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

function getStoredPositions(diagramKey) {
  const store = loadAllPositions();
  return store[hashString(diagramKey)] || {};
}

function setStoredPositions(diagramKey, positions) {
  const store = loadAllPositions();
  const key = hashString(diagramKey);
  if (Object.keys(positions).length === 0) {
    delete store[key];
  } else {
    store[key] = positions;
  }
  saveAllPositions(store);
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

  bindFlowchartEdges(svg, positionables, diagramKey);

  positionables.forEach((el) => {
    const { x, y } = parseTranslate(el.getAttribute('transform'));
    el.dataset.defaultX = String(Math.round(x));
    el.dataset.defaultY = String(Math.round(y));
    el.classList.add('positionable-node');
  });

  const stored = getStoredPositions(diagramKey);
  if (Object.keys(stored).length > 0) {
    applyPositions(positionables, stored);
  }

  rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);

  const controller = {
    positionables,
    destroy() {
      previewWrap.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      panelEl.removeEventListener('input', onPanelInput);
      resetBtn?.removeEventListener('click', onReset);
    },
  };

  let dragState = null;

  function persistPositions() {
    setStoredPositions(diagramKey, readPositions(positionables));
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
    rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
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
    setStoredPositions(diagramKey, {});
    positionables.forEach((el, id) => {
      const row = panelEl.querySelector(`.position-row[data-node-id="${CSS.escape(id)}"]`);
      if (!row) return;
      const x = Number(row.dataset.defaultX);
      const y = Number(row.dataset.defaultY);
      setTranslate(el, x, y);
    });
    rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
    renderPanel();
    persistPositions();
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

    rerouteFlowchartEdges(svg, positionables, edgeLayout, diagramKey);
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
