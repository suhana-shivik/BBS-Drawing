// Deterministic extraction: what the drawing SAYS.
//
// This layer reads text off a parsed DXF and hands it on verbatim. It assigns
// no meaning (which callout belongs to which member, what kind of bar it is)
// and it computes no length — those belong to the AI pass and to the engine
// respectively. Everything here is reproducible from the file alone, so a
// number that later turns out wrong is traceable to a handle on the sheet.
//
// ── UNITS, the one thing that is easy to get backwards ───────────────────────
// `CadDocument.unitScale` is millimetres per drawing unit, after `dxf/units.ts`
// has checked the header's claim against the drawing itself (structural DXFs
// routinely declare inches while dimensioned in mm).
//
//   GEOMETRY  — coordinates, text heights, bounds — is in source units and
//               MUST be multiplied by unitScale to become millimetres.
//   TEXT      — "730x1275", "10-20+14-16", "@100 c/c" — is already millimetres
//               as the detailer wrote it and MUST NOT be scaled. Scaling it by
//               a lying inch header makes every bar 25.4x wrong.
//
// Positions, heights and bounds below are therefore scaled; nothing parsed out
// of a string ever is.
import type { CadDocument, CadEntity, Vec2 } from '../types';
import type {
  DrawingExtract,
  ExtractedCallout,
  ExtractedNotes,
  ExtractedTable,
} from './types';
import { compose, apply, type Xform } from '../displayList';
import { hasCalloutMarker, parseCallout, parsedAnything } from './callout';

// ------------------------------------------------------------
// limits — a 10 MB sheet must not turn into an unbounded walk
// ------------------------------------------------------------

const MAX_BLOCK_DEPTH = 6;
const MAX_VISITS = 2_000_000;
const MAX_TEXTS = 60_000;
const MAX_SEGMENTS = 400_000;
const MAX_TABLES = 40;
const MAX_NOTE_LINES = 250;

// ------------------------------------------------------------
// text harvesting
// ------------------------------------------------------------

/** one TEXT/MTEXT line, resolved into world millimetres */
export interface TextCell {
  /** the line as written, whitespace-collapsed; never re-spelled */
  text: string;
  /** insertion/alignment point, mm */
  x: number;
  y: number;
  /** left and right edge of the drawn string, mm — estimated, for columns */
  x0: number;
  x1: number;
  /** cap height, mm */
  height: number;
  /** world rotation, radians */
  rotation: number;
  layer: string;
  handle: string;
}

/**
 * Average glyph advance as a fraction of cap height. AutoCAD's stock SHX fonts
 * sit near 0.6; the exact figure only has to be good enough to tell one table
 * column from the next, and erring narrow keeps neighbouring columns apart.
 */
const GLYPH_ADVANCE = 0.62;

const scaleOf = (m: Xform): number =>
  (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;

function pushLines(
  out: TextCell[],
  raw: string,
  p: Vec2,
  height: number,
  rotation: number,
  widthFactor: number,
  hAlign: 'left' | 'center' | 'right',
  layer: string,
  handle: string,
): void {
  // A multi-line MTEXT carries one annotation per line far more often than one
  // annotation spread over lines, so each line is a candidate in its own right.
  // They share a handle and an insertion point: click-to-verify still lands on
  // the entity the text came from.
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const text = line.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const w = text.length * height * GLYPH_ADVANCE * (widthFactor || 1);
    const x0 = hAlign === 'left' ? p.x : hAlign === 'center' ? p.x - w / 2 : p.x - w;
    out.push({
      text,
      x: p.x,
      y: p.y,
      x0,
      x1: x0 + w,
      height,
      rotation,
      layer,
      handle,
    });
    if (out.length >= MAX_TEXTS) return;
  }
}

/**
 * Every text in modelspace, with a world position in millimetres.
 *
 * INSERTs are followed with the same transform composition the display list
 * uses, because schedules and title blocks are very often blocks — a table
 * skipped here is a table the schedule silently loses. Nothing is filtered:
 * "730x1275" is numeric and would be dropped by the AI digest's noise filter,
 * and it is exactly the cell a BBS needs.
 */
export function harvestTexts(doc: CadDocument): TextCell[] {
  const out: TextCell[] = [];
  const k = doc.unitScale || 1; // source units → mm
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };
  let visits = 0;

  const walk = (e: CadEntity, xf: Xform, depth: number, path: ReadonlySet<string>): void => {
    if (visits++ > MAX_VISITS || out.length >= MAX_TEXTS) return;

    if (e.type === 'text') {
      const p = apply(xf, e.position);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const s = scaleOf(xf);
      pushLines(
        out,
        e.text,
        p,
        Math.abs(e.height) * s,
        e.rotation + Math.atan2(xf.b, xf.a),
        e.widthFactor,
        e.hAlign,
        e.style.layer,
        e.style.handle,
      );
      return;
    }

    if (e.type !== 'insert' || depth >= MAX_BLOCK_DEPTH) return;
    const key = e.blockName.toUpperCase();
    if (path.has(key)) return; // self-referencing block
    const block = doc.blocks.get(key);
    if (!block) return;

    const cos = Math.cos(e.rotation);
    const sin = Math.sin(e.rotation);
    const sx = e.scale.x || 1;
    const sy = e.scale.y || 1;
    const local: Xform = {
      a: cos * sx, b: sin * sx,
      c: -sin * sy, d: cos * sy,
      e: e.position.x - (cos * sx * block.basePoint.x - sin * sy * block.basePoint.y),
      f: e.position.y - (sin * sx * block.basePoint.x + cos * sy * block.basePoint.y),
    };
    const next = compose(xf, local);
    const nextPath = new Set(path).add(key);
    for (const child of block.entities) walk(child, next, depth + 1, nextPath);
  };

  const NONE: ReadonlySet<string> = new Set<string>();
  for (const e of doc.entities) walk(e, unit, 0, NONE);
  return out;
}

// ------------------------------------------------------------
// grid harvesting — a DXF "table" is text inside a box of lines
// ------------------------------------------------------------

/** an axis-aligned rule, mm; horizontal ones have y0 === y1 */
interface Seg {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Grid {
  /** horizontal rules, y0 === y1 */
  h: Seg[];
  /** vertical rules, x0 === x1 */
  v: Seg[];
}

function harvestGrid(doc: CadDocument): Grid {
  const h: Seg[] = [];
  const v: Seg[] = [];
  const k = doc.unitScale || 1;
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };
  let visits = 0;

  const eat = (a: Vec2, b: Vec2): void => {
    if (h.length + v.length >= MAX_SEGMENTS) return;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // "axis aligned" with a hair of tolerance: table rules drawn by hand are
    // occasionally a hundredth of a millimetre out of true.
    if (dy <= 0.05 && dx > 0.5) {
      const y = (a.y + b.y) / 2;
      h.push({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: y, y1: y });
    } else if (dx <= 0.05 && dy > 0.5) {
      const x = (a.x + b.x) / 2;
      v.push({ x0: x, x1: x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
    }
  };

  const walk = (e: CadEntity, xf: Xform, depth: number, path: ReadonlySet<string>): void => {
    if (visits++ > MAX_VISITS) return;
    if (e.type === 'line') {
      eat(apply(xf, e.a), apply(xf, e.b));
      return;
    }
    if (e.type === 'polyline') {
      const vs = e.vertices;
      for (let i = 0; i + 1 < vs.length; i++) {
        if (vs[i].bulge) continue; // an arc, not a rule
        eat(apply(xf, vs[i]), apply(xf, vs[i + 1]));
      }
      if (e.closed && vs.length > 2) {
        eat(apply(xf, vs[vs.length - 1]), apply(xf, vs[0]));
      }
      return;
    }
    if (e.type !== 'insert' || depth >= MAX_BLOCK_DEPTH) return;
    const key = e.blockName.toUpperCase();
    if (path.has(key)) return;
    const block = doc.blocks.get(key);
    if (!block) return;
    const cos = Math.cos(e.rotation);
    const sin = Math.sin(e.rotation);
    const sx = e.scale.x || 1;
    const sy = e.scale.y || 1;
    const local: Xform = {
      a: cos * sx, b: sin * sx,
      c: -sin * sy, d: cos * sy,
      e: e.position.x - (cos * sx * block.basePoint.x - sin * sy * block.basePoint.y),
      f: e.position.y - (sin * sx * block.basePoint.x + cos * sy * block.basePoint.y),
    };
    const next = compose(xf, local);
    const nextPath = new Set(path).add(key);
    for (const child of block.entities) walk(child, next, depth + 1, nextPath);
  };

  const NONE: ReadonlySet<string> = new Set<string>();
  for (const e of doc.entities) walk(e, unit, 0, NONE);
  return { h, v };
}

// ------------------------------------------------------------
// small helpers
// ------------------------------------------------------------

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const boxContains = (b: Box, x: number, y: number, pad = 0): boolean =>
  x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;

const boxOverlap = (a: Box, b: Box): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// ------------------------------------------------------------
// 1. finding a table
// ------------------------------------------------------------

const TITLE_RE = /\b(SCHEDULE|TABLE|LEGEND)\b/i;

/**
 * Words that head a reinforcement schedule column. A row carrying several of
 * them is a header even on a table whose title is missing or drawn as
 * geometry.
 */
const HEADER_WORDS = [
  'MARK', 'MKD', 'MK', 'SIZE', 'DIA', 'NOS', 'NO.', 'SPACING', 'TYPE', 'QTY',
  'REMARKS', 'S.NO', 'SL.NO', 'DESCRIPTION', 'DEPTH', 'LENGTH', 'WIDTH',
  'THK', 'THICKNESS', 'BAR', 'BARS', 'REINF', 'R/F', 'TOP', 'BOTTOM', 'LEVEL',
  'MEMBER', 'ELEMENT', 'SHAPE', 'LEGS', 'CUT', 'GRADE', 'DETAIL',
];

function headerScore(text: string): number {
  const s = text.toUpperCase();
  let n = 0;
  for (const w of HEADER_WORDS) {
    // word-ish containment: "S.NO." and "MKD." must both count
    if (s.includes(w)) n++;
  }
  return n > 0 ? 1 : 0;
}

/**
 * A table's outline: the box its text sits in, and the horizontal extent of
 * each panel's top edge. The spans matter because they are the signature of a
 * real row rule — see `rowRules`.
 */
interface TableFrame {
  box: Box;
  spans: { x0: number; x1: number }[];
}

/**
 * The box of grid rules a title sits in.
 *
 * Text clustering alone cannot tell a table's last row from the detail drawn
 * under it, and on these sheets the rules are always there — a table is text
 * inside a box of lines, so the box is the honest boundary. Falls back to
 * `null` when a table was drawn without rules, and the caller then grows a
 * neighbourhood out of the text instead.
 */
function gridBox(title: TextCell, grid: Grid): TableFrame | null {
  const h0 = title.height || 1;
  const tol = Math.max(h0 * 0.3, 0.5);
  const near = h0 * 6;

  // rules that could be the table's top edge: they run under (or just over)
  // the title and overlap it horizontally
  const overlapping = grid.h.filter(
    (s) =>
      s.x1 >= title.x0 - h0 && s.x0 <= title.x1 + h0 &&
      Math.abs(s.y0 - title.y) <= near &&
      s.x1 - s.x0 >= h0 * 2,
  );
  if (!overlapping.length) return null;

  const above = overlapping.filter((s) => s.y0 > title.y).sort((a, b) => a.y0 - b.y0)[0];
  const below = overlapping.filter((s) => s.y0 <= title.y).sort((a, b) => b.y0 - a.y0)[0];

  // A schedule title is very often inside the table's own first row, so the
  // rule above the title is tried first; if it does not carry a table, the one
  // below it is the top edge and the title floats above the box.
  for (const top of [above, below]) {
    if (!top) continue;
    const frame = growBox(top, grid, tol, h0);
    if (frame) return frame;
  }
  return null;
}

/** verticals that hang from a rule, and how far down they reach */
function bottomUnder(top: Seg, grid: Grid, tol: number): number | null {
  let bottom = Infinity;
  let supports = 0;
  for (const s of grid.v) {
    if (s.x0 < top.x0 - tol || s.x0 > top.x1 + tol) continue;
    if (s.y1 < top.y0 - tol) continue; // ends above the rule
    if (s.y0 > top.y0 - tol) continue; // does not hang below it
    supports++;
    if (s.y0 < bottom) bottom = s.y0;
  }
  // two supports is the minimum a boxed table can have: a left and a right edge
  return supports >= 2 && Number.isFinite(bottom) ? bottom : null;
}

/**
 * Grow a table box sideways along its top rule.
 *
 * A two-panel schedule — P1–P6 on the left, P7–P8 on the right of one table —
 * is drawn as two boxes that share a top edge with a hair of white between
 * them. Treating them as separate tables loses half the pedestals, so any rule
 * at the same height that starts within a cell's width of this one is the same
 * table.
 */
function growBox(top: Seg, grid: Grid, tol: number, h0: number): TableFrame | null {
  let bottom = bottomUnder(top, grid, tol);
  if (bottom === null) return null;
  let x0 = top.x0;
  let x1 = top.x1;
  const spans = [{ x0: top.x0, x1: top.x1 }];
  const gap = h0 * 6;

  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const s of grid.h) {
      if (Math.abs(s.y0 - top.y0) > tol) continue;
      if (s.x1 < x0 - gap || s.x0 > x1 + gap) continue;
      if (s.x0 >= x0 && s.x1 <= x1) continue;
      const b = bottomUnder(s, grid, tol);
      if (b === null) continue;
      spans.push({ x0: s.x0, x1: s.x1 });
      if (s.x0 < x0) { x0 = s.x0; grew = true; }
      if (s.x1 > x1) { x1 = s.x1; grew = true; }
      if (b < bottom) bottom = b;
    }
    if (!grew) break;
  }

  return { box: { x0, x1, y0: bottom, y1: top.y0 }, spans };
}

/**
 * A table drawn with vertical rules only (no row lines) — common where a
 * schedule's rows are separated by white space.
 */
function verticalOnlyBox(title: TextCell, grid: Grid): TableFrame | null {
  const h0 = title.height || 1;
  const probe = title.y - h0 * 2;
  const groups = new Map<string, { x0: number; x1: number; y0: number; y1: number; n: number }>();
  for (const s of grid.v) {
    if (s.x0 < title.x0 - h0 * 40 || s.x0 > title.x1 + h0 * 200) continue;
    if (s.y0 > probe || s.y1 < probe) continue;
    if (s.y1 - s.y0 < h0 * 2) continue;
    const key = `${Math.round(s.y0 / h0)}|${Math.round(s.y1 / h0)}`;
    const g = groups.get(key) ?? { x0: s.x0, x1: s.x0, y0: s.y0, y1: s.y1, n: 0 };
    g.x0 = Math.min(g.x0, s.x0);
    g.x1 = Math.max(g.x1, s.x0);
    g.n++;
    groups.set(key, g);
  }
  let best: { x0: number; x1: number; y0: number; y1: number; n: number } | null = null;
  for (const g of groups.values()) if (g.n >= 2 && (!best || g.n > best.n)) best = g;
  if (!best) return null;
  const box = { x0: best.x0, x1: best.x1, y0: best.y0, y1: best.y1 };
  return { box, spans: [{ x0: box.x0, x1: box.x1 }] };
}

/**
 * Last resort: grow a blob of text out from the title.
 *
 * Only used when the table carries no rules at all. The thresholds are in
 * multiples of the title's own height so they travel between sheets drawn at
 * wildly different scales; they are deliberately tighter vertically than
 * horizontally, because the thing most likely to be mistaken for another table
 * row is the detail drawn underneath.
 */
function grownBox(title: TextCell, texts: TextCell[]): TableFrame {
  const h0 = title.height || 1;
  const gapX = h0 * 12;
  const gapY = h0 * 5;
  const local = texts.filter(
    (t) =>
      t.x1 > title.x0 - h0 * 60 && t.x0 < title.x1 + h0 * 250 &&
      t.y < title.y + h0 * 2 && t.y > title.y - h0 * 300,
  );
  const inBlob: TextCell[] = [title];
  const used = new Set<TextCell>([title]);
  for (let i = 0; i < inBlob.length; i++) {
    const a = inBlob[i];
    for (const b of local) {
      if (used.has(b)) continue;
      const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
      const dy = Math.abs(a.y - b.y);
      if (dx <= gapX && dy <= gapY) {
        used.add(b);
        inBlob.push(b);
      }
    }
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of inBlob) {
    x0 = Math.min(x0, t.x0);
    x1 = Math.max(x1, t.x1);
    y0 = Math.min(y0, t.y - t.height);
    y1 = Math.max(y1, t.y + t.height);
  }
  return { box: { x0, x1, y0, y1 }, spans: [{ x0, x1 }] };
}

// ------------------------------------------------------------
// 2. reconstructing rows and columns
// ------------------------------------------------------------

/**
 * Cluster cells into rows by Y.
 *
 * The tolerance is a fraction of the MEDIAN TEXT HEIGHT of this table, never a
 * fixed number of millimetres: a sheet mixes 60 mm schedule text with 550 mm
 * plan text, and one constant cannot serve both.
 */
function clusterRows(cells: TextCell[], medianH: number): TextCell[][] {
  const tol = Math.max(medianH * 0.6, 1e-6);
  const sorted = [...cells].sort((a, b) => b.y - a.y);
  const rows: TextCell[][] = [];
  let cur: TextCell[] = [];
  let last = Infinity;
  for (const c of sorted) {
    if (cur.length && last - c.y > tol) {
      rows.push(cur);
      cur = [];
    }
    cur.push(c);
    last = c.y;
  }
  if (cur.length) rows.push(cur);
  for (const r of rows) r.sort((a, b) => a.x0 - b.x0);
  return rows;
}

/**
 * Infer columns from where text actually sits, as bands of X that no gap
 * crosses.
 *
 * Bands rather than cluster centres, because a schedule mixes centred marks
 * with left-aligned remarks and a centred cell's anchor is nowhere near a
 * left-aligned one's. Assigning by band also means a row with a blank cell
 * keeps its remaining cells under the right headings instead of shuffling them
 * left — which is the whole reason a BBS can trust "P2 | 1115x1275".
 */
function inferColumns(rows: TextCell[][], medianH: number, width: number): Box[] {
  const gutter = medianH * 0.5;
  const spans: { x0: number; x1: number }[] = [];
  for (const r of rows) {
    for (const c of r) {
      // A cell wide enough to reach across the table is a merged or title cell
      // and would bridge every gutter it crosses, welding the columns into one.
      if (c.x1 - c.x0 > width * 0.35) continue;
      spans.push({ x0: c.x0, x1: c.x1 });
    }
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a.x0 - b.x0);
  const bands: Box[] = [];
  let cur = { x0: spans[0].x0, x1: spans[0].x1 };
  for (const s of spans.slice(1)) {
    if (s.x0 <= cur.x1 + gutter) {
      cur.x1 = Math.max(cur.x1, s.x1);
    } else {
      bands.push({ x0: cur.x0, x1: cur.x1, y0: 0, y1: 0 });
      cur = { x0: s.x0, x1: s.x1 };
    }
  }
  bands.push({ x0: cur.x0, x1: cur.x1, y0: 0, y1: 0 });
  return bands;
}

/**
 * Columns straight off the grid: the strip between one vertical rule and the
 * next. Exact where the drawing drew them, which keeps two adjacent
 * reinforcement columns ("b(SHORT BAR)" and "c(LONG BAR)") from collapsing into
 * one cell just because their text touches.
 */
function columnsFromRules(xs: number[]): Box[] {
  const out: Box[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    out.push({ x0: xs[i], x1: xs[i + 1], y0: 0, y1: 0 });
  }
  return out;
}

function columnOf(cell: TextCell, bands: Box[], byAnchor: boolean): number {
  // With ruled columns the insertion point is the reliable locator: it sits
  // inside the cell whatever the justification, whereas an estimated string
  // width can spill over a rule.
  const at = byAnchor ? cell.x : cell.x0;
  for (let i = 0; i < bands.length; i++) {
    if (at >= bands[i].x0 - 1e-6 && at <= bands[i].x1 + 1e-6) return i;
  }
  // a wide/merged cell starts outside every band — file it under the band it
  // is nearest to, so it is never dropped
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const d = at < bands[i].x0 ? bands[i].x0 - at : at - bands[i].x1;
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

function trimTrailing(row: string[]): string[] {
  let end = row.length;
  while (end > 0 && row[end - 1] === '') end--;
  return row.slice(0, end);
}

/**
 * Split a table that repeats its own header across the sheet.
 *
 * `PEDESTAL SCHEDULE` runs P1–P6 down the left half and P7–P8 down the right
 * half of one box, so the header reads MARK | SIZE | SECTION | MARK | SIZE |
 * SECTION. Detecting the repeat and folding the right half under the left is
 * the difference between eight pedestals and six.
 *
 * Returns the column index each panel starts at, or null when the header does
 * not repeat.
 */
function panelStarts(header: string[]): number[] | null {
  const filled: { col: number; text: string }[] = [];
  header.forEach((t, col) => {
    const s = t.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (s) filled.push({ col, text: s });
  });
  if (filled.length < 4) return null;
  for (let k = 1; k <= filled.length / 2; k++) {
    if (filled.length % k !== 0) continue;
    let ok = true;
    for (let i = 0; i + k < filled.length; i++) {
      if (filled[i].text !== filled[i + k].text) { ok = false; break; }
    }
    if (ok) {
      const starts: number[] = [];
      for (let i = 0; i < filled.length; i += k) starts.push(filled[i].col);
      return starts.length >= 2 ? starts : null;
    }
  }
  return null;
}

/**
 * The horizontal rules that separate this table's rows.
 *
 * A row rule runs the full width of its panel, so the test is that a segment
 * repeats the panel's top edge — not that it is merely long. `PEDESTAL
 * SCHEDULE` draws a pedestal section inside every row, and those sections'
 * ground lines cover 40% of the table; treating one as a row boundary strands
 * the tie callout under it in a row of its own. Returned top-down, interior
 * rules only.
 */
function rowRules(frame: TableFrame, grid: Grid): number[] {
  const { box, spans } = frame;
  const matches = (s: Seg): boolean =>
    spans.some((p) => {
      const tol = Math.max((p.x1 - p.x0) * 0.03, 1);
      return Math.abs(s.x0 - p.x0) <= tol && Math.abs(s.x1 - p.x1) <= tol;
    });
  const out = new Set<number>();
  for (const s of grid.h) {
    if (s.y0 <= box.y0 + 1e-6 || s.y0 >= box.y1 - 1e-6) continue;
    if (matches(s)) out.add(Math.round(s.y0 * 100) / 100);
  }
  return [...out].sort((a, b) => b - a);
}

/**
 * The vertical rules that separate this table's columns.
 *
 * Same signature test as the rows, turned on its side: real column rules are
 * drawn as a set that shares one top and one bottom, so they arrive in groups.
 * A rectangle drawn inside a cell contributes a pair too, which is why a group
 * also has to be tall relative to the table — a section drawing tucked into a
 * schedule cell is a quarter of the row, never a quarter of the table.
 */
function columnRules(frame: TableFrame, grid: Grid): number[] {
  const { box } = frame;
  const height = Math.max(box.y1 - box.y0, 1);
  const groups = new Map<string, number[]>();
  for (const s of grid.v) {
    if (s.x0 < box.x0 - 1 || s.x0 > box.x1 + 1) continue;
    if (s.y1 < box.y0 || s.y0 > box.y1) continue;
    const top = Math.min(s.y1, box.y1);
    const bottom = Math.max(s.y0, box.y0);
    if (top - bottom < height * 0.25) continue;
    const key = `${Math.round(bottom)}|${Math.round(top)}`;
    const list = groups.get(key) ?? [];
    list.push(s.x0);
    groups.set(key, list);
  }
  const xs = new Set<number>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const x of list) xs.add(Math.round(x * 100) / 100);
  }
  return [...xs].sort((a, b) => a - b);
}

/** merge Y-clusters that sit between the same pair of grid rules */
function bandByRules(rows: TextCell[][], rules: number[]): TextCell[][] {
  const bandOf = (row: TextCell[]): number => {
    const y = median(row.map((c) => c.y));
    let i = 0;
    while (i < rules.length && rules[i] > y) i++;
    return i;
  };
  const out: TextCell[][] = [];
  let lastBand = -1;
  for (const row of rows) {
    const b = bandOf(row);
    if (b === lastBand && out.length) out[out.length - 1].push(...row);
    else { out.push([...row]); lastBand = b; }
  }
  for (const r of out) r.sort((a, b) => a.x0 - b.x0);
  return out;
}

function buildTable(
  title: TextCell | null,
  cells: TextCell[],
  box: Box,
  rules: number[],
  colXs: number[],
): ExtractedTable | null {
  const body = title ? cells.filter((c) => c !== title) : cells;
  if (body.length < 3) return null;

  const medianH = median(body.map((c) => c.height)) || 1;
  const banded = rules.length >= 2;
  const rowCells = banded
    ? bandByRules(clusterRows(body, medianH), rules)
    : clusterRows(body, medianH);
  const width = Math.max(box.x1 - box.x0, 1);
  const ruled = colXs.length >= 3;
  const bands = ruled ? columnsFromRules(colXs) : inferColumns(rowCells, medianH, width);
  if (!bands.length) return null;

  const matrix: string[][] = rowCells.map((row) => {
    const out = new Array<string>(bands.length).fill('');
    for (const c of row) {
      const i = columnOf(c, bands, ruled);
      out[i] = out[i] ? `${out[i]} ${c.text}` : c.text;
    }
    return out;
  });

  // header: the highest-scoring row near the top, with the line above folded
  // in when the heading is stacked ("PEDESTAL" over "MARK.")
  let headerAt = -1;
  let best = 0;
  for (let i = 0; i < Math.min(matrix.length, 6); i++) {
    const score = matrix[i].reduce((s, t) => s + headerScore(t), 0);
    if (score > best) { best = score; headerAt = i; }
  }
  let header: string[] = headerAt >= 0 ? [...matrix[headerAt]] : [];
  // rows the header consumed, so a schedule's own column titles are not read
  // back as data
  const consumed = new Set<number>(headerAt >= 0 ? [headerAt] : []);
  if (!banded && headerAt > 0) {
    // a heading stacked over two lines ("PEDESTAL" above "MARK.") — with grid
    // rules present the band already holds both
    const gap = median(rowCells[headerAt - 1].map((c) => c.y)) -
      median(rowCells[headerAt].map((c) => c.y));
    if (gap <= medianH * 2.5) {
      const above = matrix[headerAt - 1];
      header = header.map((t, i) => (above[i] ? (t ? `${above[i]} ${t}` : above[i]) : t));
      consumed.add(headerAt - 1);
    }
  }

  const dataRows = matrix.filter((_, i) => !consumed.has(i));
  let rows = dataRows.map(trimTrailing);
  const starts = panelStarts(header);
  if (starts) {
    const split: string[][] = [];
    for (const row of dataRows) {
      for (let p = 0; p < starts.length; p++) {
        const from = starts[p];
        const to = p + 1 < starts.length ? starts[p + 1] : bands.length;
        const piece = trimTrailing(row.slice(from, to));
        if (piece.some((t) => t !== '')) split.push(piece);
      }
    }
    rows = split;
    header = trimTrailing(header.slice(starts[0], starts[1]));
  }

  rows = rows.filter((r) => r.some((t) => t !== ''));
  if (!rows.length) return null;

  // A cluster of repeated layout tags is not a schedule. Eleven "TB-(350X400)"
  // labels beside a tie-beam run cluster beautifully into rows and columns and
  // then reach the model as a table saying nothing — worse, saying something
  // false. A real schedule varies: marks differ row to row, cells per row
  // exceed one. Reject when the body is dominated by one repeated string and
  // rows are essentially single-cell.
  const nonEmpty = rows.flatMap((r) => r.filter((t) => t !== ''));
  if (nonEmpty.length >= 4) {
    const counts = new Map<string, number>();
    for (const t of nonEmpty) counts.set(t, (counts.get(t) ?? 0) + 1);
    const commonest = Math.max(...counts.values());
    const singleCellRows = rows.filter((r) => r.filter((t) => t !== '').length <= 1).length;
    if (commonest / nonEmpty.length >= 0.5 && singleCellRows / rows.length >= 0.7) {
      return null;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const handles = new Set<string>();
  for (const c of cells) {
    minX = Math.min(minX, c.x0);
    maxX = Math.max(maxX, c.x1);
    minY = Math.min(minY, c.y - c.height);
    maxY = Math.max(maxY, c.y + c.height);
    handles.add(c.handle);
  }

  return {
    title: title ? title.text : '',
    header,
    rows,
    // bounds already in millimetres — both the box (from geometry) and the text
    // extents were scaled by unitScale at harvest
    min: { x: Math.min(minX, box.x0), y: Math.min(minY, box.y0) },
    max: { x: Math.max(maxX, box.x1), y: Math.max(maxY, box.y1) },
    handles: [...handles],
  };
}

/** headers-only fallback: a row of header words with no title above it */
function headerRowTitles(texts: TextCell[], covered: Box[]): TextCell[] {
  const byRow = new Map<string, TextCell[]>();
  for (const t of texts) {
    if (t.height <= 0) continue;
    const key = `${Math.round(t.y / Math.max(t.height, 1))}`;
    const list = byRow.get(key) ?? [];
    list.push(t);
    byRow.set(key, list);
  }
  const out: TextCell[] = [];
  for (const row of byRow.values()) {
    const score = row.reduce((s, c) => s + headerScore(c.text), 0);
    if (score < 3) continue;
    const lead = row.sort((a, b) => a.x0 - b.x0)[0];
    if (covered.some((b) => boxContains(b, lead.x, lead.y, lead.height))) continue;
    out.push(lead);
  }
  return out;
}

/**
 * Every schedule table on the sheet, reconstructed from text positions.
 */
export function extractTables(doc: CadDocument, texts: TextCell[]): ExtractedTable[] {
  const grid = harvestGrid(doc);
  const horizontal = texts.filter((t) => Math.abs(Math.sin(t.rotation)) < 0.18);
  const titles = texts.filter((t) => TITLE_RE.test(t.text) && t.text.length <= 80);

  const tables: ExtractedTable[] = [];
  const boxes: Box[] = [];

  const attempt = (title: TextCell | null, frame: TableFrame): void => {
    const box = frame.box;
    if (boxes.some((b) => boxOverlap(b, box))) return;
    const pad = (title?.height ?? median(horizontal.map((t) => t.height))) * 0.5;
    const inside = horizontal.filter((t) => boxContains(box, t.x, t.y, pad));
    if (title && !inside.includes(title)) inside.push(title);
    const table = buildTable(
      title, inside, box, rowRules(frame, grid), columnRules(frame, grid),
    );
    if (!table) return;
    boxes.push(box);
    tables.push(table);
  };

  for (const title of titles) {
    if (tables.length >= MAX_TABLES) break;
    const frame =
      gridBox(title, grid) ?? verticalOnlyBox(title, grid) ?? grownBox(title, horizontal);
    attempt(title, frame);
  }

  // a schedule whose title is drawn as geometry, or simply absent
  for (const lead of headerRowTitles(horizontal, boxes)) {
    if (tables.length >= MAX_TABLES) break;
    const frame = gridBox(lead, grid) ?? verticalOnlyBox(lead, grid);
    if (!frame) continue;
    attempt(null, frame);
  }

  return tables;
}

// ------------------------------------------------------------
// 3. callouts
// ------------------------------------------------------------

/**
 * Every rebar annotation on the sheet, parsed as far as the grammar goes.
 *
 * A string carrying a spacing or diameter marker is kept even when nothing
 * parses out of it: `raw` reaches the AI pass either way, and a callout the
 * grammar cannot read is exactly the one a human needs to see.
 */
/**
 * A numbered line from the general notes, not a bar on the drawing.
 *
 * "8. ALL DISTRIBUTION BARS ARE 8 @ 250 C/C AND TO BE PROVIDED" carries a
 * diameter and a spacing, so the grammar reads it as a callout — and it then
 * sits in the list looking like steel somewhere on the sheet. It is not: it is
 * a RULE, already captured in `notes.globalRules`, and offering it twice
 * invites the model to schedule a bar that exists nowhere. A callout is a
 * short annotation beside a member; a note opens with its own number and runs
 * on in prose.
 */
function isNoteLine(raw: string): boolean {
  return /^\s*\d{1,2}\s*[.)]\s+[A-Z]/.test(raw) && raw.trim().length > 40;
}

export function extractCallouts(texts: TextCell[]): ExtractedCallout[] {
  const out: ExtractedCallout[] = [];
  for (const t of texts) {
    if (isNoteLine(t.text)) continue;
    const parsed = parseCallout(t.text);
    if (!parsedAnything(parsed) && !hasCalloutMarker(t.text)) continue;
    out.push({
      ...parsed,
      raw: t.text,
      // position is geometry → already millimetres. The diameters and spacings
      // inside `parsed` came out of the string and are NOT scaled.
      position: { x: t.x, y: t.y },
      handle: t.handle,
      layer: t.layer,
    });
  }
  return out;
}

// ------------------------------------------------------------
// 4. notes
// ------------------------------------------------------------

const NOTES_HEADING = /^(?:GENERAL\s+)?NOTES?\s*[:.\-]?$/i;
const NUMBERED_NOTE = /^\d{1,2}[.)]\s*\S/;

/** grade regexes — `M-25` and `M25` are the same sentence typed twice */
const CONCRETE_GRADE = /\bM\s?-?\s?(\d{2})\b/;
const CONCRETE_CONTEXT = /CONCRETE|RCC|R\.C\.C|CONC\.?|GRADE|MIX|PCC/i;
const STEEL_GRADE = /\bFE\s?-?\s?(\d{3})\b/i;
const COVER = /COVER[^0-9]{0,20}(\d{2,3})/i;

/**
 * Project facts stated on the sheet: concrete grade, steel grade, clear cover
 * and the general-notes block itself.
 *
 * Nothing is defaulted. A sheet that does not say what its concrete is comes
 * back with `concreteGrade` undefined, because guessing M25 here would put a
 * development length into a cutting list that the drawing never authorised.
 */
export function extractNotes(doc: CadDocument): ExtractedNotes {
  return notesFromTexts(harvestTexts(doc));
}

export function notesFromTexts(texts: TextCell[]): ExtractedNotes {
  // reading order, so "first stated" means first on the sheet
  const ordered = [...texts].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (!t || seen.has(t) || lines.length >= MAX_NOTE_LINES) return;
    seen.add(t);
    lines.push(t);
  };

  // the block under a NOTES heading, plus any numbered line anywhere
  for (const h of ordered) {
    if (!NOTES_HEADING.test(h.text)) continue;
    const hh = h.height || 1;
    const block = ordered.filter(
      (t) =>
        t !== h &&
        t.y < h.y && t.y > h.y - hh * 60 &&
        t.x0 > h.x0 - hh * 4 && t.x0 < h.x0 + hh * 160,
    );
    let last = h.y;
    for (const t of block) {
      if (last - t.y > hh * 6) break; // the notes block has ended
      last = t.y;
      push(t.text);
    }
  }
  for (const t of ordered) if (NUMBERED_NOTE.test(t.text)) push(t.text);

  const notes: ExtractedNotes = { notes: lines };

  // grades: a sentence about concrete carrying an M-number, anywhere on the
  // sheet — schedules state the mix beside the table as often as in the notes
  for (const t of ordered) {
    if (!CONCRETE_CONTEXT.test(t.text)) continue;
    const m = CONCRETE_GRADE.exec(t.text.toUpperCase());
    if (m && Number(m[1]) >= 10 && Number(m[1]) <= 90) {
      notes.concreteGrade = `M${m[1]}`;
      break;
    }
  }
  for (const t of ordered) {
    const m = STEEL_GRADE.exec(t.text);
    if (m) {
      notes.steelGrade = `Fe${m[1]}`;
      break;
    }
  }

  // ---- cover as a TABLE: "MINIMUM CLEAR COVER … MEMBER TOP BOTTOM SIDE"
  // followed by "a. FOUNDATION BEAM & SLAB | 50 | 40 …". The common form on
  // consultant sheets, and unreadable to a single-number regex — which is how
  // a sheet that states cover for five member types came back "cover unknown".
  const coverTable = readCoverTable(ordered);
  if (coverTable.length) notes.coverByMember = coverTable;

  // cover: prefer a sheet-wide statement ("CLEAR COVER 50 MM") over the
  // per-element ones a notes block usually lists. When cover is stated as a
  // per-member TABLE there is no single sheet-wide value, and inventing one by
  // taking the first row would put a foundation cover on a slab bar — so
  // `coverMm` stays unset and the table speaks for itself.
  if (!coverTable.length) {
    const covers: { value: number; generic: boolean }[] = [];
    for (const t of ordered) {
      const m = COVER.exec(t.text);
      if (!m) continue;
      const v = Number(m[1]);
      if (v < 10 || v > 150) continue;
      covers.push({ value: v, generic: /CLEAR\s+COVER|^COVER/i.test(t.text.trim()) });
    }
    const generic = covers.find((c) => c.generic);
    if (generic) notes.coverMm = generic.value;
    else if (covers.length) notes.coverMm = covers[0].value;
  }

  // ---- general notes that are really rules ----
  const rules = readGlobalRules(lines);
  if (rules.length) notes.globalRules = rules;

  return notes;
}

const COVER_TABLE_HEAD = /MINIMUM\s+CLEAR\s+COVER|CLEAR\s+COVER\s+TO\s+MAIN/i;
/** "a. FOUNDATION BEAM & SLAB", "b. COLUMN" — a lettered member line */
const COVER_MEMBER_LINE = /^[a-h][.)]\s+([A-Z][A-Z&.,\- ]{2,40})$/i;

/**
 * The per-member cover table under a "MINIMUM CLEAR COVER" heading.
 *
 * Values sit as separate text cells to the right of each member line, so the
 * join is positional: numbers within half a line-height of the member's
 * baseline, in x order. Faces (top/bottom/side) keep the sheet's own order.
 */
function readCoverTable(ordered: TextCell[]): import('./types').MemberCover[] {
  const head = ordered.find((t) => COVER_TABLE_HEAD.test(t.text));
  if (!head) return [];
  const hh = head.height || 1;
  const below = ordered.filter((t) => t.y <= head.y && head.y - t.y < hh * 40);

  const out: import('./types').MemberCover[] = [];
  for (const line of below) {
    const m = COVER_MEMBER_LINE.exec(line.text.trim());
    if (!m) continue;
    const band = (line.height || hh) * 0.7;
    const values = below
      .filter(
        (t) =>
          t !== line &&
          Math.abs(t.y - line.y) <= band &&
          t.x > line.x1 - band &&
          /^\d{2,3}$/.test(t.text.trim()),
      )
      .sort((a, b) => a.x - b.x)
      .map((t) => Number(t.text.trim()))
      .filter((v) => v >= 10 && v <= 150);
    if (!values.length) continue;
    out.push({
      member: m[1].replace(/\s+/g, ' ').trim().toUpperCase(),
      coversMm: values,
      raw: line.text.trim(),
    });
  }
  return out;
}

const RULE_DISTRIBUTION = /DISTRIBUTION\s+BARS?\s+(?:ARE|SHALL BE|IS)?\s*(\d{1,2})\s*(?:MM|TOR|Φ)?\s*@?\s*(\d{2,4})\s*C\/C/i;
const RULE_SPACER = /SPACER\s+BARS?\s+(?:ARE|SHALL BE|IS)?\s*(\d{1,2})\s*(?:MM|TOR|Φ)?\s*@?\s*(\d{2,4})\s*C\/C/i;
const RULE_CHAIRS = /CHAIRS?\s+(?:ARE|SHALL BE|IS)?\s*(\d{1,2})\s*(?:MM|TOR|Φ)?\b/i;
const RULE_LAP = /LAPS?[^0-9]{0,40}\b(\d{2,3})\s*D\b/i;

/**
 * Notes that legislate rather than describe. "ALL DISTRIBUTION BARS ARE
 * 8 @ 250 C/C" governs every distribution bar on the job; handed to the model
 * as prose it was decoration, handed as a rule it answers questions before
 * they are asked.
 */
function readGlobalRules(lines: string[]): import('./types').GlobalBarRule[] {
  const out: import('./types').GlobalBarRule[] = [];
  for (const raw of lines) {
    let m = RULE_DISTRIBUTION.exec(raw);
    if (m) {
      out.push({ kind: 'distribution', diaMm: Number(m[1]), spacingMm: Number(m[2]), raw });
      continue;
    }
    m = RULE_SPACER.exec(raw);
    if (m) {
      out.push({ kind: 'spacer', diaMm: Number(m[1]), spacingMm: Number(m[2]), raw });
      continue;
    }
    m = RULE_LAP.exec(raw);
    if (m) {
      out.push({ kind: 'lap', multiple: Number(m[1]), raw });
      continue;
    }
    m = RULE_CHAIRS.exec(raw);
    if (m && /ALL\s+CHAIRS/i.test(raw)) {
      out.push({ kind: 'chairs', diaMm: Number(m[1]), raw });
    }
  }
  return out;
}

// ------------------------------------------------------------
// 5. marks
// ------------------------------------------------------------

/** P1, F12, PB3, C4, B7, PB1A — short, alphabetic prefix, small number */
const MARK_RE = /^[A-Z]{1,3}\d{1,3}[A-Z]?$/;
/** things shaped like a mark that are not one */
const NOT_A_MARK = /^(?:M\d{2}|FE\d{3}|R\d|REV\d|A\d{1,2}L|IS\d+)$/;

/**
 * Bare, digitless marks — "TB", "SC", "BW" — written with or without dots
 * ("S.C" appears thirteen times on the GAMCO sheet). Only accepted from this
 * short structural vocabulary, and only when the sheet corroborates them, or
 * two-letter noise would flood the mark list.
 */
const BARE_MARKS = new Set([
  'TB', 'PB', 'GB', 'SC', 'BW', 'RW', 'CB', 'LB', 'FB', 'RB', 'SB', 'TW',
]);

/** "S.C" → "SC", "T.B." → "TB" — dots are typography, not identity */
const undot = (s: string): string => s.replace(/\./g, '');

function isMarkToken(s: string): boolean {
  const t = s.trim().toUpperCase().replace(/[.:]$/, '');
  return MARK_RE.test(t) && !NOT_A_MARK.test(t);
}

// ------------------------------------------------------------
// 5b. declared members — name + size, no schedule table
// ------------------------------------------------------------

/**
 * "TB-(350X400)", "C2- (350x525)", "SC-350x350" — a mark or short name tied
 * directly to its cross-section. And "RCC WALL 200THK.", "H-POLE
 * (150X150X2400)", "PRECAST PANEL" beside "(2000x300x50thk)" — named members
 * with sizes. Typical-detail sheets declare most of their members this way
 * and carry no schedule at all, which is exactly why a mark grammar tuned to
 * "P1" found three members on a sheet that draws seven kinds.
 */
/**
 * How offices spell "thick".
 *
 * A DIALECT VOCABULARY, kept as data. One office writes "200THK.", the next
 * "230 THICK", the next "200 TH." — and a grammar that knows one spelling
 * grounds a wall on one drawing and asks the user for it on the next. Every
 * regex below is built from this list rather than hard-coding a spelling, so
 * widening the vocabulary is a one-line change with a test per token.
 */
const THICK_TOKENS = ['THKNESS', 'THICKNESS', 'THICK', 'THK', 'TH'] as const;
/**
 * Any spelling, with an optional trailing dot or equals.
 *
 * Longest-first: alternation is first-match, so "THK" listed before "THICK"
 * would match the first three letters of "THICK" and leave "ICK" to fail the
 * anchor. Ordering here is load-bearing, not cosmetic.
 */
const THK = `(?:${THICK_TOKENS.join('|')})\\s*[.=]?`;

const NAME_SIZE_RE = new RegExp(
  `^([A-Z][A-Z.\\- ]{0,24}?)\\s*[-–]?\\s*\\(?\\s*(\\d{2,5})\\s*[xX×]\\s*(\\d{2,5})(?:\\s*[xX×]\\s*(\\d{2,5}))?\\s*(?:${THK})?\\)?\\.?$`,
);
const NAME_THK_RE = new RegExp(`^([A-Z][A-Z.\\- ]{1,28}?)\\s+(\\d{2,4})\\s*${THK}$`);
/** a bare parenthesised size, to be joined to a name nearby on the sheet */
const BARE_SIZE_RE = new RegExp(
  `^\\(\\s*(\\d{2,5})\\s*[xX×]\\s*(\\d{2,5})(?:\\s*[xX×]\\s*(\\d{2,5}))?\\s*(?:${THK})?\\)$`,
  'i',
);
/** a bare thickness — "200THK." on its own line, its name on the line above */
const BARE_THK_RE = new RegExp(`^(\\d{2,4})\\s*${THK}$`, 'i');
/** size first: "200 THK. RCC WALL" */
const THK_NAME_RE = new RegExp(`^(\\d{2,4})\\s*${THK}\\s+([A-Z][A-Z.\\- ]{1,24})$`);

/**
 * Words that head a declaration but are not member names. The second group is
 * title-block vocabulary — "(350x350)" printed near "STRUCTURAL ENGINEERS"
 * must not declare a member called STRUCTURAL ENGINEERS.
 */
const NOT_A_NAME =
  /^(?:SECTION|DETAIL|SCALE|TYPICAL|C\/S|TYP|DRG|JOB|PH|DATE|NO|LVL|LEVEL|ENGINEERS?|CONSULTANTS?|PROJECT|PROPOSED|TITLE|STRUCTURAL|ISSUED|REVISION|CHECKED|DRAWN|CLIENT|E-?MAIL|OVER|PCC)\b/;

/**
 * A mark+size riding at the END of a caption — "TYPICAL DETAIL OF SC-350x350",
 * "C/S OF TB-(350X400)". The caption itself is rejected as a name, but its
 * tail is the sheet tying a mark to a cross-section, which is exactly a
 * declaration.
 */
const TITLE_TAIL_RE =
  /\b([A-Z]{1,3}\d{0,3})\s*[-–]\s*\(?\s*(\d{2,5})\s*[xX×]\s*(\d{2,5})(?:\s*[xX×]\s*(\d{2,5}))?\s*\)?\.?$/;

function cleanName(raw: string): string {
  return undot(raw.toUpperCase()).replace(/\s+/g, ' ').replace(/[-\s]+$/, '').trim();
}

export function extractDeclared(texts: TextCell[]): import('./types').DeclaredMember[] {
  const byKey = new Map<string, import('./types').DeclaredMember>();

  const add = (name: string, sizeText: string, dims: number[], raw: string, handle: string): boolean => {
    if (!name || NOT_A_NAME.test(name) || name.length > 24) return false;
    // sanity: a cross-section arm under 20 mm or over 5 m is not a member size
    if (dims.some((d) => d < 20 || d > 20_000)) return false;
    const key = `${name}|${dims.join('x')}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.occurrences += 1;
      if (hit.handles.length < 40) hit.handles.push(handle);
      return true;
    }
    byKey.set(key, { name, sizeText, dimsMm: dims, occurrences: 1, raw, handles: [handle] });
    return true;
  };

  for (const t of texts) {
    const s = t.text.trim();
    // Patterns fall through on a rejected name rather than stopping: the
    // whole-string match on "TYPICAL DETAIL OF SC-350x350" produces a caption,
    // which is refused — the mark+size in its tail is the declaration.
    let m = NAME_SIZE_RE.exec(s.toUpperCase());
    if (m && !/^\(/.test(s)) {
      const dims = [m[2], m[3], m[4]].filter(Boolean).map(Number);
      if (add(cleanName(m[1]), s.replace(/^[^\d(]*/, '').trim(), dims, s, t.handle)) continue;
    }
    m = NAME_THK_RE.exec(s.toUpperCase());
    if (m && add(cleanName(m[1]), `${m[2]}THK`, [Number(m[2])], s, t.handle)) continue;
    // size first — "200 THK. RCC WALL"
    m = THK_NAME_RE.exec(s.toUpperCase());
    if (m && add(cleanName(m[2]), `${m[1]}THK`, [Number(m[1])], s, t.handle)) continue;
    // a mark+size at the end of a caption — "TYPICAL DETAIL OF SC-350x350"
    m = TITLE_TAIL_RE.exec(undot(s.toUpperCase()));
    if (m && !isNaN(Number(m[2]))) {
      const dims = [m[2], m[3], m[4]].filter(Boolean).map(Number);
      add(cleanName(m[1]), `${dims.join('x')}`, dims, s, t.handle);
    }
  }

  // Bare sizes — "(2000x300x50thk)" or a lone "200THK." — join to the nearest
  // name on the sheet. On GAMCO "PRECAST PANEL" and its size are separate
  // strings a line apart, and "RCC WALL" / "200THK." are two lines of one
  // MTEXT. A mark like "C2" is as valid a name as a word: "(525x350)" beside a
  // C2 tag is C2's cross-section, and joining it to a farther word instead
  // filed C2's size under the wrong member.
  const isJoinName = (s: string): boolean => {
    const t = s.trim();
    if (isMarkToken(undot(t.toUpperCase()).replace(/[.:]$/, ''))) return true;
    return /^[A-Z][A-Z.\- ]{2,24}$/.test(t) && !NOT_A_NAME.test(t.toUpperCase());
  };

  for (const t of texts) {
    const trimmed = t.text.trim();
    const size = BARE_SIZE_RE.exec(trimmed);
    const thk = size ? null : BARE_THK_RE.exec(trimmed);
    if (!size && !thk) continue;
    const near = texts
      .filter(
        (o) =>
          o !== t &&
          isJoinName(o.text) &&
          Math.abs(o.y - t.y) < (t.height || 1) * 4 &&
          Math.abs(o.x - t.x) < (t.height || 1) * 40,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y),
      )[0];
    if (!near) continue;
    const name = cleanName(undot(near.text.trim()).replace(/[.:]$/, ''));
    const dims = size ? [size[1], size[2], size[3]].filter(Boolean).map(Number) : [Number(thk![1])];
    const sizeText = size ? trimmed.replace(/^\(|\)$/g, '') : `${thk![1]}THK`;
    add(name, sizeText, dims, `${near.text.trim()} ${trimmed}`, t.handle);
  }

  return [...byKey.values()].sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Element marks found on the sheet.
 *
 * A mark corroborated by a schedule table is a fact; a bare token that looks
 * like one is a guess, so uncorroborated tokens only survive when the sheet
 * repeats them or when a table already vouches for their prefix.
 */
export function extractMarks(
  texts: TextCell[],
  tables: ExtractedTable[],
  declared: import('./types').DeclaredMember[] = [],
): string[] {
  const fromTable = new Set<string>();
  for (const t of tables) {
    for (const row of t.rows) {
      // the mark is in the first column, or the second when the schedule
      // numbers its rows ("1. | F1 | 1500X1500")
      for (const cell of row.slice(0, 2)) {
        const v = cell.trim().toUpperCase().replace(/[.:]$/, '');
        if (isMarkToken(v)) fromTable.add(v);
      }
    }
  }
  const prefixes = new Set([...fromTable].map((m) => m.replace(/\d.*$/, '')));

  // A declaration like "TB-(350X400)" vouches for its bare name the same way
  // a schedule row vouches for "F1" — the sheet tied the token to a size.
  const declaredNames = new Set(
    declared.map((d) => d.name).filter((n) => /^[A-Z]{1,3}\d{0,3}$/.test(n)),
  );

  const standalone = new Map<string, number>();
  for (const t of texts) {
    const v = undot(t.text.trim().toUpperCase()).replace(/[.:]$/, '');
    if (isMarkToken(v)) {
      standalone.set(v, (standalone.get(v) ?? 0) + 1);
      continue;
    }
    // bare digitless marks — "TB", "S.C" — from the structural vocabulary,
    // only when a declaration on this sheet corroborates them
    if (BARE_MARKS.has(v) && declaredNames.has(v)) {
      standalone.set(v, (standalone.get(v) ?? 0) + 1);
      fromTable.add(v); // corroborated: treat like a schedule-vouched mark
    }
  }

  const both: string[] = [];
  const tableOnly: string[] = [];
  const loose: string[] = [];
  for (const m of fromTable) (standalone.has(m) ? both : tableOnly).push(m);
  for (const [m, n] of standalone) {
    if (fromTable.has(m)) continue;
    if (prefixes.has(m.replace(/\d.*$/, '')) || n >= 2) loose.push(m);
  }
  const order = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });
  return [...both.sort(order), ...tableOnly.sort(order), ...loose.sort(order)];
}

// ------------------------------------------------------------
// entry point
// ------------------------------------------------------------

/**
 * Read a drawing into the facts a Bar Bending Schedule is built from.
 *
 * Deterministic and side-effect free: the same DXF always yields the same
 * extract. No meaning is assigned and no length is computed here.
 */
export function extractDrawing(doc: CadDocument): DrawingExtract {
  const texts = harvestTexts(doc);
  const tables = extractTables(doc, texts);
  const declared = extractDeclared(texts);
  const notes = notesFromTexts(texts);

  // The filename carries facts nothing on the sheet repeats — "BOUNDARY WALL
  // DETAILS - LEVEL DIFFERENCE 900MM" names the structure AND the ground step
  // that explains why the sheet has two sections. Surfaced as a note so the
  // model reads it as sheet knowledge, not metadata.
  const name = doc.sourceFile || doc.name;
  if (/LEVEL\s*DIFF|BOUNDARY|COMPOUND\s*WALL|RETAINING/i.test(name)) {
    notes.notes.unshift(`FILENAME: ${name}`);
  }

  return {
    drawingName: doc.name,
    sourceFile: doc.sourceFile || doc.name,
    tables,
    callouts: extractCallouts(texts),
    notes,
    marks: extractMarks(texts, tables, declared),
    declared,
    unitScale: doc.unitScale,
  };
}
