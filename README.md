# Mermaid Studio

A **local, browser-based** Mermaid editor with live preview and PNG export.

- All rendering happens **on your device** — nothing is sent to any server
- **Free**, no account, no diagram count limit
- Only limit: Mermaid’s **50,000 character** cap per diagram (same as GitHub / VS Code)
- Auto-saves your last diagram and export theme to `localStorage`
- Default export theme: **Dark**

## Quick start

```bash
cd tools/mermaid-studio
npm install
npm run dev
```

Open the URL shown (usually `http://localhost:5173`).

## Usage

1. Paste Mermaid code in the left panel
2. Preview updates automatically (or press **Cmd/Ctrl + Enter**)
3. Choose **Export theme**: Light, Dark, or Transparent
4. Click **Save PNG** (or **Cmd/Ctrl + S**) or **Save SVG** (or **Cmd/Ctrl + Shift + S**)
5. Optional: adjust **PNG scale** (2× default for sharper output)

## Build static version

```bash
npm run build
npm run preview
```

The `dist/` folder can be hosted anywhere or kept for offline use after building.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Render now |
| `Cmd/Ctrl + S` | Save PNG |
| `Cmd/Ctrl + Shift + S` | Save SVG |

## Notes

- Uses native SVG text labels (`htmlLabels: false`) so text survives SVG/PNG export
- PNG/SVG export clones the **live preview** (WYSIWYG — what you see is what you export)
- **Transparent** export omits the background rect (checkerboard shown in preview only)
- Preview re-renders with Mermaid's light or dark theme when you change export theme
- **Copy SVG** / **Save SVG** use the same export theme settings as PNG
- PNG export uses SVG → Canvas → PNG entirely in the browser
- Examples include Sylenze architecture diagram types (flowchart, sequence, ER, gantt)
