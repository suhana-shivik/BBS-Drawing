// The CAD sheets open in this project.
//
// A real project is never one drawing — architectural, structural and MEP
// sheets describe the same building and the valuable questions are the
// cross-sheet ones ("does the foundation grid match the architectural grid?").
// So the session holds MANY documents but renders exactly ONE: only the active
// sheet gets a display list, because building 11k–69k draw ops per sheet is
// the expensive part and nobody looks at two sheets at once.
//
// Inactive sheets stay parsed and queryable — they cost memory, not frame time.
//
// `doc`, `regionId` and `hiddenLayers` remain on the session as views onto the
// ACTIVE sheet, so every existing consumer keeps working unchanged.
import { useSyncExternalStore } from 'react';
import type { CadDocument, CadEntity, CadLabel, DisplayList } from './types';
import { buildDisplayList } from './displayList';
import { framedBounds } from './bounds';
import { newId } from '../core/types';

export interface CadSheet {
  id: string;
  doc: CadDocument;
  /** view state is per sheet — switching back restores what you were doing */
  regionId: string | null;
  hiddenLayers: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  /** display list, built lazily and only while this sheet is active */
  list: DisplayList | null;
}

interface CadSession {
  sheets: CadSheet[];
  activeId: string | null;

  // ---- views onto the active sheet (kept for every existing consumer) ----
  doc: CadDocument | null;
  regionId: string | null;
  hiddenLayers: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  list: DisplayList | null;

  /** underlay drawn behind BIM geometry */
  visible: boolean;
  /**
   * Labels are PROJECT-wide, not per sheet: a block called MCB means the same
   * thing on every drawing in the set, and naming it twice would be a way for
   * two sheets to disagree.
   */
  labels: ReadonlyMap<string, CadLabel>;
  version: number;
  /**
   * Bumped whenever the view should re-fit — a drawing carries its own
   * coordinates, often far from the origin, so the editor must reframe or
   * it stares at empty space.
   */
  fitNonce: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

let session: CadSession = {
  sheets: [],
  activeId: null,
  doc: null,
  regionId: null,
  hiddenLayers: EMPTY_SET,
  selected: EMPTY_SET,
  list: null,
  visible: true,
  labels: new Map(),
  version: 0,
  fitNonce: 0,
};

const listeners = new Set<() => void>();

function activeSheet(): CadSheet | null {
  return session.sheets.find((s) => s.id === session.activeId) ?? null;
}

/** mirror the active sheet onto the flat fields, then notify */
function emit(): void {
  const a = activeSheet();
  session = {
    ...session,
    doc: a ? a.doc : null,
    regionId: a ? a.regionId : null,
    hiddenLayers: a ? a.hiddenLayers : EMPTY_SET,
    selected: a ? a.selected : EMPTY_SET,
    list: a ? a.list : null,
    version: session.version + 1,
  };
  for (const fn of [...listeners]) fn();
}

/** build the display list for the active sheet only */
function rebuild(): void {
  const a = activeSheet();
  if (!a) return;
  a.list = buildDisplayList(a.doc, {
    regionId: a.regionId,
    hiddenLayers: a.hiddenLayers,
    paper: false,
  });
  // an inactive sheet's list is dead weight; drop it so memory tracks what
  // is actually on screen rather than everything ever opened
  for (const s of session.sheets) if (s.id !== a.id) s.list = null;
}

export function getCadSession(): CadSession {
  return session;
}

export function useCadSession(): CadSession {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => session.version,
  );
  return session;
}

// ------------------------------------------------------------
// sheets
// ------------------------------------------------------------

/** Add a parsed drawing to the set and make it active. */
export function addCadSheet(doc: CadDocument): string {
  const id = newId('sheet');
  const sheet: CadSheet = {
    id,
    doc,
    // open on the WHOLE drawing, as a CAD viewer does; `cadBounds()` handles
    // runaway extents by framing rather than by hiding geometry
    regionId: null,
    hiddenLayers: EMPTY_SET,
    selected: EMPTY_SET,
    list: null,
  };
  session.sheets = [...session.sheets, sheet];
  session.activeId = id;
  session.fitNonce += 1;
  rebuild();
  emit();
  return id;
}

export function setActiveCadSheet(id: string): void {
  if (session.activeId === id) return;
  if (!session.sheets.some((s) => s.id === id)) return;
  session.activeId = id;
  session.fitNonce += 1;
  rebuild();
  emit();
}

export function closeCadSheet(id: string): void {
  const rest = session.sheets.filter((s) => s.id !== id);
  if (rest.length === session.sheets.length) return;
  session.sheets = rest;
  if (session.activeId === id) {
    session.activeId = rest.length ? rest[rest.length - 1].id : null;
    session.fitNonce += 1;
    rebuild();
  }
  emit();
}

/** every open sheet — the context a cross-sheet question needs */
export function cadSheets(): CadSheet[] {
  return session.sheets;
}

export function activeCadSheet(): CadSheet | null {
  return activeSheet();
}

/**
 * Replace the whole set. `null` clears.
 * Kept so the single-drawing import path reads the same as it did before.
 */
export function setCadDocument(doc: CadDocument | null): void {
  if (!doc) {
    session.sheets = [];
    session.activeId = null;
    session.fitNonce += 1;
    emit();
    return;
  }
  session.sheets = [];
  session.activeId = null;
  addCadSheet(doc);
}

// ------------------------------------------------------------
// active-sheet view state
// ------------------------------------------------------------

export function setCadRegion(regionId: string | null): void {
  const a = activeSheet();
  if (!a) return;
  a.regionId = regionId;
  session.fitNonce += 1;
  rebuild();
  emit();
}

export function setCadHiddenLayers(hidden: ReadonlySet<string>): void {
  const a = activeSheet();
  if (!a) return;
  a.hiddenLayers = hidden;
  rebuild();
  emit();
}

export function toggleCadLayer(name: string): void {
  const a = activeSheet();
  if (!a) return;
  const next = new Set(a.hiddenLayers);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  setCadHiddenLayers(next);
}

export function setCadVisible(visible: boolean): void {
  session.visible = visible;
  emit();
}

export function clearCadSession(): void {
  session.sheets = [];
  session.activeId = null;
  session.labels = new Map();
  emit();
}

/**
 * Bounds to frame the view on.
 *
 * Everything is still drawn — this only decides where to point the camera.
 * Drawings routinely carry a stray entity kilometres from the content (one
 * fixture has a single entity spanning 962 km); fitting that renders the real
 * drawing a few pixels wide. So the frame is taken from the geometry that is
 * actually drawn, with the extreme 1% trimmed and then grown back out to
 * include anything nearby — legitimately spread-out drawings keep their edges
 * while true strays stay on screen but out of frame.
 */
export function cadBounds(): { min: { x: number; y: number }; max: { x: number; y: number } } | null {
  const { list, regionId } = session;
  if (!list || list.ops.length === 0) return null;
  // an explicit region choice is honoured as-is
  if (regionId) return { min: list.min, max: list.max };
  // The rule itself lives in `framedBounds` — the studio sheet's viewBox
  // frames a drawing with the same one, and two copies of a percentile trim
  // this subtle would drift until the same drawing was framed two ways.
  return framedBounds(list) ?? { min: list.min, max: list.max };
}

// ------------------------------------------------------------
// selection (active sheet)
// ------------------------------------------------------------

export function setCadSelection(handles: Iterable<string>): void {
  const a = activeSheet();
  if (!a) return;
  a.selected = new Set(handles);
  emit();
}

export function toggleCadSelection(handle: string, additive: boolean): void {
  const a = activeSheet();
  if (!a) return;
  const next = new Set(additive ? a.selected : []);
  if (additive && next.has(handle)) next.delete(handle);
  else next.add(handle);
  a.selected = next;
  emit();
}

export function clearCadSelection(): void {
  const a = activeSheet();
  if (!a || a.selected.size === 0) return;
  a.selected = EMPTY_SET;
  emit();
}

/** entities matching the current selection, in document order */
export function selectedCadEntities(): CadEntity[] {
  const a = activeSheet();
  if (!a || a.selected.size === 0) return [];
  return a.doc.entities.filter((e) => a.selected.has(e.style.handle));
}

/** every entity sharing a layer, for "select similar" */
export function cadEntitiesOnLayer(layer: string): CadEntity[] {
  const a = activeSheet();
  return a ? a.doc.entities.filter((e) => e.style.layer === layer) : [];
}

/** every instance of a block, for "select similar" */
export function cadEntitiesOfBlock(name: string): CadEntity[] {
  const a = activeSheet();
  return a
    ? a.doc.entities.filter((e) => e.type === 'insert' && e.blockName === name)
    : [];
}

// ------------------------------------------------------------
// semantic labels (project-wide)
// ------------------------------------------------------------

export function setCadLabels(labels: ReadonlyMap<string, CadLabel>): void {
  session.labels = labels;
  emit();
}

export function setCadLabel(key: string, label: CadLabel | null): void {
  const next = new Map(session.labels);
  if (label) next.set(key, label);
  else next.delete(key);
  session.labels = next;
  emit();
}

/** display name for a block/layer key — the label if known, else the raw name */
export function cadDisplayName(key: string): string {
  return session.labels.get(key)?.label ?? key;
}
