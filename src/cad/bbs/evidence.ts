// ============================================================
// The evidence graph — stable, semantic, addressable drawing facts.
//
// WHY RAW HANDLES ARE NOT ENOUGH
//
// Until now the model pointed at a DXF handle and a number index:
// `{handle: "78E09", part: 1}`. That is enough to read one number out of one
// string, and nothing else. It cannot express:
//
//   · which two points a dimension SPANS, so a chain cannot be walked
//   · which panel a callout sits in, so a bar cannot be tied to the detail
//     that draws it rather than to a mark string on the far side of the sheet
//   · what a leader POINTS AT, so "this callout belongs to that member" has no
//     evidence behind it beyond proximity
//   · the ORDER of a mark's occurrences along a layout, so an alternating
//     C1/SC/C2 sequence is indistinguishable from a bag of tags
//
// Every one of those is a relationship, and a handle carries no relationships.
//
// So the drawing is indexed ONCE into nodes with stable ids — DIM-017,
// CALL-032, MARK-C1-004, PANEL-3 — and the relationships are computed
// deterministically from geometry. The model is shown ids and picks between
// them; it never sees a handle and never types a coordinate.
//
// WHAT MAKES A DIMENSION USABLE
//
// A dimension record carries where it spans; the number it ASSERTS is the text
// drawn inside its own anonymous block. Pairing the two is what turns "a 1500
// somewhere near the section" into "the 1500 spanning (x1,y1)-(x2,y2) on the
// y axis inside PANEL-1". The written text is authoritative — a dimension
// style can carry a linear scale factor, and the yard cuts to what is printed,
// not to what the geometry happens to measure.
//
// IDS ARE STABLE. They are assigned in sorted order over the drawing's own
// handles, never in walk order, so the same file indexes to the same ids on
// every run. A truth fixture that names DIM-017 must keep meaning it.
// ============================================================
import type { CadDocument, Vec2 } from '../types';
import { dimensionAxis, type CadDimensionRecord } from '../dxf/annotations';
import { harvestTexts, type TextCell } from './extract';
import type { DrawingExtract } from './types';

export type EvidenceKind =
  | 'text'
  | 'dimension'
  | 'leader'
  | 'mark'
  | 'callout'
  | 'declaration'
  | 'geometry'
  | 'panel'
  | 'userFact'
  | 'convention';

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EvidenceNode {
  /** stable across runs of the same file — see the header */
  id: string;
  kind: EvidenceKind;
  /** DXF handles behind it; internal, never shown to the model */
  sourceHandles: string[];
  panelId?: string;
  bbox?: Bounds;
  position?: Vec2;
  /** every number in the raw text, in written order */
  valueParts?: number[];
  rawText?: string;
  metadata: Record<string, unknown>;
}

export type EvidenceRelation =
  | 'in-panel'
  /** a leader carries this annotation text */
  | 'carries'
  /** a leader's arrow lands on this node */
  | 'points-at'
  /** ordered occurrences of one mark along a layout axis */
  | 'next-in-order'
  /** a dimension's endpoint coincides with another dimension's endpoint */
  | 'connects-to';

export interface EvidenceEdge {
  from: string;
  to: string;
  rel: EvidenceRelation;
  metadata?: Record<string, unknown>;
}

export interface DimensionEvidence extends EvidenceNode {
  kind: 'dimension';
  /** the value the sheet PRINTS, mm */
  valueMm: number;
  axis: 'x' | 'y' | null;
  from: Vec2;
  to: Vec2;
}

/** something the drawing carries that could not be turned into usable evidence */
export interface EvidenceDiagnostic {
  /** the node id it was recorded under, so it can still be pointed at */
  id: string;
  handle: string;
  reason: string;
}

export interface EvidenceGraph {
  nodes: readonly EvidenceNode[];
  edges: readonly EvidenceEdge[];
  byId: ReadonlyMap<string, EvidenceNode>;
  /** only dimensions that are fully readable — the ONLY ones that can be summed */
  dimensions: readonly DimensionEvidence[];
  /**
   * Everything the sheet carries that could not be read. Never empty by
   * accident: a silent drop is indistinguishable from a clean sheet, and the
   * count is what tells a reviewer whether the extraction is trustworthy.
   */
  diagnostics: readonly EvidenceDiagnostic[];
  /** node ids related to `id` by `rel` */
  related(id: string, rel: EvidenceRelation): EvidenceNode[];
  /** every node inside a panel */
  inPanel(panelId: string): EvidenceNode[];
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

/** endpoints closer than this are the same point — CAD chains are exact */
const JOIN_TOL_MM = 2;
/**
 * How far apart, PERPENDICULAR to their axis, two segments of one chain may
 * sit and still be the same chain. Generous enough for extension lines that
 * touch opposite faces of a wall; far short of joining two unrelated chains
 * on opposite sides of a sheet.
 */
const PERP_TOL_MM = 1500;
/** a leader arrow lands on whatever is within this of it */
const LEADER_HIT_MM = 600;

const pad = (n: number, w = 3): string => String(n).padStart(w, '0');

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const inBox = (p: Vec2, b: Bounds): boolean =>
  p.x >= Math.min(b.x1, b.x2) &&
  p.x <= Math.max(b.x1, b.x2) &&
  p.y >= Math.min(b.y1, b.y2) &&
  p.y <= Math.max(b.y1, b.y2);

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export interface PanelInput {
  id?: string;
  caption: string;
  box: Bounds;
}

export interface BuildEvidenceOptions {
  panels?: readonly PanelInput[];
  /** transcript-verified user facts, keyed by id */
  userFacts?: Readonly<Record<string, number>>;
  /** stated project conventions, keyed by name */
  conventions?: Readonly<Record<string, number | string>>;
}

/**
 * The measurement a dimension asserts, taken from the text it DRAWS.
 *
 * Pairing is by position: code 11 is the middle of the measurement text, and
 * the text harvested from the anonymous block sits exactly there. A dimension
 * whose text cannot be found asserts nothing we are willing to use — it is
 * recorded with no value rather than with a value derived from geometry that a
 * dimension style may have scaled.
 */
function pairDimensionText(
  d: CadDimensionRecord,
  texts: readonly TextCell[],
): { text: TextCell; valueMm: number } | null {
  if (!d.textPoint) return null;
  let best: TextCell | null = null;
  let bestD = Infinity;
  for (const t of texts) {
    const dd = dist(t, d.textPoint);
    if (dd < bestD) {
      bestD = dd;
      best = t;
    }
  }
  if (!best || bestD > 200) return null;
  const nums = numbersIn(best.text);
  if (nums.length !== 1) return null; // "300" is a dimension; "2-16TOR" is not
  const v = nums[0];
  return v > 0 ? { text: best, valueMm: v } : null;
}

/**
 * Index one drawing into addressable evidence.
 *
 * Pure and deterministic: same file in, same ids out. No model call happens
 * here — the graph is what the model is shown, not something it produces.
 */
export function buildEvidenceGraph(
  doc: CadDocument,
  extract: DrawingExtract,
  opts: BuildEvidenceOptions = {},
): EvidenceGraph {
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const diagnostics: EvidenceDiagnostic[] = [];
  const texts = harvestTexts(doc);
  const byHandle = new Map<string, TextCell>();
  for (const t of texts) if (!byHandle.has(t.handle)) byHandle.set(t.handle, t);

  // ---- panels first: everything else is placed relative to them ----
  const panels: { id: string; caption: string; box: Bounds }[] = [];
  (opts.panels ?? []).forEach((p, i) => {
    const id = p.id ?? `PANEL-${pad(i + 1, 2)}`;
    panels.push({ id, caption: p.caption, box: p.box });
    nodes.push({
      id,
      kind: 'panel',
      sourceHandles: [],
      bbox: p.box,
      rawText: p.caption,
      metadata: { caption: p.caption },
    });
  });
  const panelOf = (p: Vec2 | undefined): string | undefined => {
    if (!p) return undefined;
    // smallest containing panel wins — a detail inside a layout belongs to the
    // detail, which is the finer-grained and more useful answer
    let hit: { id: string; area: number } | undefined;
    for (const q of panels) {
      if (!inBox(p, q.box)) continue;
      const area = Math.abs((q.box.x2 - q.box.x1) * (q.box.y2 - q.box.y1));
      if (!hit || area < hit.area) hit = { id: q.id, area };
    }
    return hit?.id;
  };

  // ---- dimensions ----
  const dims: DimensionEvidence[] = [];
  const dimRecords = [...(doc.annotations?.dimensions ?? [])].sort((a, b) =>
    a.handle.localeCompare(b.handle),
  );
  dimRecords.forEach((d, i) => {
    const paired = pairDimensionText(d, texts);
    // A dimension we cannot fully read is still RECORDED — never dropped.
    //
    // Dropping it made it unaddressable: it could not be pointed at, could not
    // be repaired, and did not appear in any count, so a sheet with five
    // unreadable dimensions looked identical to a sheet with none. It stays a
    // node so a repair task can name it and get a reason back; it stays out of
    // `dimensions` so nothing can ever sum it.
    if (!paired || !d.from || !d.to) {
      const why = !d.from || !d.to
        ? 'the file records no span for it (extension-line origins absent)'
        : 'no single number could be paired with it — its text is absent, ' +
          'shared, or not a plain measurement';
      const id = `DIM-X${pad(diagnostics.length + 1, 2)}`;
      diagnostics.push({ id, handle: d.handle, reason: why });
      nodes.push({
        id,
        kind: 'dimension',
        sourceHandles: [d.handle],
        panelId: panelOf(d.textPoint ?? d.linePoint),
        position: d.textPoint ?? d.linePoint,
        metadata: { unusable: why, layer: d.layer, index: i },
      });
      return;
    }
    const id = `DIM-${pad(dims.length + 1)}`;
    const position = d.textPoint ?? d.from;
    const node: DimensionEvidence = {
      id,
      kind: 'dimension',
      sourceHandles: [d.handle, paired.text.handle],
      panelId: panelOf(position),
      position,
      valueParts: [paired.valueMm],
      rawText: paired.text.text,
      valueMm: paired.valueMm,
      axis: dimensionAxis(d),
      from: d.from,
      to: d.to,
      metadata: { kind: d.kind, layer: d.layer, index: i },
    };
    dims.push(node);
    nodes.push(node);
  });

  // dimension chains: an endpoint shared with another dimension's endpoint is
  // what makes a chain walkable, and it is the only thing that lets a summed
  // height be VERIFIED rather than asserted
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < dims.length; j++) {
      const a = dims[i];
      const b = dims[j];
      if (a.axis !== b.axis || !a.axis) continue;
      // Along the axis only, with a bounded perpendicular allowance: a chain's
      // extension lines touch different faces, so segments that plainly
      // continue one another sit tens of millimetres apart sideways. Judging
      // that in 2D rejected real chains — see refs.ts for the same reasoning
      // on the resolving side.
      const k = a.axis;
      const perp = a.axis === 'x' ? 'y' : 'x';
      const ends = (d: DimensionEvidence): [number, number] => [
        Math.min(d.from[k], d.to[k]),
        Math.max(d.from[k], d.to[k]),
      ];
      const [aLo, aHi] = ends(a);
      const [bLo, bHi] = ends(b);
      const perpGap = Math.abs(
        (a.from[perp] + a.to[perp]) / 2 - (b.from[perp] + b.to[perp]) / 2,
      );
      const touches =
        perpGap <= PERP_TOL_MM &&
        (Math.abs(aHi - bLo) <= JOIN_TOL_MM || Math.abs(bHi - aLo) <= JOIN_TOL_MM);
      if (touches) {
        edges.push({ from: a.id, to: b.id, rel: 'connects-to' });
        edges.push({ from: b.id, to: a.id, rel: 'connects-to' });
      }
    }
  }

  // ---- callouts ----
  extract.callouts.forEach((c, i) => {
    const id = `CALL-${pad(i + 1)}`;
    nodes.push({
      id,
      kind: 'callout',
      sourceHandles: [c.handle],
      panelId: panelOf(c.position),
      position: c.position,
      rawText: c.raw,
      valueParts: numbersIn(c.raw),
      metadata: {
        diaMm: c.diaMm,
        spacingMm: c.spacingMm,
        count: c.count,
        legs: c.legs,
        secondDiaMm: c.secondDiaMm,
        secondCount: c.secondCount,
        zone: c.zone,
      },
    });
  });

  // ---- declared members ----
  (extract.declared ?? []).forEach((d, i) => {
    const first = d.handles?.[0] ? byHandle.get(d.handles[0]) : undefined;
    nodes.push({
      id: `DECL-${pad(i + 1, 2)}`,
      kind: 'declaration',
      sourceHandles: d.handles ?? [],
      panelId: panelOf(first),
      position: first ? { x: first.x, y: first.y } : undefined,
      rawText: d.raw,
      valueParts: d.dimsMm,
      metadata: { name: d.name, sizeText: d.sizeText, occurrences: d.occurrences },
    });
  });

  // ---- mark occurrences, ORDERED ----
  //
  // The order is the point. A layout that reads C1 · SC · C2 · SC · C1 is a
  // periodic pattern; the same tags as an unordered bag are just counts, and
  // counting each mark independently against one pitch is how a boundary wall
  // ends up with a footing under every stub column.
  const markSet = new Set((extract.marks ?? []).map((m) => m.toUpperCase()));
  const occurrences = new Map<string, TextCell[]>();
  for (const t of texts) {
    const key = t.text.trim().toUpperCase().replace(/[.\s]/g, '');
    for (const m of markSet) {
      if (key === m.replace(/[.\s]/g, '')) {
        const list = occurrences.get(m) ?? [];
        list.push(t);
        occurrences.set(m, list);
      }
    }
  }
  for (const mark of [...occurrences.keys()].sort()) {
    const list = occurrences.get(mark)!;
    // along the layout's dominant axis; ties broken by the other axis so the
    // order is total and therefore stable
    const spanX = Math.max(...list.map((t) => t.x)) - Math.min(...list.map((t) => t.x));
    const spanY = Math.max(...list.map((t) => t.y)) - Math.min(...list.map((t) => t.y));
    const axis: 'x' | 'y' = spanX >= spanY ? 'x' : 'y';
    const sorted = [...list].sort((a, b) => (axis === 'x' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    let prev: string | null = null;
    sorted.forEach((t, i) => {
      const id = `MARK-${mark}-${pad(i + 1)}`;
      nodes.push({
        id,
        kind: 'mark',
        sourceHandles: [t.handle],
        panelId: panelOf(t),
        position: { x: t.x, y: t.y },
        rawText: t.text.trim(),
        metadata: {
          mark,
          axis,
          ordinal: i + 1,
          of: sorted.length,
          // A MARK PRINTED INSIDE A SCHEDULE TABLE IS A ROW LABEL, NOT A
          // LOCATION. "F1" at the head of the FOOTING SCHEDULE row names the
          // member the row describes; counting it as a placement put one
          // extra footing under every mark on the layout. Placement skips
          // these; the callout cells in the same row still tie ownership.
          inTable: (extract.tables ?? []).some(
            (tb) => t.x >= tb.min.x && t.x <= tb.max.x && t.y >= tb.min.y && t.y <= tb.max.y,
          ),
        },
      });
      if (prev) edges.push({ from: prev, to: id, rel: 'next-in-order' });
      prev = id;
    });
  }

  // ---- leaders: what a text REFERS TO ----
  const leaders = [...(doc.annotations?.leaders ?? [])].sort((a, b) =>
    a.handle.localeCompare(b.handle),
  );
  leaders.forEach((l, i) => {
    const id = `LEAD-${pad(i + 1, 3)}`;
    const arrow = l.vertices[0];
    const tail = l.vertices[l.vertices.length - 1];
    nodes.push({
      id,
      kind: 'leader',
      sourceHandles: [l.handle],
      panelId: panelOf(arrow),
      position: arrow,
      metadata: { vertices: l.vertices.length, layer: l.layer },
    });
    // the text it carries sits at the TAIL; the thing it means sits at the ARROW
    let carried: EvidenceNode | undefined;
    let carriedD = Infinity;
    for (const n of nodes) {
      if (n.kind !== 'callout' && n.kind !== 'text' && n.kind !== 'mark') continue;
      if (!n.position) continue;
      const dd = dist(n.position, tail);
      if (dd < carriedD) {
        carriedD = dd;
        carried = n;
      }
    }
    if (carried && carriedD <= LEADER_HIT_MM) {
      edges.push({ from: id, to: carried.id, rel: 'carries' });
      // and therefore: that annotation POINTS AT whatever the arrow reaches
      edges.push({
        from: carried.id,
        to: id,
        rel: 'points-at',
        metadata: { arrow, distanceMm: Math.round(carriedD) },
      });
    }
  });

  // ---- user facts and conventions: provenance for numbers not on the sheet ----
  for (const [key, value] of Object.entries(opts.userFacts ?? {})) {
    nodes.push({
      id: `FACT-${key}`,
      kind: 'userFact',
      sourceHandles: [],
      valueParts: [value],
      rawText: String(value),
      metadata: { factId: key },
    });
  }
  for (const [key, value] of Object.entries(opts.conventions ?? {})) {
    nodes.push({
      id: `CONV-${key}`,
      kind: 'convention',
      sourceHandles: [],
      valueParts: typeof value === 'number' ? [value] : undefined,
      rawText: String(value),
      metadata: { convention: key },
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    edges,
    byId,
    dimensions: dims,
    diagnostics,
    related(id, rel) {
      return edges
        .filter((e) => e.from === id && e.rel === rel)
        .map((e) => byId.get(e.to))
        .filter((n): n is EvidenceNode => !!n);
    },
    inPanel(panelId) {
      return nodes.filter((n) => n.panelId === panelId);
    },
  };
}
