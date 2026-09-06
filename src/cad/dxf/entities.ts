// DXF record → CadEntity. Source semantics are preserved here: curves stay
// curves, INSERTs stay instances, BYLAYER/BYBLOCK stay unresolved. Anything
// that needs resolving happens later, in the display-list builder.
import type {
  CadColor,
  CadEntity,
  CadHatch,
  CadHatchLoop,
  CadHatchPatternLine,
  CadStyle,
  CadVertex,
  Vec2,
} from '../types';
import { BY_LAYER, BY_BLOCK } from '../types';
import { aciToHex } from '../../io/aci';
import type { Record0 } from './reader';
import { cleanMText } from './mtext';
import { allNums, num, numOr, points, val } from './reader';

const DEG = Math.PI / 180;

// ------------------------------------------------------------
// style
// ------------------------------------------------------------

function readColor(r: Record0): CadColor {
  // true color (420) wins over ACI when present
  const tc = num(r, 420);
  if (tc !== undefined && tc >= 0) {
    const hex = `#${(tc & 0xffffff).toString(16).padStart(6, '0')}`;
    return { kind: 'rgb', hex };
  }
  const aci = num(r, 62);
  if (aci === undefined) return BY_LAYER;
  if (aci === 0) return BY_BLOCK;
  if (aci === 256) return BY_LAYER;
  // negative = layer is off; still resolve the colour, visibility is separate
  const hex = aciToHex(Math.abs(aci));
  return hex ? { kind: 'rgb', hex } : BY_LAYER;
}

export function readStyle(r: Record0): CadStyle {
  const nx = num(r, 210);
  const ny = num(r, 220);
  const nz = num(r, 230);
  const hasNormal =
    nx !== undefined && ny !== undefined && nz !== undefined &&
    !(Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && Math.abs(nz - 1) < 1e-12);
  const transparency = num(r, 440);
  return {
    layer: val(r, 8) ?? '0',
    color: readColor(r),
    lineweight: numOr(r, 370, -1),
    linetype: val(r, 6) ?? '',
    linetypeScale: numOr(r, 48, 1),
    // 440 is 0x02000000 | (255 - alpha); 0..1 where 1 = fully transparent
    transparency:
      transparency === undefined ? -1 : Math.min(1, Math.max(0, (transparency & 0xff) / 255)),
    normal: hasNormal ? [nx, ny, nz] : null,
    handle: val(r, 5) ?? '',
  };
}

// ------------------------------------------------------------
// OCS → WCS
// ------------------------------------------------------------

/**
 * Entities with a non-Z extrusion normal are defined in their own Object
 * Coordinate System. Without this transform such geometry renders mirrored
 * or displaced. Arbitrary Axis Algorithm, reduced to the 2D case.
 */
export function ocsToWcs(p: Vec2, normal: [number, number, number] | null): Vec2 {
  if (!normal) return p;
  const [nx, ny, nz] = normal;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return p;
  const n: [number, number, number] = [nx / len, ny / len, nz / len];
  // the common case: normal = (0,0,-1) mirrors x
  if (Math.abs(n[0]) < 1e-9 && Math.abs(n[1]) < 1e-9) {
    return n[2] < 0 ? { x: -p.x, y: p.y } : p;
  }
  // arbitrary axis algorithm
  const wy: [number, number, number] = [0, 1, 0];
  const wz: [number, number, number] = [0, 0, 1];
  const pick = Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? wy : wz;
  const ax: [number, number, number] = [
    pick[1] * n[2] - pick[2] * n[1],
    pick[2] * n[0] - pick[0] * n[2],
    pick[0] * n[1] - pick[1] * n[0],
  ];
  const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const ux: [number, number, number] = [ax[0] / al, ax[1] / al, ax[2] / al];
  const uy: [number, number, number] = [
    n[1] * ux[2] - n[2] * ux[1],
    n[2] * ux[0] - n[0] * ux[2],
    n[0] * ux[1] - n[1] * ux[0],
  ];
  return {
    x: p.x * ux[0] + p.y * uy[0],
    y: p.x * ux[1] + p.y * uy[1],
  };
}

// ------------------------------------------------------------
// text
// ------------------------------------------------------------

/** DXF 72/73 justification → our alignment, incl. the 11/21 rule */
function textAlign(r: Record0): {
  hAlign: CadEntity extends never ? never : 'left' | 'center' | 'right';
  vAlign: 'baseline' | 'bottom' | 'middle' | 'top';
  useSecond: boolean;
} {
  const h = numOr(r, 72, 0);
  const v = numOr(r, 73, 0);
  const hAlign = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
  const vAlign = v === 1 ? 'bottom' : v === 2 ? 'middle' : v === 3 ? 'top' : 'baseline';
  // when either justification is set, the insertion point is the SECOND
  // alignment point (11/21) — the single most common cause of misplaced text
  return { hAlign, vAlign, useSecond: h !== 0 || v !== 0 };
}

/** MTEXT attachment point 1..9 → alignment */
function mtextAlign(n: number): {
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'baseline' | 'bottom' | 'middle' | 'top';
} {
  const col = (n - 1) % 3; // 0 left, 1 center, 2 right
  const row = Math.floor((n - 1) / 3); // 0 top, 1 middle, 2 bottom
  return {
    hAlign: col === 0 ? 'left' : col === 1 ? 'center' : 'right',
    vAlign: row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom',
  };
}

export { cleanMText } from './mtext';

// ------------------------------------------------------------
// hatch
// ------------------------------------------------------------

/**
 * HATCH is the most intricate record in DXF. Boundary loops arrive as either
 * polyline loops (72=1: vertices in 10/20 with optional 42 bulges) or edge
 * loops (72=0: a sequence of typed edges). Pattern line definitions are
 * carried INLINE (53/43/44/45/46/79/49), so patterns render without acad.pat.
 */
function readHatch(r: Record0, style: CadStyle): CadHatch {
  const solid = numOr(r, 70, 0) === 1;
  const patternName = val(r, 2) ?? 'SOLID';
  const islandStyle = numOr(r, 75, 0);
  const patternAngle = numOr(r, 52, 0) * DEG;
  const patternScale = numOr(r, 41, 1) || 1;

  const loops: CadHatchLoop[] = [];
  const lines: CadHatchPatternLine[] = [];

  // Walk the pairs in order — hatch structure is positional, so an
  // out-of-order read produces garbage boundaries.
  const ps = r.pairs;
  let i = 0;
  const nLoops = (() => {
    const p = ps.find((q) => q.code === 91);
    return p ? Number(p.value) || 0 : 0;
  })();

  // find the index where boundary data starts (first 92)
  while (i < ps.length && ps[i].code !== 92) i++;

  for (let loop = 0; loop < nLoops && i < ps.length; loop++) {
    const flags = Number(ps[i].value) || 0;
    i++;
    const isPolyline = (flags & 2) === 2;
    const verts: CadVertex[] = [];
    let closed = true;

    if (isPolyline) {
      // 72 = has bulge, 73 = closed, 93 = vertex count, then 10/20 (+42)
      let hasBulge = false;
      let count = 0;
      while (i < ps.length && ps[i].code !== 10) {
        if (ps[i].code === 72) hasBulge = Number(ps[i].value) === 1;
        else if (ps[i].code === 73) closed = Number(ps[i].value) === 1;
        else if (ps[i].code === 93) count = Number(ps[i].value) || 0;
        i++;
      }
      for (let v = 0; v < count && i < ps.length; v++) {
        let x = 0;
        let y = 0;
        let bulge = 0;
        if (ps[i]?.code === 10) { x = Number(ps[i].value); i++; }
        if (ps[i]?.code === 20) { y = Number(ps[i].value); i++; }
        if (hasBulge && ps[i]?.code === 42) { bulge = Number(ps[i].value); i++; }
        if (Number.isFinite(x) && Number.isFinite(y)) {
          verts.push(bulge ? { x, y, bulge } : { x, y });
        }
      }
    } else {
      // edge loop: 93 = edge count, each edge starts with 72 = type
      let edges = 0;
      while (i < ps.length && ps[i].code !== 72) {
        if (ps[i].code === 93) edges = Number(ps[i].value) || 0;
        i++;
      }
      for (let e = 0; e < edges && i < ps.length; e++) {
        const kind = Number(ps[i].value) || 1;
        i++;
        if (kind === 1) {
          // line: 10/20 → 11/21
          const a = { x: 0, y: 0 };
          const b = { x: 0, y: 0 };
          if (ps[i]?.code === 10) { a.x = Number(ps[i].value); i++; }
          if (ps[i]?.code === 20) { a.y = Number(ps[i].value); i++; }
          if (ps[i]?.code === 11) { b.x = Number(ps[i].value); i++; }
          if (ps[i]?.code === 21) { b.y = Number(ps[i].value); i++; }
          if (verts.length === 0) verts.push(a);
          verts.push(b);
        } else if (kind === 2) {
          // arc: 10/20 centre, 40 r, 50/51 angles, 73 ccw → tessellate
          let cx = 0, cy = 0, rad = 0, a0 = 0, a1 = 360, ccw = 1;
          if (ps[i]?.code === 10) { cx = Number(ps[i].value); i++; }
          if (ps[i]?.code === 20) { cy = Number(ps[i].value); i++; }
          if (ps[i]?.code === 40) { rad = Number(ps[i].value); i++; }
          if (ps[i]?.code === 50) { a0 = Number(ps[i].value); i++; }
          if (ps[i]?.code === 51) { a1 = Number(ps[i].value); i++; }
          if (ps[i]?.code === 73) { ccw = Number(ps[i].value); i++; }
          let s = a0 * DEG;
          let en = a1 * DEG;
          if (ccw) { while (en <= s) en += Math.PI * 2; }
          else { while (en >= s) en -= Math.PI * 2; }
          const segs = Math.max(4, Math.ceil(Math.abs(en - s) / 0.2));
          for (let k = 0; k <= segs; k++) {
            const a = s + ((en - s) * k) / segs;
            verts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
          }
        } else {
          // ellipse (3) / spline (4): skip the edge's payload conservatively
          while (i < ps.length && ps[i].code !== 72 && ps[i].code !== 97 && ps[i].code !== 75) i++;
        }
      }
    }
    // skip source-boundary back-references
    while (i < ps.length && ps[i].code !== 92 && ps[i].code !== 75 && ps[i].code !== 98) i++;
    if (verts.length >= 2) loops.push({ vertices: verts, closed, flags });
    if (i < ps.length && ps[i].code !== 92) break;
  }

  // pattern line definitions (only present for non-solid hatches)
  const angles = allNums(r, 53);
  const bx = allNums(r, 43);
  const by = allNums(r, 44);
  const ox = allNums(r, 45);
  const oy = allNums(r, 46);
  const dashCounts = allNums(r, 79);
  const dashVals = allNums(r, 49);
  let dashCursor = 0;
  for (let k = 0; k < angles.length; k++) {
    const count = dashCounts[k] ?? 0;
    const dashes = dashVals.slice(dashCursor, dashCursor + count);
    dashCursor += count;
    lines.push({
      angle: (angles[k] ?? 0) * DEG,
      baseX: bx[k] ?? 0,
      baseY: by[k] ?? 0,
      offsetX: ox[k] ?? 0,
      offsetY: oy[k] ?? 0,
      dashes,
    });
  }

  return {
    type: 'hatch',
    style,
    loops,
    solid,
    patternName,
    patternAngle,
    patternScale,
    islandStyle,
    lines,
  };
}

// ------------------------------------------------------------
// dispatch
// ------------------------------------------------------------

/**
 * Convert one record. Returns null for records this module does not handle
 * (the caller tallies those as diagnostics — nothing is dropped silently).
 * POLYLINE is handled by the caller because it spans following records.
 */
export function convertEntity(r: Record0): CadEntity | null {
  const style = readStyle(r);
  const N = style.normal;
  const P = (p: Vec2): Vec2 => ocsToWcs(p, N);

  switch (r.type) {
    case 'LINE': {
      const x1 = num(r, 10), y1 = num(r, 20), x2 = num(r, 11), y2 = num(r, 21);
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
      return { type: 'line', style, a: P({ x: x1, y: y1 }), b: P({ x: x2, y: y2 }) };
    }

    case 'LWPOLYLINE': {
      // vertices interleave 10/20 with optional 42 bulge belonging to the
      // vertex it follows, so walk the pairs positionally
      const verts: CadVertex[] = [];
      let cx: number | undefined;
      let cy: number | undefined;
      const push = (): void => {
        if (cx !== undefined && cy !== undefined) {
          const p = P({ x: cx, y: cy });
          verts.push({ x: p.x, y: p.y });
        }
        cx = undefined;
        cy = undefined;
      };
      for (const p of r.pairs) {
        if (p.code === 10) { push(); cx = Number(p.value); }
        else if (p.code === 20) { cy = Number(p.value); }
        else if (p.code === 42) {
          push();
          const b = Number(p.value);
          if (verts.length && Number.isFinite(b) && b !== 0) verts[verts.length - 1].bulge = b;
        }
      }
      push();
      if (verts.length < 2) return null;
      const flags = numOr(r, 70, 0);
      const w = num(r, 43);
      return {
        type: 'polyline',
        style,
        vertices: verts,
        closed: (flags & 1) === 1,
        ...(w && w > 0 ? { width: w } : {}),
      };
    }

    case 'CIRCLE': {
      const x = num(r, 10), y = num(r, 20), rad = num(r, 40);
      if (x === undefined || y === undefined || rad === undefined || rad <= 0) return null;
      return { type: 'circle', style, center: P({ x, y }), radius: rad };
    }

    case 'ARC': {
      const x = num(r, 10), y = num(r, 20), rad = num(r, 40);
      const a0 = num(r, 50), a1 = num(r, 51);
      if (x === undefined || y === undefined || rad === undefined || rad <= 0) return null;
      if (a0 === undefined || a1 === undefined) return null;
      return {
        type: 'arc',
        style,
        center: P({ x, y }),
        radius: rad,
        startAngle: a0 * DEG,
        endAngle: a1 * DEG,
      };
    }

    case 'ELLIPSE': {
      const x = num(r, 10), y = num(r, 20);
      const mx = num(r, 11), my = num(r, 21);
      const ratio = numOr(r, 40, 1);
      if (x === undefined || y === undefined || mx === undefined || my === undefined) return null;
      return {
        type: 'ellipse',
        style,
        center: P({ x, y }),
        major: { x: mx, y: my },
        ratio,
        startParam: numOr(r, 41, 0),
        endParam: numOr(r, 42, Math.PI * 2),
      };
    }

    case 'SPLINE': {
      const fit = points(r, 11, 21);
      const ctrl = points(r, 10, 20);
      if (fit.length < 2 && ctrl.length < 2) return null;
      const flags = numOr(r, 70, 0);
      return {
        type: 'spline',
        style,
        fitPoints: fit.map(P),
        controlPoints: ctrl.map(P),
        degree: numOr(r, 71, 3),
        closed: (flags & 1) === 1,
      };
    }

    case 'POINT': {
      const x = num(r, 10), y = num(r, 20);
      if (x === undefined || y === undefined) return null;
      return { type: 'point', style, position: P({ x, y }) };
    }

    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      const p1 = { x: numOr(r, 10, 0), y: numOr(r, 20, 0) };
      const p2 = { x: numOr(r, 11, 0), y: numOr(r, 21, 0) };
      const p3 = { x: numOr(r, 12, 0), y: numOr(r, 22, 0) };
      const p4 = num(r, 13) !== undefined
        ? { x: numOr(r, 13, 0), y: numOr(r, 23, 0) }
        : p3;
      // DXF quirk: the 3rd and 4th corners are stored swapped, so the
      // polygon order is p1, p2, p4, p3 — using 1,2,3,4 draws a bowtie.
      const pts = [p1, p2, p4, p3].map(P);
      return { type: 'solid', style, points: pts };
    }

    case 'TEXT': {
      const first = { x: num(r, 10), y: num(r, 20) };
      const second = { x: num(r, 11), y: num(r, 21) };
      const h = numOr(r, 40, 0);
      const s = val(r, 1) ?? '';
      if (s === '' || h <= 0) return null;
      const al = textAlign(r);
      const useSecond = al.useSecond && second.x !== undefined && second.y !== undefined;
      const px = useSecond ? second.x : first.x;
      const py = useSecond ? second.y : first.y;
      if (px === undefined || py === undefined) return null;
      return {
        type: 'text',
        style,
        position: P({ x: px, y: py }),
        // %%d/%%p/%%c are symbol codes; %%u/%%o are underline/overline
        // toggles and %%% is a literal percent — all must not reach the canvas
        text: s
          .replace(/%%%/g, '')
          .replace(/%%[dD]/g, '°')
          .replace(/%%[pP]/g, '±')
          .replace(/%%[cC]/g, 'Ø')
          .replace(/%%[uUoOkK]/g, '')
          .replace(//g, '%'),
        height: h,
        rotation: numOr(r, 50, 0) * DEG,
        hAlign: al.hAlign,
        vAlign: al.vAlign,
        widthFactor: numOr(r, 41, 1) || 1,
        oblique: numOr(r, 51, 0) * DEG,
        styleName: val(r, 7) ?? 'STANDARD',
        wrapWidth: 0,
      };
    }

    case 'MTEXT': {
      const x = num(r, 10), y = num(r, 20);
      const h = numOr(r, 40, 0);
      if (x === undefined || y === undefined || h <= 0) return null;
      // content arrives as 3-code chunks followed by the 1-code remainder
      let raw = '';
      for (const p of r.pairs) if (p.code === 3) raw += p.value;
      raw += val(r, 1) ?? '';
      const s = cleanMText(raw);
      if (s === '') return null;
      const attach = numOr(r, 71, 1);
      const al = mtextAlign(attach);
      // rotation: explicit 50, else derived from the 11/21 direction vector
      let rot = num(r, 50);
      if (rot === undefined) {
        const dx = num(r, 11);
        const dy = num(r, 21);
        rot = dx !== undefined && dy !== undefined ? Math.atan2(dy, dx) / DEG : 0;
      }
      return {
        type: 'text',
        style,
        position: P({ x, y }),
        text: s,
        height: h,
        rotation: rot * DEG,
        hAlign: al.hAlign,
        vAlign: al.vAlign,
        widthFactor: 1,
        oblique: 0,
        styleName: val(r, 7) ?? 'STANDARD',
        wrapWidth: numOr(r, 41, 0),
      };
    }

    case 'INSERT': {
      const name = val(r, 2);
      const x = num(r, 10), y = num(r, 20);
      if (!name || x === undefined || y === undefined) return null;
      return {
        type: 'insert',
        style,
        blockName: name,
        position: P({ x, y }),
        scale: { x: numOr(r, 41, 1), y: numOr(r, 42, 1) },
        rotation: numOr(r, 50, 0) * DEG,
        cols: Math.max(1, Math.round(numOr(r, 70, 1))),
        rows: Math.max(1, Math.round(numOr(r, 71, 1))),
        colSpacing: numOr(r, 44, 0),
        rowSpacing: numOr(r, 45, 0),
      };
    }

    case 'HATCH':
      return readHatch(r, style);

    case 'LEADER': {
      // vertices come as repeated 10/20 triples
      const pts = points(r, 10, 20).map(P);
      if (pts.length < 2) return null;
      return {
        type: 'polyline',
        style,
        vertices: pts.map((p) => ({ x: p.x, y: p.y })),
        closed: false,
      };
    }

    default:
      return null;
  }
}

/**
 * A DIMENSION's visible geometry (lines, arrowheads, measurement text) lives
 * in an anonymous block the CAD app already generated, named in code 2.
 * Rendering that block is both simpler and truer than re-deriving dimension
 * geometry from the definition points.
 */
export function dimensionBlockRef(r: Record0): CadEntity | null {
  const name = val(r, 2);
  if (!name) return null;
  const style = readStyle(r);
  return {
    type: 'insert',
    style,
    blockName: name,
    // the block is authored in world coordinates already
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    cols: 1,
    rows: 1,
    colSpacing: 0,
    rowSpacing: 0,
  };
}
