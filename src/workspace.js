import {
  createDiagramDocument,
  DIAGRAM_EXTENSION,
  filenameForDiagram,
  parseDiagramDocument,
  serializeDiagramDocument,
} from './diagramFile.js';
import { clearStoredDirectoryHandle, loadStoredDirectoryHandle, storeDirectoryHandle } from './idb.js';

const LOCAL_WORKSPACE_KEY = 'mermaid-studio-local-workspace';
const ACTIVE_DIAGRAM_KEY = 'mermaid-studio-active-diagram';

function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

function readLocalWorkspace() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_WORKSPACE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLocalWorkspace(store) {
  localStorage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(store));
}

function sortDiagrams(diagrams) {
  return [...diagrams].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export class DiagramWorkspace {
  #dirHandle = null;
  #diagrams = [];
  #mode = 'local';
  #listeners = new Set();

  constructor() {
    this.activeId = localStorage.getItem(ACTIVE_DIAGRAM_KEY) || null;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) {
      listener(this.getState());
    }
  }

  getState() {
    return {
      mode: this.#mode,
      directoryName: this.#dirHandle?.name || null,
      diagrams: sortDiagrams(this.#diagrams),
      activeId: this.activeId,
      supportsDirectoryPicker: supportsDirectoryPicker(),
    };
  }

  getDiagrams() {
    return sortDiagrams(this.#diagrams);
  }

  getActiveDiagramMeta() {
    return this.#diagrams.find((diagram) => diagram.id === this.activeId) || null;
  }

  hasDirectoryAccess() {
    return this.#mode === 'filesystem' && Boolean(this.#dirHandle);
  }

  async init() {
    if (supportsDirectoryPicker()) {
      const handle = await loadStoredDirectoryHandle();
      if (handle) {
        const permitted = await this.#ensurePermission(handle, 'readwrite');
        if (permitted) {
          this.#dirHandle = handle;
          this.#mode = 'filesystem';
          await this.#scanDirectory();
          this.#emit();
          return;
        }
      }
    }

    await this.#loadLocalWorkspace();
    this.#emit();
  }

  async openDirectory() {
    if (!supportsDirectoryPicker()) {
      throw new Error('Your browser does not support opening a local folder. Use Chrome or Edge on desktop.');
    }

    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permitted = await this.#ensurePermission(handle, 'readwrite');
    if (!permitted) {
      throw new Error('Folder permission was denied');
    }

    this.#dirHandle = handle;
    this.#mode = 'filesystem';
    await storeDirectoryHandle(handle);
    await this.#scanDirectory();

    if (this.#diagrams.length === 0) {
      await this.createDiagram('Untitled');
    } else if (!this.activeId || !this.#diagrams.some((diagram) => diagram.id === this.activeId)) {
      this.activeId = this.#diagrams[0].id;
      localStorage.setItem(ACTIVE_DIAGRAM_KEY, this.activeId);
    }

    this.#emit();
    return this.getState();
  }

  async disconnectDirectory() {
    this.#dirHandle = null;
    this.#mode = 'local';
    await clearStoredDirectoryHandle();
    await this.#loadLocalWorkspace();
    this.#emit();
  }

  async refresh() {
    if (this.#mode === 'filesystem' && this.#dirHandle) {
      await this.#scanDirectory();
    } else {
      await this.#loadLocalWorkspace();
    }
    this.#emit();
  }

  async readDiagram(id) {
    const meta = this.#diagrams.find((diagram) => diagram.id === id);
    if (!meta) {
      throw new Error('Diagram not found');
    }

    if (this.#mode === 'filesystem') {
      const handle = await this.#dirHandle.getFileHandle(meta.filename);
      const file = await handle.getFile();
      return parseDiagramDocument(await file.text());
    }

    const store = readLocalWorkspace();
    const raw = store.files?.[meta.filename];
    if (!raw) {
      throw new Error('Diagram file is missing from local storage');
    }
    return parseDiagramDocument(raw);
  }

  async writeDiagram(id, doc) {
    const meta = this.#diagrams.find((diagram) => diagram.id === id);
    if (!meta) {
      throw new Error('Diagram not found');
    }

    const payload = serializeDiagramDocument({ ...doc, name: doc.name || meta.name });
    const parsed = parseDiagramDocument(payload);

    if (this.#mode === 'filesystem') {
      const handle = await this.#dirHandle.getFileHandle(meta.filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
    } else {
      const store = readLocalWorkspace();
      if (!store.files) store.files = {};
      store.files[meta.filename] = payload;
      writeLocalWorkspace(store);
    }

    meta.name = parsed.name;
    meta.updatedAt = parsed.updatedAt;
    this.#diagrams = sortDiagrams(this.#diagrams);
    this.#emit();
    return parsed;
  }

  async createDiagram(name = 'Untitled', { source, settings, layout } = {}) {
    const existingNames = new Set(this.#diagrams.map((diagram) => diagram.filename));
    const filename = filenameForDiagram(name, existingNames);
    const doc = createDiagramDocument({ name, source, settings, layout });

    if (this.#mode === 'filesystem') {
      if (!this.#dirHandle) {
        throw new Error('Open a folder before creating diagrams');
      }
      const handle = await this.#dirHandle.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(serializeDiagramDocument(doc));
      await writable.close();
      await this.#scanDirectory();
    } else {
      const store = readLocalWorkspace();
      if (!store.files) store.files = {};
      store.files[filename] = serializeDiagramDocument(doc);
      writeLocalWorkspace(store);
      await this.#loadLocalWorkspace();
    }

    const created = this.#diagrams.find((diagram) => diagram.filename === filename);
    if (created) {
      this.activeId = created.id;
      localStorage.setItem(ACTIVE_DIAGRAM_KEY, created.id);
    }

    this.#emit();
    return created;
  }

  async deleteDiagram(id) {
    const meta = this.#diagrams.find((diagram) => diagram.id === id);
    if (!meta) return false;

    if (!confirm(`Delete "${meta.name}"? This cannot be undone.`)) {
      return false;
    }

    if (this.#mode === 'filesystem') {
      await this.#dirHandle.removeEntry(meta.filename);
      await this.#scanDirectory();
    } else {
      const store = readLocalWorkspace();
      if (store.files) {
        delete store.files[meta.filename];
      }
      writeLocalWorkspace(store);
      await this.#loadLocalWorkspace();
    }

    if (this.activeId === id) {
      this.activeId = this.#diagrams[0]?.id || null;
      if (this.activeId) {
        localStorage.setItem(ACTIVE_DIAGRAM_KEY, this.activeId);
      } else {
        localStorage.removeItem(ACTIVE_DIAGRAM_KEY);
      }
    }

    this.#emit();
    return true;
  }

  async importDiagramFile() {
    if (typeof window.showOpenFilePicker !== 'function') {
      throw new Error('Import is not supported in this browser');
    }

    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: 'Mermaid Studio diagram',
          accept: { 'application/json': [DIAGRAM_EXTENSION, '.json'] },
        },
      ],
    });

    const file = await handle.getFile();
    const doc = parseDiagramDocument(await file.text());
    const existingNames = new Set(this.#diagrams.map((diagram) => diagram.filename));
    const filename = filenameForDiagram(doc.name, existingNames);

    if (this.#mode === 'filesystem' && this.#dirHandle) {
      const newHandle = await this.#dirHandle.getFileHandle(filename, { create: true });
      const writable = await newHandle.createWritable();
      await writable.write(serializeDiagramDocument({ ...doc, name: doc.name }));
      await writable.close();
      await this.#scanDirectory();
    } else {
      const store = readLocalWorkspace();
      if (!store.files) store.files = {};
      store.files[filename] = serializeDiagramDocument({ ...doc, name: doc.name });
      writeLocalWorkspace(store);
      await this.#loadLocalWorkspace();
    }

    const created = this.#diagrams.find((diagram) => diagram.filename === filename);
    if (created) {
      this.activeId = created.id;
      localStorage.setItem(ACTIVE_DIAGRAM_KEY, created.id);
    }

    this.#emit();
    return this.getActiveDiagramMeta();
  }

  setActiveId(id) {
    if (!this.#diagrams.some((diagram) => diagram.id === id)) return;
    this.activeId = id;
    localStorage.setItem(ACTIVE_DIAGRAM_KEY, id);
    this.#emit();
  }

  async renameDiagram(id, nextName) {
    const trimmed = String(nextName || '').trim();
    if (!trimmed) {
      throw new Error('Diagram name is required');
    }

    const meta = this.#diagrams.find((diagram) => diagram.id === id);
    if (!meta) {
      throw new Error('Diagram not found');
    }

    if (meta.name === trimmed) {
      return meta;
    }

    const doc = await this.readDiagram(id);
    doc.name = trimmed;

    const existingFilenames = new Set(
      this.#diagrams.filter((diagram) => diagram.id !== id).map((diagram) => diagram.filename),
    );
    const nextFilename = filenameForDiagram(trimmed, existingFilenames);
    const payload = serializeDiagramDocument(doc);

    if (nextFilename !== meta.filename) {
      if (this.#mode === 'filesystem' && this.#dirHandle) {
        const newHandle = await this.#dirHandle.getFileHandle(nextFilename, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(payload);
        await writable.close();
        await this.#dirHandle.removeEntry(meta.filename);
        await this.#scanDirectory();
      } else {
        const store = readLocalWorkspace();
        if (!store.files) store.files = {};
        store.files[nextFilename] = payload;
        delete store.files[meta.filename];
        writeLocalWorkspace(store);
        await this.#loadLocalWorkspace();
      }

      if (this.activeId === id) {
        this.activeId = nextFilename;
        localStorage.setItem(ACTIVE_DIAGRAM_KEY, nextFilename);
      }
    } else if (this.#mode === 'filesystem' && this.#dirHandle) {
      const handle = await this.#dirHandle.getFileHandle(meta.filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
      meta.name = trimmed;
      meta.updatedAt = doc.updatedAt;
      this.#diagrams = sortDiagrams(this.#diagrams);
    } else {
      await this.writeDiagram(id, doc);
    }

    this.#emit();
    return this.#diagrams.find((diagram) => diagram.id === nextFilename || diagram.id === id) || null;
  }

  async ensureDefaultDiagram(legacySource, legacySettings, legacyLayout) {
    if (this.#diagrams.length > 0) {
      if (!this.activeId || !this.#diagrams.some((diagram) => diagram.id === this.activeId)) {
        this.activeId = this.#diagrams[0].id;
        localStorage.setItem(ACTIVE_DIAGRAM_KEY, this.activeId);
      }
      return this.getActiveDiagramMeta();
    }

    return this.createDiagram('Untitled', {
      source: legacySource,
      settings: legacySettings,
      layout: legacyLayout,
    });
  }

  async #ensurePermission(handle, mode = 'readwrite') {
    if (!handle) return false;
    const options = { mode };
    if ((await handle.queryPermission(options)) === 'granted') {
      return true;
    }
    return (await handle.requestPermission(options)) === 'granted';
  }

  async #scanDirectory() {
    if (!this.#dirHandle) {
      this.#diagrams = [];
      return;
    }

    const diagrams = [];
    for await (const [name, handle] of this.#dirHandle.entries()) {
      if (handle.kind !== 'file' || !name.endsWith(DIAGRAM_EXTENSION)) continue;

      try {
        const file = await handle.getFile();
        const doc = parseDiagramDocument(await file.text());
        diagrams.push({
          id: name,
          filename: name,
          name: doc.name,
          updatedAt: doc.updatedAt,
        });
      } catch {
        diagrams.push({
          id: name,
          filename: name,
          name: name.replace(DIAGRAM_EXTENSION, ''),
          updatedAt: null,
          invalid: true,
        });
      }
    }

    this.#diagrams = sortDiagrams(diagrams);
  }

  async #loadLocalWorkspace() {
    const store = readLocalWorkspace();
    const files = store.files || {};
    this.#diagrams = sortDiagrams(
      Object.keys(files).map((filename) => {
        try {
          const doc = parseDiagramDocument(files[filename]);
          return {
            id: filename,
            filename,
            name: doc.name,
            updatedAt: doc.updatedAt,
          };
        } catch {
          return {
            id: filename,
            filename,
            name: filename.replace(DIAGRAM_EXTENSION, ''),
            updatedAt: null,
            invalid: true,
          };
        }
      }),
    );
    this.#mode = 'local';
  }
}

export const workspace = new DiagramWorkspace();
