#!/usr/bin/env node
/**
 * Applies the Original (90°) edge layout mode to Mermaid Studio.
 * Run from repo root: node patches/apply-orthogonal-edge-mode.mjs
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

patch('src/edgeStyling.js', [
  [
    `export const EDGE_LAYOUTS = {
  curvy: 'curvy',
  straight: 'straight',
};`,
    `export const EDGE_LAYOUTS = {
  curvy: 'curvy',
  straight: 'straight',
  orthogonal: 'orthogonal',
};

export function resolveMermaidFlowchartCurve(edgeLayout) {
  switch (edgeLayout) {
    case EDGE_LAYOUTS.orthogonal:
      return 'step';
    case EDGE_LAYOUTS.straight:
      return 'linear';
    case EDGE_LAYOUTS.curvy:
    default:
      return 'basis';
  }
}`,
  ],
]);

patch('src/nodePositioning.js', [
  [
    `function buildEdgePath(start, end, edgeLayout) {
  if (edgeLayout === EDGE_LAYOUTS.straight) {
    const midX = (start.x + end.x) / 2;
    return \`M\${start.x},\${start.y}L\${midX},\${start.y}L\${midX},\${end.y}L\${end.x},\${end.y}\`;
  }

  const midY = (start.y + end.y) / 2;
  return \`M\${start.x},\${start.y}C\${start.x},\${midY} \${end.x},\${midY} \${end.x},\${end.y}\`;
}`,
    `function buildOrthogonalPath(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDy >= absDx) {
    const midY = start.y + dy / 2;
    return \`M\${start.x},\${start.y}L\${start.x},\${midY}L\${end.x},\${midY}L\${end.x},\${end.y}\`;
  }

  const midX = start.x + dx / 2;
  return \`M\${start.x},\${start.y}L\${midX},\${start.y}L\${midX},\${end.y}L\${end.x},\${end.y}\`;
}

function buildEdgePath(start, end, edgeLayout) {
  if (edgeLayout === EDGE_LAYOUTS.straight) {
    return \`M\${start.x},\${start.y}L\${end.x},\${end.y}\`;
  }

  if (edgeLayout === EDGE_LAYOUTS.orthogonal) {
    return buildOrthogonalPath(start, end);
  }

  const midY = (start.y + end.y) / 2;
  return \`M\${start.x},\${start.y}C\${start.x},\${midY} \${end.x},\${midY} \${end.x},\${end.y}\`;
}`,
  ],
]);

patch('src/main.js', [
  [
    `  resolveLayoutOptions,
} from './edgeStyling.js';`,
    `  resolveLayoutOptions,
  resolveMermaidFlowchartCurve,
} from './edgeStyling.js';`,
  ],
  [
    `  const useCurvyCurve = layout.edgeLayout === EDGE_LAYOUTS.curvy;
  const useSpacedBlocks = layout.blockLayout === BLOCK_LAYOUTS.spaced;

  mermaid.initialize({
    startOnLoad: false,
    maxTextSize: MAX_CHARS,
    theme: themeName,
    securityLevel: 'strict',
    htmlLabels: false,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    flowchart: {
      htmlLabels: false,
      curve: useCurvyCurve ? 'basis' : 'linear',`,
    `  const useSpacedBlocks = layout.blockLayout === BLOCK_LAYOUTS.spaced;

  mermaid.initialize({
    startOnLoad: false,
    maxTextSize: MAX_CHARS,
    theme: themeName,
    securityLevel: 'strict',
    htmlLabels: false,
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    flowchart: {
      htmlLabels: false,
      curve: resolveMermaidFlowchartCurve(layout.edgeLayout),`,
  ],
  [
    `      <select id="edge-layout" title="Curved uses smooth lines; Straight uses classic orthogonal routing">
        <option value="curvy" selected>Curved</option>
        <option value="straight">Straight</option>
      </select>`,
    `      <select id="edge-layout" title="Curved: smooth arcs · Straight: direct lines · Original: Mermaid 90° right-angle routing">
        <option value="curvy" selected>Curved</option>
        <option value="straight">Straight</option>
        <option value="orthogonal">Original (90°)</option>
      </select>`,
  ],
]);

console.log('Done. Restart the dev server if it is running.');
