const DEFAULT_MAX_SIZE = 20;

function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createLayoutHistory(maxSize = DEFAULT_MAX_SIZE) {
  let undoStack = [];
  let redoStack = [];

  return {
    canUndo() {
      return undoStack.length > 0;
    },

    canRedo() {
      return redoStack.length > 0;
    },

    clear() {
      undoStack = [];
      redoStack = [];
    },

    /** Record the layout state before a committed change. */
    pushBefore(snapshot) {
      const entry = cloneSnapshot(snapshot);
      if (undoStack.length > 0 && snapshotsEqual(undoStack[undoStack.length - 1], entry)) {
        return;
      }

      undoStack.push(entry);
      if (undoStack.length > maxSize) undoStack.shift();
      redoStack = [];
    },

    undo(currentSnapshot) {
      if (!undoStack.length) return null;

      const previous = undoStack.pop();
      redoStack.push(cloneSnapshot(currentSnapshot));
      if (redoStack.length > maxSize) redoStack.shift();
      return previous;
    },

    redo(currentSnapshot) {
      if (!redoStack.length) return null;

      const next = redoStack.pop();
      undoStack.push(cloneSnapshot(currentSnapshot));
      if (undoStack.length > maxSize) undoStack.shift();
      return next;
    },
  };
}
