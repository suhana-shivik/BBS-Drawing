// The BIM model — one model, multiple views. All 2D/3D/property views
// read from this class; all mutations go through it (wrapped in commands).
//
// PORTED from SOURCE/src/core/model.ts. One addition for this rebuild: the
// optional R1 project-identity fields (client / projectNumber / archived) are
// carried through the constructor and `toJSON`, because in this repo the
// studio project registry stores them on the same ProjectData row. Without
// that, one autosave round-trip through the model would silently drop a
// project's client and number. They are emitted only when present, so the
// serialized shape is unchanged for projects that do not carry them.
import type {
  AnyElement,
  DoorElement,
  Level,
  ProjectData,
  ProjectSettings,
  WallElement,
  WindowElement,
} from './types';
import { ptsEqual } from './geometry';

export type ModelListener = () => void;

export class BIMModel {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  settings: ProjectSettings;
  levels: Level[];
  /** R1 — studio project identity, passed through untouched */
  client?: string;
  projectNumber?: string;
  archived?: boolean;
  /** bumped on every change — use for React subscriptions and cache invalidation */
  version = 0;

  private elements = new Map<string, AnyElement>();
  private listeners = new Set<ModelListener>();
  private txDepth = 0;
  private txDirty = false;

  constructor(data: ProjectData) {
    this.id = data.id;
    this.name = data.name;
    this.createdAt = data.createdAt;
    this.modifiedAt = data.modifiedAt;
    this.settings = { ...data.settings };
    this.levels = data.levels.map((l) => ({ ...l }));
    if (data.client !== undefined) this.client = data.client;
    if (data.projectNumber !== undefined) this.projectNumber = data.projectNumber;
    if (data.archived !== undefined) this.archived = data.archived;
    for (const el of data.elements) {
      this.elements.set(el.id, structuredClone(el));
    }
  }

  static fromJSON(data: ProjectData): BIMModel {
    return new BIMModel(data);
  }

  toJSON(): ProjectData {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      settings: { ...this.settings },
      levels: this.levels.map((l) => ({ ...l })),
      elements: this.all().map((el) => structuredClone(el)),
      ...(this.client !== undefined ? { client: this.client } : {}),
      ...(this.projectNumber !== undefined ? { projectNumber: this.projectNumber } : {}),
      ...(this.archived !== undefined ? { archived: this.archived } : {}),
    };
  }

  // ---------------- subscriptions ----------------

  subscribe = (fn: ModelListener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** call after any mutation */
  touch(): void {
    this.modifiedAt = Date.now();
    this.version += 1;
    if (this.txDepth > 0) {
      this.txDirty = true;
      return;
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** batch several mutations into one notification */
  transaction<T>(fn: () => T): T {
    this.txDepth += 1;
    try {
      return fn();
    } finally {
      this.txDepth -= 1;
      if (this.txDepth === 0 && this.txDirty) {
        this.txDirty = false;
        this.emit();
      }
    }
  }

  // ---------------- queries ----------------

  get(id: string): AnyElement | undefined {
    return this.elements.get(id);
  }

  all(): AnyElement[] {
    return [...this.elements.values()];
  }

  byType<T extends AnyElement>(type: T['type']): T[] {
    const out: T[] = [];
    for (const el of this.elements.values()) {
      if (el.type === type) out.push(el as T);
    }
    return out;
  }

  onLevel(levelId: string): AnyElement[] {
    return this.all().filter((el) => el.levelId === levelId);
  }

  /** doors + windows hosted by a wall */
  hosted(wallId: string): (DoorElement | WindowElement)[] {
    const out: (DoorElement | WindowElement)[] = [];
    for (const el of this.elements.values()) {
      if ((el.type === 'door' || el.type === 'window') && el.hostWallId === wallId) {
        out.push(el);
      }
    }
    return out;
  }

  /** walls sharing an endpoint with the given wall (tolerance mm) */
  connectedWalls(wallId: string, tol = 10): WallElement[] {
    const w = this.get(wallId);
    if (!w || w.type !== 'wall') return [];
    const out: WallElement[] = [];
    for (const el of this.elements.values()) {
      if (el.type !== 'wall' || el.id === wallId) continue;
      if (
        ptsEqual(el.start, w.start, tol) ||
        ptsEqual(el.start, w.end, tol) ||
        ptsEqual(el.end, w.start, tol) ||
        ptsEqual(el.end, w.end, tol)
      ) {
        out.push(el);
      }
    }
    return out;
  }

  getLevel(id: string): Level | undefined {
    return this.levels.find((l) => l.id === id);
  }

  sortedLevels(): Level[] {
    return [...this.levels].sort((a, b) => a.elevation - b.elevation);
  }

  levelAbove(id: string): Level | undefined {
    const sorted = this.sortedLevels();
    const i = sorted.findIndex((l) => l.id === id);
    return i >= 0 ? sorted[i + 1] : undefined;
  }

  // ---------------- mutations ----------------
  // NOTE: application code should not call these directly — wrap them
  // in commands (src/core/commands.ts) so undo/redo works.

  add(els: AnyElement[]): void {
    for (const el of els) this.elements.set(el.id, structuredClone(el));
    this.touch();
  }

  update(id: string, patch: Record<string, unknown>): void {
    const el = this.elements.get(id);
    if (!el) return;
    Object.assign(el as unknown as Record<string, unknown>, structuredClone(patch));
    this.touch();
  }

  /**
   * Remove elements by id, cascading to hosted doors/windows of removed
   * walls. Returns everything actually removed (for undo).
   */
  remove(ids: string[]): AnyElement[] {
    const toRemove = new Set(ids);
    for (const id of ids) {
      const el = this.elements.get(id);
      if (el?.type === 'wall') {
        for (const h of this.hosted(id)) toRemove.add(h.id);
      }
    }
    const removed: AnyElement[] = [];
    for (const id of toRemove) {
      const el = this.elements.get(id);
      if (el) {
        removed.push(el);
        this.elements.delete(id);
      }
    }
    // detach dimension anchors that referenced removed elements
    for (const el of this.elements.values()) {
      if (el.type === 'dimension' && el.anchors) {
        const kept = el.anchors.filter((a) => !toRemove.has(a.elementId));
        if (kept.length !== el.anchors.length) el.anchors = kept;
      }
    }
    if (removed.length) this.touch();
    return removed;
  }

  addLevel(level: Level): void {
    this.levels.push({ ...level });
    this.touch();
  }

  updateLevel(id: string, patch: Partial<Level>): void {
    const l = this.getLevel(id);
    if (!l) return;
    Object.assign(l, patch);
    this.touch();
  }

  /** removes the level and every element on it; returns them for undo */
  removeLevel(id: string): { level: Level | undefined; removed: AnyElement[] } {
    const level = this.getLevel(id);
    if (!level) return { level: undefined, removed: [] };
    const ids = this.onLevel(id).map((el) => el.id);
    const removed = this.transaction(() => this.remove(ids));
    this.levels = this.levels.filter((l) => l.id !== id);
    this.touch();
    return { level, removed };
  }

  setName(name: string): void {
    this.name = name;
    this.touch();
  }

  updateSettings(patch: Partial<ProjectSettings>): void {
    Object.assign(this.settings, patch);
    this.touch();
  }
}
