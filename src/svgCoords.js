/**
 * SVG coordinate helpers for dragging.
 * All pointer input is converted to the root SVG user space, then mapped into
 * each element parent's local space where translate() values live.
 */

export function clientToSvg(svg, clientX, clientY) {
  if (!svg?.createSVGPoint || !svg.getScreenCTM) return null;

  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;

  const mapped = point.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

/** Map a root-SVG point into an element parent's local coordinate system. */
export function rootToParentLocal(svg, parentEl, rootX, rootY) {
  if (!svg?.createSVGPoint || !parentEl) return { x: rootX, y: rootY };

  const point = svg.createSVGPoint();
  point.x = rootX;
  point.y = rootY;
  const ctm = parentEl.getCTM();
  if (!ctm) return { x: rootX, y: rootY };

  const mapped = point.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

/** Convert a displacement vector from root SVG space into a parent's local space. */
export function rootDeltaToParent(svg, parentEl, deltaX, deltaY) {
  const origin = rootToParentLocal(svg, parentEl, 0, 0);
  const shifted = rootToParentLocal(svg, parentEl, deltaX, deltaY);
  return {
    dx: shifted.x - origin.x,
    dy: shifted.y - origin.y,
  };
}

/** Map a local point on an element into root SVG space. */
export function localToRoot(svg, el, localX, localY) {
  if (!svg?.createSVGPoint || !el) return { x: localX, y: localY };

  const point = svg.createSVGPoint();
  point.x = localX;
  point.y = localY;
  const ctm = el.getCTM();
  if (!ctm) return { x: localX, y: localY };

  const mapped = point.matrixTransform(ctm);
  return { x: mapped.x, y: mapped.y };
}

export function parseTranslate(transform) {
  const match = /translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/.exec(transform || '');
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2] ?? 0) : 0,
  };
}

export function formatTranslate(x, y) {
  return `translate(${x}, ${y})`;
}
