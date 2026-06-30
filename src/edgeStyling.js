export const EDGE_LAYOUTS = {
  curvy: 'curvy',
  straight: 'straight',
};

export const BLOCK_LAYOUTS = {
  original: 'original',
  spaced: 'spaced',
};

export function resolveLayoutOptions(options = {}) {
  return {
    edgeLayout: options.edgeLayout ?? EDGE_LAYOUTS.curvy,
    blockLayout: options.blockLayout ?? BLOCK_LAYOUTS.original,
  };
}

function usesAdvancedEdgeRouting({ edgeLayout, blockLayout }) {
  return edgeLayout === EDGE_LAYOUTS.curvy && blockLayout === BLOCK_LAYOUTS.spaced;
}

/** Distinct edge colors that stay readable on light and dark backgrounds. */
export const EDGE_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#fabed4',
  '#469990',
  '#dcbeff',
  '#9a6324',
  '#fffac8',
  '#800000',
  '#aaffc3',
  '#808000',
  '#ffd8b1',
  '#000075',
  '#a9a9a9',
  '#ffe119',
];

/** Curve styles cycled per edge to reduce overlapping routes. */
const CURVE_STYLES = [
  'basis',
  'bumpY',
  'bumpX',
  'step',
  'stepAfter',
  'stepBefore',
  'monotoneY',
  'monotoneX',
  'natural',
  'cardinal',
];

const ENHANCEMENT_START = '%% edge-enhancements-start';
const ENHANCEMENT_END = '%% edge-enhancements-end';

const FLOWCHART_HEADER = /^(?:---[\s\S]*?---\s*\n)?(?:graph|flowchart)\s/im;
const CLASS_DIAGRAM_HEADER = /^(?:---[\s\S]*?---\s*\n)?classDiagram\s/im;

/** Mermaid class-diagram relation operators, longest first. */
const CLASS_LINK_OPERATOR =
  /(?:<\|\.\.|\.\.\|>|\|\}--|<\|--|\*\-\-|\*--\>|o\-\-|o\-\-|--\*>|\*--|--\|>|-->|--|\.\.>)/g;

const CLASS_SKIP_LINE =
  /^\s*(?:%%|<<\s*include\s*|direction\s|namespace\s|classDef\s|cssClass\s|style\s|click\s|accTitle|accDescr)/i;

/** Mermaid link operators, longest matches first. */
const LINK_OPERATOR =
  /(?:<-->|<-->|--o|--x|o--o|x--x|===|==>|-.->|\.\.-+>|-->|---)/g;

const SKIP_LINE =
  /^\s*(?:%%|style\s|linkStyle\s|classDef\s|class\s|click\s|accTitle|accDescr|e\d+@\{|end\s*$)/i;

const EXISTING_EDGE_ID = /\be\d+@/;

function stripEnhancements(source) {
  const start = source.indexOf(ENHANCEMENT_START);
  if (start === -1) return source;
  const end = source.indexOf(ENHANCEMENT_END);
  if (end === -1) return source.slice(0, start).trimEnd();
  return `${source.slice(0, start).trimEnd()}\n${source.slice(end + ENHANCEMENT_END.length).trimStart()}`.trimEnd();
}

export function isFlowchartDiagram(source) {
  return FLOWCHART_HEADER.test(source.trimStart());
}

export function isClassDiagram(source) {
  return CLASS_DIAGRAM_HEADER.test(source.trimStart());
}

export function supportsBlockPositioning(source) {
  return isFlowchartDiagram(source) || isClassDiagram(source);
}

function isClassEdgeLine(line) {
  const trimmed = line.trim();
  if (!trimmed || CLASS_SKIP_LINE.test(trimmed) || /^class\s/i.test(trimmed)) return false;
  CLASS_LINK_OPERATOR.lastIndex = 0;
  return CLASS_LINK_OPERATOR.test(trimmed);
}

export function parseClassDiagramEdges(source) {
  const edges = [];

  for (const line of source.split('\n')) {
    if (!isClassEdgeLine(line)) continue;

    const cleaned = line.replace(/:\s*[^:\n]+$/g, '');
    const parts = cleaned.split(CLASS_LINK_OPERATOR);
    const operators = cleaned.match(CLASS_LINK_OPERATOR) || [];
    if (operators.length === 0 || parts.length < 2) continue;

    for (let i = 0; i < operators.length; i += 1) {
      const start = extractNodeId(parts[i], 'last');
      const end = extractNodeId(parts[i + 1], 'first');
      if (start && end) edges.push({ start, end });
    }
  }

  return edges;
}

function isEdgeLine(line) {
  const trimmed = line.trim();
  if (!trimmed || SKIP_LINE.test(trimmed)) return false;
  LINK_OPERATOR.lastIndex = 0;
  return LINK_OPERATOR.test(trimmed);
}

export function countFlowchartEdges(source) {
  return parseFlowchartEdges(source).length;
}

export function parseFlowchartEdges(source) {
  const base = stripEnhancements(source);
  const edges = [];

  for (const line of base.split('\n')) {
    if (!isEdgeLine(line)) continue;

    const cleaned = line.replace(/\be\d+@/g, '');
    const parts = cleaned.split(LINK_OPERATOR);
    const operators = cleaned.match(LINK_OPERATOR) || [];
    if (operators.length === 0 || parts.length < 2) continue;

    for (let i = 0; i < operators.length; i += 1) {
      const start = extractNodeId(parts[i], 'last');
      const end = extractNodeId(parts[i + 1], 'first');
      if (start && end) edges.push({ start, end });
    }
  }

  return edges;
}

function extractNodeId(fragment, which) {
  const ids = [...fragment.matchAll(/\b([A-Za-z][\w-]*)\b/g)].map((match) => match[1]);
  if (ids.length === 0) return null;
  return which === 'first' ? ids[0] : ids[ids.length - 1];
}

function injectEdgeIdsAndCurves(source) {
  let edgeIndex = 0;
  const curveLines = [];

  const lines = source.split('\n').map((line) => {
    if (!isEdgeLine(line) || EXISTING_EDGE_ID.test(line)) return line;

    LINK_OPERATOR.lastIndex = 0;
    return line.replace(LINK_OPERATOR, (operator) => {
      const id = `e${edgeIndex}`;
      const curve = CURVE_STYLES[edgeIndex % CURVE_STYLES.length];
      curveLines.push(`${id}@{ curve: ${curve} }`);
      edgeIndex += 1;
      return `${id}@${operator}`;
    });
  });

  return { source: lines.join('\n'), edgeCount: edgeIndex, curveLines };
}

function buildLinkStyleBlock(edgeCount) {
  const lines = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const color = EDGE_COLORS[i % EDGE_COLORS.length];
    lines.push(`linkStyle ${i} stroke:${color},stroke-width:2.5px`);
  }
  return lines.join('\n');
}

/**
 * Inject per-edge colors into flowchart source. Advanced per-edge curves are only
 * applied in spaced block layout with curved edges — otherwise colors only.
 */
export function enhanceFlowchartSource(source, options = {}) {
  const layout = resolveLayoutOptions(options);
  const base = stripEnhancements(source);
  if (!isFlowchartDiagram(base)) return base;

  const edgeCount = countFlowchartEdges(base);
  if (edgeCount === 0) return base;

  if (!usesAdvancedEdgeRouting(layout)) {
    const block = [ENHANCEMENT_START, buildLinkStyleBlock(edgeCount), ENHANCEMENT_END].join('\n');
    return `${base.trimEnd()}\n\n${block}`;
  }

  const { source: withIds, edgeCount: injectedCount, curveLines } = injectEdgeIdsAndCurves(base);
  if (injectedCount === 0) return base;

  const block = [
    ENHANCEMENT_START,
    ...curveLines,
    buildLinkStyleBlock(injectedCount),
    ENHANCEMENT_END,
  ].join('\n');

  return `${withIds.trimEnd()}\n\n${block}`;
}

function cloneMarkerWithColor(defs, markerUrl, color, index) {
  const match = /#([^)]+)/.exec(markerUrl || '');
  if (!match) return markerUrl;

  const originalId = match[1];
  const original = defs.querySelector(`#${CSS.escape(originalId)}`);
  if (!original) return markerUrl;

  const newId = `${originalId}-edge-color-${index}`;
  if (defs.querySelector(`#${CSS.escape(newId)}`)) {
    return `url(#${newId})`;
  }

  const clone = original.cloneNode(true);
  clone.setAttribute('id', newId);
  clone.querySelectorAll('path, polygon, polyline, line, circle').forEach((node) => {
    node.setAttribute('fill', color);
    node.setAttribute('stroke', color);
  });
  defs.appendChild(clone);
  return `url(#${newId})`;
}

function colorizePath(pathEl, color, index, defs) {
  pathEl.setAttribute('stroke', color);
  pathEl.style.stroke = color;

  const markerEnd = pathEl.getAttribute('marker-end');
  if (markerEnd && defs) {
    pathEl.setAttribute('marker-end', cloneMarkerWithColor(defs, markerEnd, color, index));
  }
}

function colorizeLine(lineEl, color, index, defs) {
  lineEl.setAttribute('stroke', color);
  lineEl.style.stroke = color;

  const markerEnd = lineEl.getAttribute('marker-end');
  if (markerEnd && defs) {
    lineEl.setAttribute('marker-end', cloneMarkerWithColor(defs, markerEnd, color, index));
  }

  const markerStart = lineEl.getAttribute('marker-start');
  if (markerStart && defs) {
    lineEl.setAttribute('marker-start', cloneMarkerWithColor(defs, markerStart, color, index));
  }
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Nudge apart flowchart edges that share the same band and overlap in x/y. */
function separateOverlappingEdgePaths(paths) {
  const entries = paths.map((pathEl) => ({ pathEl, box: pathEl.getBBox() }));
  const used = new Set();

  for (let i = 0; i < entries.length; i += 1) {
    if (used.has(i)) continue;

    const cluster = [entries[i]];
    used.add(i);

    for (let j = i + 1; j < entries.length; j += 1) {
      if (used.has(j)) continue;
      const sameBand =
        Math.abs(entries[i].box.y - entries[j].box.y) < 6 &&
        Math.abs(entries[i].box.height - entries[j].box.height) < 6;
      const overlapsCluster = cluster.some((entry) => boxesOverlap(entry.box, entries[j].box));
      if (sameBand && overlapsCluster) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }

    if (cluster.length < 2) continue;

    const isMostlyHorizontal = cluster.every((entry) => entry.box.width >= entry.box.height * 2);
    const isMostlyVertical = cluster.every((entry) => entry.box.height >= entry.box.width * 2);

    cluster.forEach((entry, offsetIndex) => {
      if (offsetIndex === 0) return;
      const spread = 12;
      if (isMostlyHorizontal) {
        entry.pathEl.setAttribute('transform', `translate(0, ${offsetIndex * spread})`);
      } else if (isMostlyVertical) {
        entry.pathEl.setAttribute('transform', `translate(${offsetIndex * spread}, 0)`);
      } else {
        entry.pathEl.setAttribute(
          'transform',
          `translate(${offsetIndex * spread * 0.7}, ${offsetIndex * spread * 0.7})`,
        );
      }
    });
  }
}

/**
 * Apply distinct colors to rendered SVG edges (preview + export).
 * Complements linkStyle injection and covers diagram types without source transforms.
 */
export function applyDistinctEdgeStyles(svgEl, options = {}) {
  if (!svgEl) return;

  const layout = resolveLayoutOptions(options);
  const skipEdgeSeparation = options.manualPositions === true;

  const defs = svgEl.querySelector('defs');
  let index = 0;

  const selectors = [
    'path.flowchart-link',
    'g.edgePaths path',
    'line.messageLine0',
    'line.messageLine1',
    '.messageLine0',
    '.messageLine1',
    '.relationshipLine',
    'path.relationshipLine',
  ];

  const seen = new Set();
  for (const selector of selectors) {
    svgEl.querySelectorAll(selector).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);

      const color = EDGE_COLORS[index % EDGE_COLORS.length];
      if (el.tagName === 'line') {
        colorizeLine(el, color, index, defs);
      } else if (el.tagName === 'path') {
        colorizePath(el, color, index, defs);
      }
      index += 1;
    });
  }

  // Sequence diagram arrowheads are often separate paths beside the line.
  svgEl.querySelectorAll('path').forEach((pathEl) => {
    if (seen.has(pathEl)) return;
    const cls = pathEl.getAttribute('class') || '';
    if (!cls.includes('arrow') && !cls.includes('message')) return;
    if (pathEl.closest('.actor, .actor-box')) return;

    seen.add(pathEl);
    const color = EDGE_COLORS[index % EDGE_COLORS.length];
    colorizePath(pathEl, color, index, defs);
    index += 1;
  });

  if (!skipEdgeSeparation && usesAdvancedEdgeRouting(layout)) {
    const flowchartPaths = [...svgEl.querySelectorAll('path.flowchart-link')];
    if (flowchartPaths.length > 1) {
      separateOverlappingEdgePaths(flowchartPaths);
    }
  }
}
