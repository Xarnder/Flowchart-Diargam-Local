#!/usr/bin/env node
/**
 * Adds "Move subgraphs" mode to Mermaid Studio.
 * Run from repo root: node patches/apply-move-subgraphs-mode.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(file, replacements) {
  const target = path.join(root, file);
  let text = fs.readFileSync(target, 'utf8');
  for (const [oldText, newText] of replacements) {
    if (!text.includes(oldText)) {
      throw new Error(`Pattern not found in ${file}`);
    }
    text = text.replace(oldText, newText);
  }
  fs.writeFileSync(target, text);
  console.log(`patched ${file}`);
}

patch('src/diagramFile.js', [
  [
    `    manualPositions: Boolean(settings.manualPositions),
    subgraphResize: Boolean(settings.subgraphResize),`,
    `    manualPositions: Boolean(settings.manualPositions),
    moveSubgraphs: Boolean(settings.moveSubgraphs),
    subgraphResize: Boolean(settings.subgraphResize),`,
  ],
  [
    `    manualPositions: els.manualPositions?.checked,
    subgraphResize: els.subgraphResize?.checked,`,
    `    manualPositions: els.manualPositions?.checked,
    moveSubgraphs: els.moveSubgraphs?.checked,
    subgraphResize: els.subgraphResize?.checked,`,
  ],
  [
    `  if (els.manualPositions) {
    els.manualPositions.checked = normalized.manualPositions;
  }
  if (els.subgraphResize) {
    els.subgraphResize.checked = normalized.subgraphResize;
  }`,
    `  if (els.manualPositions) {
    els.manualPositions.checked = normalized.manualPositions;
  }
  if (els.moveSubgraphs) {
    els.moveSubgraphs.checked = normalized.moveSubgraphs;
  }
  if (els.subgraphResize) {
    els.subgraphResize.checked = normalized.subgraphResize;
  }`,
  ],
]);

patch('src/nodePositioning.js', [
  [
    `function getNodesInCluster(clusterEl, positionables) {
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
}`,
    `function getNodesInCluster(clusterEl, positionables) {
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

function findClusterForNode(nodeId, diagramKey, positionables) {
  const membership = parseSubgraphMembership(diagramKey);
  for (const [clusterId, nodeIds] of membership) {
    if (nodeIds.includes(nodeId)) {
      return positionables.get(clusterId) || null;
    }
  }
  return null;
}

function getMemberNodesForCluster(clusterId, clusterEl, diagramKey, positionables) {
  const membership = parseSubgraphMembership(diagramKey);
  const nodeIds = membership.get(clusterId) || [];
  const entries = nodeIds
    .map((id) => [id, positionables.get(id)])
    .filter(([, el]) => el?.classList.contains('node'));

  if (entries.length > 0) return entries;
  if (clusterEl) return getNodesInCluster(clusterEl, positionables);
  return [];
}`,
  ],
  [
    `export function setupNodePositioning({
  previewWrap,
  svg,
  diagramKey,
  edgeLayout,
  enabled,
  showSubgraphHandles = false,
  panelEl,
  resetBtn,
  onLayoutChange,
}) {
  teardownNodePositioning();

  if (!enabled || !svg || !supportsBlockPositioning(diagramKey) || !panelEl) {
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
  }`,
    `export function setupNodePositioning({
  previewWrap,
  svg,
  diagramKey,
  edgeLayout,
  enabled,
  subgraphMoveOnly = false,
  showSubgraphHandles = false,
  panelEl,
  resetBtn,
  onLayoutChange,
}) {
  teardownNodePositioning();

  if (!enabled || !svg || !supportsBlockPositioning(diagramKey) || !panelEl) {
    panelEl?.classList.add('hidden');
    previewWrap.removeAttribute('data-manual-positions');
    previewWrap.removeAttribute('data-move-subgraphs');
    previewWrap.removeAttribute('data-subgraph-resize');
    return null;
  }

  subgraphHandlesEnabled = Boolean(showSubgraphHandles) && !subgraphMoveOnly;

  const positionables = collectPositionables(svg);
  if (positionables.size === 0) {
    panelEl.classList.add('hidden');
    return null;
  }

  if (subgraphMoveOnly) {
    panelEl.classList.add('hidden');
    previewWrap.dataset.moveSubgraphs = 'true';
    previewWrap.removeAttribute('data-manual-positions');
    previewWrap.removeAttribute('data-subgraph-resize');
  } else {
    panelEl.classList.remove('hidden');
    previewWrap.dataset.manualPositions = 'true';
    previewWrap.removeAttribute('data-move-subgraphs');
    if (showSubgraphHandles) {
      previewWrap.dataset.subgraphResize = 'true';
    } else {
      previewWrap.removeAttribute('data-subgraph-resize');
    }
  }`,
  ],
  [
    `    const target = event.target.closest('g.node, g.cluster');
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
      target.classList.contains('cluster') ? getNodesInCluster(target, positionables) : [[id, target]];`,
    `    let target = event.target.closest('g.node, g.cluster');
    if (!target || !previewWrap.contains(target)) return;
    if (event.target.closest('.cluster-handles')) return;

    let id = getLogicalNodeId(target);

    if (subgraphMoveOnly) {
      if (target.classList.contains('node')) {
        const clusterEl = findClusterForNode(id, diagramKey, positionables);
        if (!clusterEl) return;
        target = clusterEl;
        id = getLogicalNodeId(target);
      } else if (!target.classList.contains('cluster')) {
        return;
      }
    }

    if (!positionables.has(id)) return;

    event.preventDefault();
    const svgEl = previewWrap.querySelector('svg');
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;

    const start = parseTranslate(target.getAttribute('transform'));
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    const bundled = target.classList.contains('cluster')
      ? getMemberNodesForCluster(id, target, diagramKey, positionables)
      : subgraphMoveOnly
        ? []
        : [[id, target]];

    if (subgraphMoveOnly && bundled.length === 0) return;`,
  ],
]);

patch('src/main.js', [
  [
    `const SUBGRAPH_RESIZE_STORAGE_KEY = 'mermaid-studio-subgraph-resize';`,
    `const SUBGRAPH_RESIZE_STORAGE_KEY = 'mermaid-studio-subgraph-resize';
const MOVE_SUBGRAPHS_STORAGE_KEY = 'mermaid-studio-move-subgraphs';`,
  ],
  [
    `      <label class="checkbox-label" for="manual-positions" title="Drag blocks or set X/Y coordinates; arrows follow automatically">
        <input type="checkbox" id="manual-positions" />
        Position blocks
      </label>

      <label class="checkbox-label" for="subgraph-resize" title="Show drag handles on subgraph boxes to resize them">`,
    `      <label class="checkbox-label" for="manual-positions" title="Drag blocks or set X/Y coordinates; arrows follow automatically">
        <input type="checkbox" id="manual-positions" />
        Position blocks
      </label>

      <label class="checkbox-label" for="move-subgraphs" title="Drag subgraph boxes; every block inside moves with the subgraph">
        <input type="checkbox" id="move-subgraphs" />
        Move subgraphs
      </label>

      <label class="checkbox-label" for="subgraph-resize" title="Show drag handles on subgraph boxes to resize them">`,
  ],
  [
    `    manualPositions: document.getElementById('manual-positions'),
    subgraphResize: document.getElementById('subgraph-resize'),`,
    `    manualPositions: document.getElementById('manual-positions'),
    moveSubgraphs: document.getElementById('move-subgraphs'),
    subgraphResize: document.getElementById('subgraph-resize'),`,
  ],
  [
    `function syncSubgraphResizeControl(els) {
  const manualOn = Boolean(els.manualPositions?.checked);
  if (!els.subgraphResize) return;
  els.subgraphResize.disabled = !manualOn;
}`,
    `function syncLayoutModeControls(els) {
  const moveSubgraphsOn = Boolean(els.moveSubgraphs?.checked);
  const manualOn = Boolean(els.manualPositions?.checked) && !moveSubgraphsOn;

  if (els.moveSubgraphs) {
    els.moveSubgraphs.disabled = false;
  }
  if (els.manualPositions && moveSubgraphsOn) {
    els.manualPositions.checked = false;
  }
  if (els.subgraphResize) {
    els.subgraphResize.disabled = !manualOn;
    if (moveSubgraphsOn) {
      els.subgraphResize.checked = false;
    }
  }
}

function syncSubgraphResizeControl(els) {
  syncLayoutModeControls(els);
}`,
  ],
  [
    `    manualPositions: { checked: localStorage.getItem(MANUAL_POSITIONS_STORAGE_KEY) === '1' },
    subgraphResize: { checked: localStorage.getItem(SUBGRAPH_RESIZE_STORAGE_KEY) === '1' },`,
    `    manualPositions: { checked: localStorage.getItem(MANUAL_POSITIONS_STORAGE_KEY) === '1' },
    moveSubgraphs: { checked: localStorage.getItem(MOVE_SUBGRAPHS_STORAGE_KEY) === '1' },
    subgraphResize: { checked: localStorage.getItem(SUBGRAPH_RESIZE_STORAGE_KEY) === '1' },`,
  ],
  [
    `function mountNodePositioning(text, els, layoutOptions) {
  const svg = els.previewCanvas.querySelector('svg');
  const enabled = Boolean(els.manualPositions?.checked) && supportsBlockPositioning(text);
  const showSubgraphHandles =
    enabled && Boolean(els.subgraphResize?.checked) && isFlowchartDiagram(text);

  setupNodePositioning({
    previewWrap: els.previewWrap,
    svg,
    diagramKey: text,
    edgeLayout: layoutOptions.edgeLayout,
    enabled,
    showSubgraphHandles,
    panelEl: els.positionPanel,
    resetBtn: els.btnResetPositions,
    onLayoutChange: () => scheduleDiagramSave(els),
  });
}`,
    `function mountNodePositioning(text, els, layoutOptions) {
  const svg = els.previewCanvas.querySelector('svg');
  const moveSubgraphs = Boolean(els.moveSubgraphs?.checked) && isFlowchartDiagram(text);
  const manualBlocks =
    Boolean(els.manualPositions?.checked) && supportsBlockPositioning(text) && !moveSubgraphs;
  const enabled = manualBlocks || moveSubgraphs;
  const showSubgraphHandles =
    manualBlocks && Boolean(els.subgraphResize?.checked) && isFlowchartDiagram(text);

  setupNodePositioning({
    previewWrap: els.previewWrap,
    svg,
    diagramKey: text,
    edgeLayout: layoutOptions.edgeLayout,
    enabled,
    subgraphMoveOnly: moveSubgraphs,
    showSubgraphHandles,
    panelEl: els.positionPanel,
    resetBtn: els.btnResetPositions,
    onLayoutChange: () => scheduleDiagramSave(els),
  });
}`,
  ],
  [
    `    const manualPositions = Boolean(els.manualPositions?.checked);
    const svgEl = els.previewCanvas.querySelector('svg');
    normalizePreviewSvgSizing(svgEl, manualPositions);
    applyDistinctEdgeStyles(svgEl, { ...layoutOptions, manualPositions });`,
    `    const manualLayoutActive =
      Boolean(els.manualPositions?.checked) || Boolean(els.moveSubgraphs?.checked);
    const svgEl = els.previewCanvas.querySelector('svg');
    normalizePreviewSvgSizing(svgEl, manualLayoutActive);
    applyDistinctEdgeStyles(svgEl, { ...layoutOptions, manualPositions: manualLayoutActive });`,
  ],
  [
    `  els.manualPositions.addEventListener('change', () => {
    syncSubgraphResizeControl(els);
    scheduleDiagramSave(els);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.subgraphResize.addEventListener('change', () => {`,
    `  els.manualPositions.addEventListener('change', () => {
    if (els.manualPositions.checked && els.moveSubgraphs) {
      els.moveSubgraphs.checked = false;
    }
    syncLayoutModeControls(els);
    scheduleDiagramSave(els);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.moveSubgraphs?.addEventListener('change', () => {
    if (els.moveSubgraphs.checked) {
      if (els.manualPositions) els.manualPositions.checked = false;
      if (els.subgraphResize) els.subgraphResize.checked = false;
    }
    syncLayoutModeControls(els);
    scheduleDiagramSave(els);
    renderDiagram(els.editor.value, els, els.exportTheme.value, getRenderLayoutOptions(els));
  });

  els.subgraphResize.addEventListener('change', () => {`,
  ],
  [
    `            <span class="position-hint">Drag blocks · turn on Resize subgraphs for handles</span>`,
    `            <span class="position-hint">Drag blocks · Move subgraphs mode drags whole subgraphs · Resize subgraphs adds handles</span>`,
  ],
]);

patch('src/style.css', [
  [
    `#preview-wrap[data-subgraph-resize='true'] g.cluster.positionable-node {
  cursor: default;
}`,
    `#preview-wrap[data-subgraph-resize='true'] g.cluster.positionable-node {
  cursor: default;
}

#preview-wrap[data-move-subgraphs='true'] svg .positionable-node.node {
  cursor: grab;
}

#preview-wrap[data-move-subgraphs='true'] svg g.cluster.positionable-node {
  cursor: grab;
}

#preview-wrap[data-move-subgraphs='true'] svg .positionable-node.is-dragging {
  cursor: grabbing;
}`,
  ],
]);

console.log('Done. Restart the dev server if it is running.');
