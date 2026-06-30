import { rootDeltaToParent, viewportToUser } from './svgCoords.js';

/** Padding inside the canvas edge when deriving the initial canvas from content. */
export const CANVAS_EDGE_PADDING = 24;

/** Extra space outside the dotted canvas edge (included in the SVG viewBox). */
export const CANVAS_VISUAL_BUFFER = 20;

export const CANVAS_MIN_SIZE = 120;

const HANDLE_POSITIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

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

export function boundsFromContentBounds(contentBounds) {
  if (!contentBounds) return null;

  return {
    x: contentBounds.minX - CANVAS_EDGE_PADDING,
    y: contentBounds.minY - CANVAS_EDGE_PADDING,
    width: contentBounds.maxX - contentBounds.minX + CANVAS_EDGE_PADDING * 2,
    height: contentBounds.maxY - contentBounds.minY + CANVAS_EDGE_PADDING * 2,
  };
}

/** Parse the SVG viewBox Mermaid computed to fit the full rendered diagram. */
export function boundsFromSvgViewBox(svg) {
  const viewBox = svg?.getAttribute('viewBox');
  if (!viewBox) return null;

  const parts = viewBox.split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;

  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) return null;

  return { x, y, width, height };
}

export function unionCanvasBounds(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);

  return { x, y, width: maxX - x, height: maxY - y };
}

export function visualViewBoxFromCanvas(bounds) {
  return {
    x: bounds.x - CANVAS_VISUAL_BUFFER,
    y: bounds.y - CANVAS_VISUAL_BUFFER,
    width: bounds.width + CANVAS_VISUAL_BUFFER * 2,
    height: bounds.height + CANVAS_VISUAL_BUFFER * 2,
  };
}

export function applyCanvasToSvg(svg, bounds) {
  if (!svg || !bounds) return;

  const view = visualViewBoxFromCanvas(bounds);
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  svg.setAttribute('width', String(view.width));
  svg.setAttribute('height', String(view.height));
  svg.style.removeProperty('max-width');
  updateCanvasOverlay(svg, bounds);
}

function getOverlayGroup(svg) {
  return svg.querySelector('.layout-canvas-overlay');
}

function insertBeforeDiagramContent(svg, node) {
  const firstGraphic = [...svg.children].find(
    (child) => child.tagName !== 'style' && child.tagName !== 'defs',
  );
  svg.insertBefore(node, firstGraphic ?? null);
}

export function ensureCanvasOverlay(svg) {
  if (!svg) return;

  if (!getOverlayGroup(svg)) {
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    overlay.setAttribute('class', 'layout-canvas-overlay');
    overlay.setAttribute('pointer-events', 'none');

    const buffer = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    buffer.setAttribute('class', 'layout-canvas-buffer');
    buffer.setAttribute('fill-rule', 'evenodd');
    buffer.setAttribute('pointer-events', 'none');

    const edge = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    edge.setAttribute('class', 'layout-canvas-edge');
    edge.setAttribute('fill', 'none');
    edge.setAttribute('pointer-events', 'none');

    overlay.append(buffer, edge);
    insertBeforeDiagramContent(svg, overlay);
  }

  if (!svg.querySelector('.canvas-handles')) {
    const handles = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    handles.setAttribute('class', 'canvas-handles');
    handles.setAttribute('pointer-events', 'none');

    HANDLE_POSITIONS.forEach((handle) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('class', 'canvas-resize-handle');
      el.setAttribute('data-handle', handle);
      el.setAttribute('pointer-events', 'none');
      handles.appendChild(el);
    });

    svg.appendChild(handles);
  }
}

export function removeCanvasOverlay(svg) {
  svg?.querySelector('.layout-canvas-overlay')?.remove();
  svg?.querySelector('.canvas-handles')?.remove();
}

function bufferZonePath(bounds) {
  const view = visualViewBoxFromCanvas(bounds);
  const outer = `M ${view.x} ${view.y} h ${view.width} v ${view.height} h ${-view.width} Z`;
  const inner = `M ${bounds.x} ${bounds.y} h ${bounds.width} v ${bounds.height} h ${-bounds.width} Z`;
  return `${outer} ${inner}`;
}

export function updateCanvasOverlay(svg, bounds) {
  if (!svg || !bounds) return;

  ensureCanvasOverlay(svg);
  const overlay = getOverlayGroup(svg);
  const buffer = overlay.querySelector('.layout-canvas-buffer');
  const edge = overlay.querySelector('.layout-canvas-edge');
  const handles = svg.querySelector('.canvas-handles');
  if (!buffer || !edge || !handles) return;

  buffer.setAttribute('d', bufferZonePath(bounds));

  edge.setAttribute('x', String(bounds.x));
  edge.setAttribute('y', String(bounds.y));
  edge.setAttribute('width', String(bounds.width));
  edge.setAttribute('height', String(bounds.height));

  const handleSize = 9;
  const half = handleSize / 2;
  const positions = {
    nw: [bounds.x, bounds.y],
    n: [bounds.x + bounds.width / 2, bounds.y],
    ne: [bounds.x + bounds.width, bounds.y],
    e: [bounds.x + bounds.width, bounds.y + bounds.height / 2],
    se: [bounds.x + bounds.width, bounds.y + bounds.height],
    s: [bounds.x + bounds.width / 2, bounds.y + bounds.height],
    sw: [bounds.x, bounds.y + bounds.height],
    w: [bounds.x, bounds.y + bounds.height / 2],
  };

  handles.querySelectorAll('.canvas-resize-handle').forEach((el) => {
    const handle = el.getAttribute('data-handle');
    const [cx, cy] = positions[handle] || [0, 0];
    el.setAttribute('x', String(cx - half));
    el.setAttribute('y', String(cy - half));
    el.setAttribute('width', String(handleSize));
    el.setAttribute('height', String(handleSize));
    el.style.cursor = HANDLE_CURSORS[handle] || 'default';
  });
}

export function setCanvasHandlesInteractive(svg, enabled) {
  const handles = svg?.querySelector('.canvas-handles');
  if (!handles) return;

  handles.setAttribute('pointer-events', enabled ? 'all' : 'none');
  handles.querySelectorAll('.canvas-resize-handle').forEach((el) => {
    el.setAttribute('pointer-events', enabled ? 'all' : 'none');
  });
}

export function computeResizedCanvasBounds(start, handle, dx, dy) {
  let { x, y, width, height } = start;

  if (handle.includes('e')) {
    width = Math.max(CANVAS_MIN_SIZE, start.width + dx);
  }
  if (handle.includes('w')) {
    const nextWidth = Math.max(CANVAS_MIN_SIZE, start.width - dx);
    x = start.x + start.width - nextWidth;
    width = nextWidth;
  }
  if (handle.includes('s')) {
    height = Math.max(CANVAS_MIN_SIZE, start.height + dy);
  }
  if (handle.includes('n')) {
    const nextHeight = Math.max(CANVAS_MIN_SIZE, start.height - dy);
    y = start.y + start.height - nextHeight;
    height = nextHeight;
  }

  return { x, y, width, height };
}

export function clampClusterRectToCanvas(rect, canvasBounds) {
  if (!rect || !canvasBounds) return rect;

  const width = Math.min(rect.width, canvasBounds.width);
  const height = Math.min(rect.height, canvasBounds.height);
  const maxX = canvasBounds.x + canvasBounds.width - width;
  const maxY = canvasBounds.y + canvasBounds.height - height;

  return {
    x: Math.max(canvasBounds.x, Math.min(rect.x, maxX)),
    y: Math.max(canvasBounds.y, Math.min(rect.y, maxY)),
    width,
    height,
  };
}

export function clampNodeTranslateToCanvas(svg, el, nextX, nextY, canvasBounds) {
  if (!canvasBounds) return { x: nextX, y: nextY };

  const parent = el.parentElement;
  let x = nextX;
  let y = nextY;

  const applyCorrection = (correctionX, correctionY) => {
    if (correctionX === 0 && correctionY === 0) return;
    const delta = rootDeltaToParent(svg, parent, correctionX, correctionY);
    x += delta.dx;
    y += delta.dy;
  };

  setTranslate(el, x, y);
  let rect = getNodeUserSpaceRect(svg, el);

  if (rect.x < canvasBounds.x) {
    applyCorrection(canvasBounds.x - rect.x, 0);
  }
  if (rect.y < canvasBounds.y) {
    applyCorrection(0, canvasBounds.y - rect.y);
  }

  setTranslate(el, x, y);
  rect = getNodeUserSpaceRect(svg, el);

  const overflowRight = rect.x + rect.width - (canvasBounds.x + canvasBounds.width);
  if (overflowRight > 0) {
    applyCorrection(-overflowRight, 0);
  }
  const overflowBottom = rect.y + rect.height - (canvasBounds.y + canvasBounds.height);
  if (overflowBottom > 0) {
    applyCorrection(0, -overflowBottom);
  }

  return { x, y };
}

function getNodeUserSpaceRect(svg, el) {
  const shape =
    el.querySelector(':scope > rect, :scope > polygon, :scope > circle, :scope > ellipse') || el;
  return getElementUserSpaceRect(svg, shape);
}

function getElementUserSpaceRect(svg, el) {
  const viewportRect = getAbsoluteRect(el);
  const corners = [
    viewportToUser(svg, viewportRect.x, viewportRect.y),
    viewportToUser(svg, viewportRect.x + viewportRect.width, viewportRect.y),
    viewportToUser(svg, viewportRect.x + viewportRect.width, viewportRect.y + viewportRect.height),
    viewportToUser(svg, viewportRect.x, viewportRect.y + viewportRect.height),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;

  return { x, y, width, height };
}

function setTranslate(el, x, y) {
  el.setAttribute('transform', `translate(${x}, ${y})`);
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

  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
}

function toSvgRootPoint(svg, el, x, y) {
  if (!svg?.createSVGPoint) return { x, y };

  const point = svg.createSVGPoint();
  point.x = x;
  point.y = y;
  const ctm = el.getCTM();
  if (!ctm) return { x, y };
  const mapped = point.matrixTransform(ctm);
  return { x: mapped.x, y: mapped.y };
}
