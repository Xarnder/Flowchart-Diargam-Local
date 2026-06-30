/**
 * SVG coordinate helpers for dragging.
 * Pointer input is converted to root SVG user space (viewBox coordinates).
 * translate() values live in each element parent's local space.
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

/** Map user-space coordinates to the SVG viewport (pixel) space. */
export function userToViewport(svg, userX, userY) {
  if (!svg?.createSVGPoint) return { x: userX, y: userY };

  const point = svg.createSVGPoint();
  point.x = userX;
  point.y = userY;
  const ctm = svg.getCTM();
  if (!ctm) return { x: userX, y: userY };

  const mapped = point.matrixTransform(ctm);
  return { x: mapped.x, y: mapped.y };
}

/** Map viewport (pixel) coordinates back to SVG user space. */
export function viewportToUser(svg, viewportX, viewportY) {
  if (!svg?.createSVGPoint) return { x: viewportX, y: viewportY };

  const point = svg.createSVGPoint();
  point.x = viewportX;
  point.y = viewportY;
  const ctm = svg.getCTM();
  if (!ctm) return { x: viewportX, y: viewportY };

  const mapped = point.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

/** Map a root user-space point into an element parent's local coordinate system. */
export function rootToParentLocal(svg, parentEl, userX, userY) {
  if (!svg?.createSVGPoint || !parentEl) return { x: userX, y: userY };

  const inViewport = userToViewport(svg, userX, userY);
  const point = svg.createSVGPoint();
  point.x = inViewport.x;
  point.y = inViewport.y;
  const ctm = parentEl.getCTM();
  if (!ctm) return { x: userX, y: userY };

  const mapped = point.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

/** Convert a displacement vector from root user space into a parent's local space. */
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
