// CadDocument + ViewSpec → DisplayList.
//
// This is the single resolution point in the pipeline. Blocks are expanded,
// curves tessellated, BYLAYER/BYBLOCK resolved, colours flipped for paper,
// hatch patterns generated. The screen renderer and every exporter consume
// the result, which is what stops "right on screen, wrong in the export".
import type {
  CadDocument,
  CadEntity,
  CadHatch,
  CadHatchLoop,
  CadStyle,
  CadVertex,
  DisplayList,
  DisplayOp,
  DisplayPath,
  Vec2,
  ViewSpec,
} from './types';

const TAU = Math.PI * 2;

// ------------------------------------------------------------
// transform (translate ∘ rotate ∘ scale), enough for INSERT nesting
// ------------------------------------------------------------

export interface Xform {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function compose(m: Xform, n: Xform): Xform {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export const apply = (m: Xform, p: Vec2): Vec2 => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** average absolute scale, for tessellation tolerance and lineweight */
const scaleOf = (m: Xform): number =>
  (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;

// ------------------------------------------------------------
// curve tessellation
// ------------------------------------------------------------

/** points along an arc, resolution scaled so big arcs stay smooth */
function arcPoints(c: Vec2, r: number, a0: number, a1: number): Vec2[] {
  const sweep = a1 - a0;
  const segs = Math.max(2, Math.min(256, Math.ceil(Math.abs(sweep) / 0.15)));
  const out: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (sweep * i) / segs;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Expand a polyline's bulge arcs. A bulge b between two vertices means the
 * arc's included angle is 4·atan(b) — this is what makes door swings curve
 * instead of cutting straight across.
 */
export function expandVertices(vertices: CadVertex[], closed: boolean): Vec2[] {
  const n = vertices.length;
  if (n === 0) return [];
  const out: Vec2[] = [{ x: vertices[0].x, y: vertices[0].y }];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const v = vertices[i];
    const w = vertices[(i + 1) % n];
    const bulge = v.bulge ?? 0;
    if (!bulge) {
      out.push({ x: w.x, y: w.y });
      continue;
    }
    const dx = w.x - v.x;
    const dy = w.y - v.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-9) { out.push({ x: w.x, y: w.y }); continue; }
    const theta = 4 * Math.atan(bulge);
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // centre sits off the chord midpoint by the sagitta complement
    const mid = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
    const h = radius * Math.cos(theta / 2);
    const ux = -dy / chord;
    const uy = dx / chord;
    const sign = theta > 0 ? 1 : -1;
    const c = { x: mid.x + ux * h * sign, y: mid.y + uy * h * sign };
    const a0 = Math.atan2(v.y - c.y, v.x - c.x);
    const pts = arcPoints(c, radius, a0, a0 + theta);
    for (let k = 1; k < pts.length; k++) out.push(pts[k]);
  }
  return out;
}

function ellipsePoints(e: Extract<CadEntity, { type: 'ellipse' }>): Vec2[] {
  const major = Math.hypot(e.major.x, e.major.y);
  const minor = major * e.ratio;
  const rot = Math.atan2(e.major.y, e.major.x);
  let a0 = e.startParam;
  let a1 = e.endParam;
  if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + TAU;
  while (a1 < a0) a1 += TAU;
  const segs = Math.max(8, Math.min(256, Math.ceil(Math.abs(a1 - a0) / 0.12)));
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const out: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = a0 + ((a1 - a0) * i) / segs;
    const x = major * Math.cos(t);
    const y = minor * Math.sin(t);
    out.push({ x: e.center.x + x * cos - y * sin, y: e.center.y + x * sin + y * cos });
  }
  return out;
}

/** Catmull-Rom through fit points; control points fall back to a polyline. */
function splinePoints(e: Extract<CadEntity, { type: 'spline' }>): Vec2[] {
  const pts = e.fitPoints.length >= 2 ? e.fitPoints : e.controlPoints;
  if (pts.length < 3) return pts.slice();
  if (e.fitPoints.length < 2) return pts.slice(); // control polygon only
  const out: Vec2[] = [];
  const n = pts.length;
  const get = (i: number): Vec2 => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const steps = 8;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[n - 1]);
  return out;
}

// ------------------------------------------------------------
// style resolution
// ------------------------------------------------------------

interface Resolved {
  color: string;
  lineweight: number;
  dash: number[];
  alpha: number;
}

/** near-white plots black on paper, as CAD does; otherwise keep the colour */
function forPaper(hex: string, paper: boolean): string {
  if (!paper) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.82 ? '#000000' : hex;
}

function resolveStyle(
  doc: CadDocument,
  style: CadStyle,
  inherited: Resolved | null,
  paper: boolean,
): Resolved {
  const layer = doc.layers.get(style.layer);

  // colour
  let hex: string;
  if (style.color.kind === 'rgb') hex = style.color.hex;
  else if (style.color.kind === 'byBlock' && inherited) hex = inherited.color;
  else {
    const lc = layer?.color;
    hex = lc && lc.kind === 'rgb' ? lc.hex : '#ffffff';
  }

  // lineweight: mm; -1/-2/-3 mean by-layer / by-block / default
  let lw = style.lineweight;
  if (lw < 0) lw = layer ? layer.lineweight : -3;
  if (lw < 0) lw = 0; // default → hairline
  else lw = lw / 100; // DXF stores hundredths of a mm

  // linetype
  const ltName = (style.linetype || layer?.linetype || 'CONTINUOUS').toUpperCase();
  let dash: number[] = [];
  if (ltName !== 'CONTINUOUS' && ltName !== 'BYLAYER' && ltName !== 'BYBLOCK') {
    const lt = doc.linetypes.get(ltName);
    if (lt && lt.pattern.length > 1) {
      const s = style.linetypeScale || 1;
      dash = lt.pattern.map((d) => Math.max(0.01, Math.abs(d) * s));
    }
  }

  const t = style.transparency >= 0 ? style.transparency : (layer?.transparency ?? 0);

  return { color: forPaper(hex, paper), lineweight: lw, dash, alpha: 1 - t };
}

// ------------------------------------------------------------
// hatch fill generation
// ------------------------------------------------------------

/** loop → polygon, expanding bulges */
const loopPoints = (l: CadHatchLoop): Vec2[] => expandVertices(l.vertices, true);

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Generate the line family of a patterned hatch, clipped to the boundary.
 * Pattern definitions come inline with the entity, so no acad.pat needed.
 */
function hatchPatternPaths(h: CadHatch, polys: Vec2[][], maxLines: number): Vec2[][] {
  const out: Vec2[][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return out;
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag <= 0) return out;

  const scale = h.patternScale || 1;
  let budget = maxLines;

  for (const line of h.lines) {
    const ang = line.angle + h.patternAngle;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    // spacing is the offset perpendicular to the line direction
    const off = Math.hypot(line.offsetX, line.offsetY) * scale;
    const spacing = off > 1e-9 ? off : Math.abs(line.offsetY * scale) || diag / 40;
    if (spacing < diag / 4000) continue; // absurdly dense — skip rather than hang
    const count = Math.ceil(diag / spacing) + 2;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let i = -count; i <= count && budget > 0; i++) {
      const px = cx - uy * i * spacing;
      const py = cy + ux * i * spacing;
      // clip the infinite line to the boundary by sampling crossings
      const a = { x: px - ux * diag, y: py - uy * diag };
      const b = { x: px + ux * diag, y: py + uy * diag };
      const hits: number[] = [];
      for (const poly of polys) {
        for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
          const p1 = poly[j], p2 = poly[k];
          const d1 = (p1.x - a.x) * (b.y - a.y) - (p1.y - a.y) * (b.x - a.x);
          const d2 = (p2.x - a.x) * (b.y - a.y) - (p2.y - a.y) * (b.x - a.x);
          if (d1 === d2 || d1 * d2 > 0) continue;
          const t = d1 / (d1 - d2);
          const ix = p1.x + (p2.x - p1.x) * t;
          const iy = p1.y + (p2.y - p1.y) * t;
          hits.push((ix - a.x) * ux + (iy - a.y) * uy);
        }
      }
      if (hits.length < 2) continue;
      hits.sort((m, n) => m - n);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const t0 = hits[k], t1 = hits[k + 1];
        if (t1 - t0 < 1e-9) continue;
        // even-odd: keep the span only if its midpoint is inside
        const mid = { x: a.x + ux * (t0 + t1) / 2, y: a.y + uy * (t0 + t1) / 2 };
        let inside = false;
        for (const poly of polys) if (pointInPoly(mid, poly)) inside = !inside;
        if (!inside) continue;
        out.push([
          { x: a.x + ux * t0, y: a.y + uy * t0 },
          { x: a.x + ux * t1, y: a.y + uy * t1 },
        ]);
        budget--;
        if (budget <= 0) break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// builder
// ------------------------------------------------------------

interface Ctx {
  doc: CadDocument;
  spec: ViewSpec;
  ops: DisplayOp[];
  min: Vec2;
  max: Vec2;
  budget: number;
}

function note(ctx: Ctx, p: Vec2): void {
  if (p.x < ctx.min.x) ctx.min.x = p.x;
  if (p.y < ctx.min.y) ctx.min.y = p.y;
  if (p.x > ctx.max.x) ctx.max.x = p.x;
  if (p.y > ctx.max.y) ctx.max.y = p.y;
}

function pushPath(
  ctx: Ctx,
  subpaths: Vec2[][],
  closed: boolean,
  st: Resolved,
  fill: string | null,
  style: CadStyle,
  handle: string,
): void {
  if (ctx.budget <= 0) return;
  const kept = subpaths.filter((s) => s.length >= 2);
  if (!kept.length) return;
  for (const s of kept) for (const p of s) note(ctx, p);
  ctx.ops.push({
    kind: 'path',
    subpaths: kept,
    closed,
    stroke: st.color,
    fill,
    lineweight: st.lineweight,
    dash: st.dash,
    alpha: st.alpha,
    handle,
    layer: style.layer,
  } satisfies DisplayPath);
  ctx.budget--;
}

/**
 * @param owner handle of the top-level entity this geometry belongs to.
 *   Geometry expanded out of a block reports the INSERT's handle, not the
 *   block definition's child handle — a block reference is one selectable
 *   object in CAD, and the child handles are shared by every instance, so
 *   using them would both break the entity lookup and highlight all 80
 *   instances when one is clicked.
 */
function emit(
  ctx: Ctx,
  e: CadEntity,
  xf: Xform,
  inherited: Resolved | null,
  depth: number,
  owner?: string,
): void {
  if (ctx.budget <= 0) return;
  const { doc, spec } = ctx;

  // Layer visibility is the VIEWER's own call, not the file's. A DXF's
  // layer table routinely says a layer was off or frozen in the AUTHOR's
  // last CAD session — a workspace preference, not a statement that the
  // content should never be seen. Honouring it here meant a drawing saved
  // with its main layers off imported as a blank sheet: the entity count
  // was still right (read straight off the file), nothing was drawn, and
  // there was no way to see it, since `hiddenLayers` — the toggle this
  // viewer actually exposes (the Layers menu) — was never what was hiding
  // it. `hiddenLayers` stays the only gate; it is the one the CURRENT
  // viewer controls.
  if (spec.hiddenLayers.has(e.style.layer)) return;

  const st = resolveStyle(doc, e.style, inherited, spec.paper);
  const T = (p: Vec2): Vec2 => apply(xf, p);
  const handle = owner ?? e.style.handle;

  switch (e.type) {
    case 'line':
      pushPath(ctx, [[T(e.a), T(e.b)]], false, st, null, e.style, handle);
      break;

    case 'polyline': {
      const pts = expandVertices(e.vertices, e.closed).map(T);
      pushPath(ctx, [pts], e.closed, st, null, e.style, handle);
      break;
    }

    case 'circle':
      pushPath(ctx, [arcPoints(e.center, e.radius, 0, TAU).map(T)], true, st, null, e.style, handle);
      break;

    case 'arc': {
      let a1 = e.endAngle;
      while (a1 <= e.startAngle) a1 += TAU; // DXF arcs sweep CCW
      pushPath(ctx, [arcPoints(e.center, e.radius, e.startAngle, a1).map(T)], false, st, null, e.style, handle);
      break;
    }

    case 'ellipse':
      pushPath(ctx, [ellipsePoints(e).map(T)], false, st, null, e.style, handle);
      break;

    case 'spline':
      pushPath(ctx, [splinePoints(e).map(T)], e.closed, st, null, e.style, handle);
      break;

    case 'solid':
      pushPath(ctx, [e.points.map(T)], true, st, st.color, e.style, handle);
      break;

    case 'point':
      // a bare point has no visual extent; note it for bounds only
      note(ctx, T(e.position));
      break;

    case 'text': {
      if (ctx.budget <= 0) return;
      const p = T(e.position);
      note(ctx, p);
      const s = scaleOf(xf);
      ctx.ops.push({
        kind: 'text',
        position: p,
        text: e.text,
        height: e.height * s,
        rotation: e.rotation + Math.atan2(xf.b, xf.a),
        hAlign: e.hAlign,
        vAlign: e.vAlign,
        widthFactor: e.widthFactor,
        color: st.color,
        alpha: st.alpha,
        handle,
        layer: e.style.layer,
      });
      ctx.budget--;
      break;
    }

    case 'hatch': {
      const polys = e.loops.map(loopPoints).filter((p) => p.length >= 3);
      if (!polys.length) break;
      if (e.solid || e.patternName.toUpperCase() === 'SOLID' || e.lines.length === 0) {
        pushPath(ctx, polys.map((p) => p.map(T)), true, st, st.color, e.style, handle);
      } else {
        // boundary is always drawn, so the shape reads even if the fill is capped
        const lines = hatchPatternPaths(e, polys, Math.min(4000, ctx.budget));
        if (lines.length) {
          pushPath(ctx, lines.map((l) => l.map(T)), false, st, null, e.style, handle);
        } else {
          pushPath(ctx, polys.map((p) => p.map(T)), true, st, null, e.style, handle);
        }
      }
      break;
    }

    case 'insert': {
      if (depth > 8) return;
      const block = doc.blocks.get(e.blockName.toUpperCase());
      if (!block) return;
      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);
      const sx = e.scale.x || 1;
      const sy = e.scale.y || 1;
      for (let col = 0; col < e.cols; col++) {
        for (let row = 0; row < e.rows; row++) {
          if (ctx.budget <= 0) return;
          const ox = e.position.x + col * e.colSpacing;
          const oy = e.position.y + row * e.rowSpacing;
          // translate ∘ rotate ∘ scale ∘ (-basePoint)
          const local: Xform = {
            a: cos * sx, b: sin * sx,
            c: -sin * sy, d: cos * sy,
            e: ox - (cos * sx * block.basePoint.x - sin * sy * block.basePoint.y),
            f: oy - (sin * sx * block.basePoint.x + cos * sy * block.basePoint.y),
          };
          const next = compose(xf, local);
          for (const child of block.entities) {
            emit(ctx, child, next, st, depth + 1, handle);
          }
        }
      }
      break;
    }
  }
}

export function buildDisplayList(doc: CadDocument, spec: ViewSpec): DisplayList {
  const ctx: Ctx = {
    doc,
    spec,
    ops: [],
    min: { x: Infinity, y: Infinity },
    max: { x: -Infinity, y: -Infinity },
    budget: 400_000,
  };

  let source = doc.entities;
  if (spec.regionId) {
    const region = doc.regions.find((r) => r.id === spec.regionId);
    if (region) source = region.indices.map((i) => doc.entities[i]).filter(Boolean);
  }

  const k = doc.unitScale;
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };

  for (const e of source) emit(ctx, e, unit, null, 0);

  if (!Number.isFinite(ctx.min.x)) {
    ctx.min = { x: 0, y: 0 };
    ctx.max = { x: 0, y: 0 };
  }
  return { ops: ctx.ops, min: ctx.min, max: ctx.max };
}
