export const ORTHOGONAL_LAYOUT = 'orthogonal';
export const EDGE_ANCHOR_SPREAD = 18;
export const EDGE_ANCHOR_INSET = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function classifyBorderSide(rect, towardX, towardY) {
  const dx = towardX - rect.cx;
  const dy = towardY - rect.cy;
  if (Math.abs(dx) * rect.height > Math.abs(dy) * rect.width) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}

function getBorderPoint(rect, towardX, towardY) {
  const cx = rect.cx;
  const cy = rect.cy;
  const dx = towardX - cx;
  const dy = towardY - cy;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }

  const hw = Math.max(rect.width / 2, 1);
  const hh = Math.max(rect.height / 2, 1);
  const scale = Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx / scale, y: cy + dy / scale };
}

function spreadAnchorOnSide(rect, side, index, total, spread = EDGE_ANCHOR_SPREAD) {
  const inset = EDGE_ANCHOR_INSET;
  const sideLength = side === 'left' || side === 'right' ? rect.height : rect.width;
  const usable = Math.max(sideLength - inset * 2, spread);
  const step = total > 1 ? Math.min(spread, usable / (total - 1)) : 0;
  const offset = (index - (total - 1) / 2) * step;

  switch (side) {
    case 'right':
      return {
        x: rect.x + rect.width,
        y: clamp(rect.cy + offset, rect.y + inset, rect.y + rect.height - inset),
      };
    case 'left':
      return {
        x: rect.x,
        y: clamp(rect.cy + offset, rect.y + inset, rect.y + rect.height - inset),
      };
    case 'bottom':
      return {
        x: clamp(rect.cx + offset, rect.x + inset, rect.x + rect.width - inset),
        y: rect.y + rect.height,
      };
    case 'top':
      return {
        x: clamp(rect.cx + offset, rect.x + inset, rect.x + rect.width - inset),
        y: rect.y,
      };
    default:
      return { x: rect.cx, y: rect.cy };
  }
}

/** Fan out edge anchors when multiple lines share the same node side. */
export function computeSpreadEdgeAnchors(edgeRects, options = {}) {
  const spread = options.spread ?? EDGE_ANCHOR_SPREAD;
  const edges = edgeRects.map((item) => ({
    ...item,
    startSide: classifyBorderSide(item.sourceRect, item.targetRect.cx, item.targetRect.cy),
    endSide: classifyBorderSide(item.targetRect, item.sourceRect.cx, item.sourceRect.cy),
  }));

  const startGroups = new Map();
  const endGroups = new Map();

  const addToGroup = (groups, nodeKey, side, entry) => {
    const key = `${nodeKey}:${side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  };

  edges.forEach((edge, edgeIndex) => {
    addToGroup(startGroups, edge.startId, edge.startSide, {
      edgeIndex,
      sortKey:
        edge.startSide === 'left' || edge.startSide === 'right'
          ? edge.targetRect.cy
          : edge.targetRect.cx,
    });
    addToGroup(endGroups, edge.endId, edge.endSide, {
      edgeIndex,
      sortKey:
        edge.endSide === 'left' || edge.endSide === 'right'
          ? edge.sourceRect.cy
          : edge.sourceRect.cx,
    });
  });

  const startPoints = new Array(edges.length);
  const endPoints = new Array(edges.length);

  for (const group of startGroups.values()) {
    group.sort((a, b) => a.sortKey - b.sortKey);
    group.forEach((item, index) => {
      const edge = edges[item.edgeIndex];
      startPoints[item.edgeIndex] =
        group.length === 1
          ? getBorderPoint(edge.sourceRect, edge.targetRect.cx, edge.targetRect.cy)
          : spreadAnchorOnSide(edge.sourceRect, edge.startSide, index, group.length, spread);
    });
  }

  for (const group of endGroups.values()) {
    group.sort((a, b) => a.sortKey - b.sortKey);
    group.forEach((item, index) => {
      const edge = edges[item.edgeIndex];
      endPoints[item.edgeIndex] =
        group.length === 1
          ? getBorderPoint(edge.targetRect, edge.sourceRect.cx, edge.sourceRect.cy)
          : spreadAnchorOnSide(edge.targetRect, edge.endSide, index, group.length, spread);
    });
  }

  return edges.map((_, edgeIndex) => ({
    startPoint: startPoints[edgeIndex],
    endPoint: endPoints[edgeIndex],
  }));
}

export function buildOrthogonalPath(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDy >= absDx) {
    const midY = start.y + dy / 2;
    return `M${start.x},${start.y}L${start.x},${midY}L${end.x},${midY}L${end.x},${end.y}`;
  }

  const midX = start.x + dx / 2;
  return `M${start.x},${start.y}L${midX},${start.y}L${midX},${end.y}L${end.x},${end.y}`;
}

export function buildEdgePath(start, end, edgeLayout) {
  if (edgeLayout === 'straight') {
    return `M${start.x},${start.y}L${end.x},${end.y}`;
  }

  if (edgeLayout === ORTHOGONAL_LAYOUT) {
    return buildOrthogonalPath(start, end);
  }

  const midY = (start.y + end.y) / 2;
  return `M${start.x},${start.y}C${start.x},${midY} ${end.x},${midY} ${end.x},${end.y}`;
}
