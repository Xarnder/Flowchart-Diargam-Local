# Mermaid Studio

A **local, browser-based** Mermaid editor with live preview and PNG/SVG export.

- All rendering happens **on your device** — nothing is sent to any server
- **Free**, no account, no diagram count limit
- Only limit: Mermaid’s **50,000 character** cap per diagram (same as GitHub / VS Code)
- Auto-saves your last diagram and export theme to `localStorage`
- Default export theme: **Dark**

## Requirements

- [Node.js](https://nodejs.org/) **18 or newer** (includes `npm`)
- A modern web browser (Chrome, Firefox, Safari, or Edge)

Check your version:

```bash
node -v
npm -v
```

## Download and run (for anyone cloning this repo)

### 1. Get the code

**Option A — Git clone (recommended)**

```bash
git clone https://github.com/Xarnder/Flowchart-Diargam-Local.git
cd Flowchart-Diargam-Local
```

**Option B — Download ZIP**

1. Open [https://github.com/Xarnder/Flowchart-Diargam-Local](https://github.com/Xarnder/Flowchart-Diargam-Local)
2. Click **Code** → **Download ZIP**
3. Unzip the folder and open a terminal inside it

### 2. Install dependencies

You only need to do this once (or after pulling updates that change `package.json`):

```bash
npm install
```

This downloads packages listed in `package.json` into `node_modules/`. That folder is **not** stored in Git — everyone runs `npm install` locally.

### 3. Start the app

```bash
npm run dev
```

Open the URL shown in the terminal (usually **http://localhost:5173**).

Press `Ctrl + C` in the terminal to stop the dev server.

## Usage

1. Paste Mermaid code in the left panel
2. Preview updates automatically (or press **Cmd/Ctrl + Enter**)
3. Choose **Export theme**: Light, Dark, or Transparent
4. Click **Save PNG** (or **Cmd/Ctrl + S**) or **Save SVG** (or **Cmd/Ctrl + Shift + S**)
5. Optional: adjust **PNG scale** (2× default for sharper output)

## Build a static version (optional)

To create files you can host offline or on any static file server:

```bash
npm run build
npm run preview
```

The built site is in `dist/`. Open the preview URL, or serve `dist/` with any static host.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Render now |
| `Cmd/Ctrl + S` | Save PNG |
| `Cmd/Ctrl + Shift + S` | Save SVG |

## Uploading changes to GitHub (for maintainers)

**Do not commit `node_modules/` or `dist/`.** They are listed in `.gitignore`. Only source files and `package.json` / `package-lock.json` belong in the repo.

First-time setup (connect your local folder to GitHub):

```bash
git remote add origin https://github.com/Xarnder/Flowchart-Diargam-Local.git
```

Push your code:

```bash
git add .
git commit -m "Your message describing the change"
git push -u origin main
```

If the remote already exists, skip `git remote add` and use `git push` after committing.

## Notes

- Uses native SVG text labels (`htmlLabels: false`) so text survives SVG/PNG export
- PNG/SVG export clones the **live preview** (WYSIWYG — what you see is what you export)
- **Transparent** export omits the background rect (checkerboard shown in preview only)
- Preview re-renders with Mermaid's light or dark theme when you change export theme
- **Copy SVG** / **Save SVG** use the same export theme settings as PNG
- PNG export uses SVG → Canvas → PNG entirely in the browser
- Examples include Sylenze architecture diagram types (flowchart, sequence, ER, gantt)
