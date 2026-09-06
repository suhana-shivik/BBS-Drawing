// Command system — every model mutation goes through a Command so that
// undo/redo, history and (later) collaboration/versioning work uniformly.
//
// PORTED verbatim from SOURCE/src/core/commands.ts. The only addition is the
// `undoName` / `redoName` pair below: the studio shell names its Undo and Redo
// controls ("Undo — Draw wall"), which SOURCE's `history` getter could only
// answer for one direction.
import type { AnyElement, Level } from './types';
import { BIMModel } from './model';

export interface Command {
  name: string;
  execute(m: BIMModel): void;
  undo(m: BIMModel): void;
}

export class CommandStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private limit = 200;

  run(m: BIMModel, cmd: Command): void {
    m.transaction(() => cmd.execute(m));
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(m: BIMModel): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    m.transaction(() => cmd.undo(m));
    this.redoStack.push(cmd);
  }

  redo(m: BIMModel): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    m.transaction(() => cmd.execute(m));
    this.undoStack.push(cmd);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get history(): string[] {
    return this.undoStack.map((c) => c.name);
  }

  /** Added in the rebuild — what the next undo would actually undo. */
  get undoName(): string | null {
    const cmd = this.undoStack[this.undoStack.length - 1];
    return cmd ? cmd.name : null;
  }

  /** Added in the rebuild — what the next redo would re-apply. */
  get redoName(): string | null {
    const cmd = this.redoStack[this.redoStack.length - 1];
    return cmd ? cmd.name : null;
  }
}

// ------------------------------------------------------------
// Command factories
// ------------------------------------------------------------

export function cmdAddElements(els: AnyElement[], name = 'Add'): Command {
  const snapshot = els.map((e) => structuredClone(e));
  return {
    name,
    execute(m) {
      m.add(snapshot.map((e) => structuredClone(e)));
    },
    undo(m) {
      m.remove(snapshot.map((e) => e.id));
    },
  };
}

export function cmdDeleteElements(ids: string[], name = 'Delete'): Command {
  let removed: AnyElement[] = [];
  return {
    name,
    execute(m) {
      removed = m.remove(ids).map((e) => structuredClone(e));
    },
    undo(m) {
      m.add(removed.map((e) => structuredClone(e)));
    },
  };
}

/** captures the previous values of the patched keys at first execution */
export function cmdUpdateElement(
  id: string,
  patch: Record<string, unknown>,
  name = 'Edit',
): Command {
  let before: Record<string, unknown> | null = null;
  return {
    name,
    execute(m) {
      if (before === null) {
        const el = m.get(id);
        before = {};
        if (el) {
          const rec = el as unknown as Record<string, unknown>;
          for (const k of Object.keys(patch)) before[k] = structuredClone(rec[k]);
        }
      }
      m.update(id, patch);
    },
    undo(m) {
      if (before) m.update(id, before);
    },
  };
}

export function cmdUpdateMany(
  entries: { id: string; patch: Record<string, unknown> }[],
  name = 'Edit',
): Command {
  const cmds = entries.map((e) => cmdUpdateElement(e.id, e.patch, name));
  return cmdComposite(name, cmds);
}

export function cmdComposite(name: string, cmds: Command[]): Command {
  return {
    name,
    execute(m) {
      for (const c of cmds) c.execute(m);
    },
    undo(m) {
      for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo(m);
    },
  };
}

export function cmdAddLevel(level: Level): Command {
  const snap = { ...level };
  return {
    name: 'Add level',
    execute(m) {
      m.addLevel({ ...snap });
    },
    undo(m) {
      m.removeLevel(snap.id);
    },
  };
}

export function cmdUpdateLevel(id: string, patch: Partial<Level>): Command {
  let before: Partial<Level> | null = null;
  return {
    name: 'Edit level',
    execute(m) {
      if (before === null) {
        const l = m.getLevel(id);
        before = {};
        if (l) {
          const rec = l as unknown as Record<string, unknown>;
          const b = before as Record<string, unknown>;
          for (const k of Object.keys(patch)) b[k] = rec[k];
        }
      }
      m.updateLevel(id, patch);
    },
    undo(m) {
      if (before) m.updateLevel(id, before);
    },
  };
}

export function cmdDeleteLevel(id: string): Command {
  let level: Level | undefined;
  let removed: AnyElement[] = [];
  return {
    name: 'Delete level',
    execute(m) {
      const res = m.removeLevel(id);
      level = res.level;
      removed = res.removed.map((e) => structuredClone(e));
    },
    undo(m) {
      if (level) m.addLevel(level);
      if (removed.length) m.add(removed.map((e) => structuredClone(e)));
    },
  };
}
