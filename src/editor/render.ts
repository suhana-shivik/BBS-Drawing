// Canvas renderer for the 2D plan editor. Pure drawing — reads the scene
// description built by the controller, never touches the model.
import type {
  AnyElement,
  BeamElement,
  ColumnElement,
  DimensionElement,
  DoorElement,
  FurnitureElement,
  RefLineElement,
  RoomElement,
  SlabElement,
  StairElement,
  TextElement,
  Unit,
  Vec2,
  WallElement,
  WindowElement,
} from '../core/types';
import { materialOf } from '../core/types';
import type { BIMModel } from '../core/model';
import {
  add,
  angleOf,
  dist,
  mul,
  norm,
  openingEnds,
  perp,
  polygonAreaAbs,
  polygonCentroid,
  rot,
  sub,
  wallDir,
  wallLength,
  wallOutline,
} from '../core/geometry';
import { formatArea, formatLength } from '../core/format';
import { getCadSession } from '../cad/session';
import { paintDisplayList } from '../cad/render/paint';
import type { CatalogItem } from './host';
import type { SnapResult } from './snap';
import { toModel, toScreen, type View } from './view';
import {
  beamCorners,
  columnCorners,
  furnitureCorners,
  openingPolygon,
  resolveDimensionEnds,
  stairCorners,
  textCorners,
  wallSegmentCorners,
  wallSolidIntervals,
  type Opening,
} from './shapes';

export interface EditorColors {
  bg: string;
  selection: string;
  accent: string;
  snap: string;
  text: string;
  textDim: string;
  gridMinor: string;
  gridMajor: string;
  floating: string;
  border: string;
}

/** guide geometry for the scale/rotate/mirror tools (model space) */
export interface XformOverlay {
  kind: 'scale' | 'rotate' | 'mirror';
  /** base point (scale/rotate) or first axis point (mirror) */
  base: Vec2;
  /** live snapped cursor point; null when the cursor is off-canvas */
  to: Vec2 | null;
  /** scale only: reference distance already picked, drawn as the "1×" circle */
  refDist: number | null;
}

export interface Scene {
  model: BIMModel;
  levelId: string;
  unit: Unit;
  view: View;
  w: number;
  h: number;
  selection: ReadonlySet<string>;
  /** live drag previews: element id -> fully-merged element */
  overrides: ReadonlyMap<string, AnyElement>;
  /** tool previews drawn semi-transparent on top */
  ghosts: AnyElement[];
  hoverWallId: string | null;
  snap: SnapResult | null;
  /** screen-space rubber rect */
  marquee: { a: Vec2; b: Vec2; crossing: boolean } | null;
  /** model-space measure segment */
  measure: { a: Vec2; b: Vec2 } | null;
  /** pill readout near a model point (wall length, slab size, ...) */
  readout: { text: string; near: Vec2 } | null;
  showGrips: boolean;
  /** scale/rotate/mirror guides while a transform gesture is in flight */
  xform: XformOverlay | null;
  /** model-space square grip that resizes a single selected text element */
  textGrip: Vec2 | null;
  colors: EditorColors;
  /** CAD layer names currently hidden (drafting reflines/text on these are skipped) */
  hiddenLayers: ReadonlySet<string>;
  /** handles of selected CAD underlay entities, highlighted in the selection colour */
  cadSelection: ReadonlySet<string>;
  /** handle of the CAD entity under the cursor, drawn as a pre-highlight */
  cadHover: string | null;
  /**
   * Catalogue lookup for furniture plan symbols. SOURCE imported the library
   * module directly; the shell owns the library in this rebuild, so the
   * controller passes its host's resolver down with the rest of the scene.
   * Absent = draw the fallback label.
   */
  catalogItem?: (id: string) => CatalogItem | undefined;
}

/** duck-typed layer read: only RefLineElement declares `layer` today, but
 * this stays correct if it's ever added to other element types too. */
function elementLayer(el: AnyElement): string | undefined {
  return (el as unknown as { layer?: string }).layer;
}

function isLayerHidden(el: AnyElement, hidden: ReadonlySet<string>): boolean {
  const l = elementLayer(el);
  return !!l && hidden.has(l);
}

/**
 * Visible model-space rect, padded a little so wide strokes and labels that
 * straddle the edge still paint. Imported CAD drawings run to tens of
 * thousands of entities, so off-screen geometry is skipped rather than sent
 * to the canvas.
 */
interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function viewRect(sc: Scene): ViewRect {
  const a = toModel(sc.view, { x: 0, y: 0 });
  const b = toModel(sc.view, { x: sc.w, y: sc.h });
  const pad = 200 / sc.view.scale; // ~200px of slack
  return {
    minX: Math.min(a.x, b.x) - pad,
    minY: Math.min(a.y, b.y) - pad,
    maxX: Math.max(a.x, b.x) + pad,
    maxY: Math.max(a.y, b.y) + pad,
  };
}

function pointsVisible(pts: Vec2[], r: ViewRect): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return !(maxX < r.minX || minX > r.maxX || maxY < r.minY || minY > r.maxY);
}

const pointVisible = (p: Vec2, r: ViewRect): boolean =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

const FONT = '11px "Segoe UI", system-ui, sans-serif';
const FONT_SMALL = '10px "Segoe UI", system-ui, sans-serif';
/** the live-measurement pill — read against drawing lettering, so a size up */
const FONT_PILL = '600 13px "Segoe UI", system-ui, sans-serif';

const DIM_COLOR = '#8fb3f5';
const GLASS_COLOR = '#7fb3d5';

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return `rgba(143,147,156,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function pathPolygon(ctx: CanvasRenderingContext2D, view: View, pts: Vec2[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(view, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

function pathPolyline(
  ctx: CanvasRenderingContext2D,
  view: View,
  pts: Vec2[],
  closed: boolean,
): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(view, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (closed) ctx.closePath();
}

function line(ctx: CanvasRenderingContext2D, view: View, a: Vec2, b: Vec2): void {
  const sa = toScreen(view, a);
  const sb = toScreen(view, b);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
}

function pill(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
  colors: EditorColors,
): void {
  // A live measurement is read against the drawing's own lettering, which is
  // large. 11px regular lost that contest; this is the number the tool exists
  // to report, so it is set a size up and semibold.
  ctx.font = FONT_PILL;
  const w = ctx.measureText(text).width + 18;
  const h = 21;
  roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, 6);
  ctx.fillStyle = colors.floating;
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = colors.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.5);
}

// ------------------------------------------------------------------
// grid
// ------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { view, w, h } = sc;
  let step = sc.model.settings.gridSpacing > 0 ? sc.model.settings.gridSpacing : 500;
  // adaptive: never denser than ~8px on screen
  let guard = 0;
  while (step * view.scale < 8 && guard++ < 24) step *= 5;
  const tl = toModel(view, { x: 0, y: 0 });
  const br = toModel(view, { x: w, y: h });

  ctx.lineWidth = 1;
  const minorColor = sc.colors.gridMinor;
  const majorColor = sc.colors.gridMajor;

  const x0 = Math.floor(tl.x / step) * step;
  for (let x = x0; x <= br.x; x += step) {
    const k = Math.round(x / step);
    const sx = Math.round(x * view.scale + view.tx) + 0.5;
    if (sx < -1 || sx > w + 1) continue;
    ctx.strokeStyle = k % 5 === 0 ? majorColor : minorColor;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  const y0 = Math.floor(br.y / step) * step;
  for (let y = y0; y <= tl.y; y += step) {
    const k = Math.round(y / step);
    const sy = Math.round(-y * view.scale + view.ty) + 0.5;
    if (sy < -1 || sy > h + 1) continue;
    ctx.strokeStyle = k % 5 === 0 ? majorColor : minorColor;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }
  // faint origin axes: x-axis (y=0) red-ish, y-axis (x=0) green-ish
  const ax = Math.round(view.tx) + 0.5;
  if (ax >= 0 && ax <= w) {
    ctx.strokeStyle = 'rgba(79,191,103,0.30)';
    ctx.beginPath();
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, h);
    ctx.stroke();
  }
  const ay = Math.round(view.ty) + 0.5;
  if (ay >= 0 && ay <= h) {
    ctx.strokeStyle = 'rgba(229,83,75,0.30)';
    ctx.beginPath();
    ctx.moveTo(0, ay);
    ctx.lineTo(w, ay);
    ctx.stroke();
  }
}

// ------------------------------------------------------------------
// element painters
// ------------------------------------------------------------------

function drawSlab(ctx: CanvasRenderingContext2D, sc: Scene, el: SlabElement): void {
  if (el.outline.length < 3) return;
  pathPolygon(ctx, sc.view, el.outline);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(214,216,221,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawRoom(ctx: CanvasRenderingContext2D, sc: Scene, el: RoomElement): void {
  if (el.boundary.length < 3) return;
  pathPolygon(ctx, sc.view, el.boundary);
  ctx.fillStyle = hexToRgba(sc.colors.accent, 0.07);
  ctx.fill();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = hexToRgba(sc.colors.accent, 0.22);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  // centred label: "name\narea"
  const area = polygonAreaAbs(el.boundary);
  const c = toScreen(sc.view, polygonCentroid(el.boundary));
  const screenArea = area * sc.view.scale * sc.view.scale;
  if (screenArea < 1600) return; // too small on screen for a label
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${FONT}`;
  ctx.fillStyle = '#c9d5ee';
  const name = el.number ? `${el.name} ${el.number}` : el.name;
  ctx.fillText(name, c.x, c.y - 7);
  ctx.font = FONT_SMALL;
  ctx.fillStyle = sc.colors.textDim;
  ctx.fillText(formatArea(area, sc.unit), c.x, c.y + 7);
}

function drawRefline(ctx: CanvasRenderingContext2D, sc: Scene, el: RefLineElement): void {
  if (el.points.length < 2) return;
  pathPolyline(ctx, sc.view, el.points, el.closed);
  // imported CAD geometry carries its own colour; drafting geometry uses the theme
  if (el.filled) {
    ctx.fillStyle = el.color ? hexToRgba(el.color, 0.85) : 'rgba(154,157,166,0.5)';
    ctx.fill();
  }
  ctx.strokeStyle = el.color ?? 'rgba(154,157,166,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawWall(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  w: WallElement,
  openings: Opening[],
): void {
  const L = wallLength(w);
  if (L < 1) return;
  const mat = materialOf(w);
  const fill = hexToRgba(mat.color, 0.3);
  for (const [t0, t1] of wallSolidIntervals(L, openings)) {
    pathPolygon(ctx, sc.view, wallSegmentCorners(w, t0, t1));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = sc.colors.text;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawDoor(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  el: DoorElement,
  host: WallElement,
): void {
  const { view } = sc;
  const { a, b } = openingEnds(host, el);
  const d = wallDir(host);
  const n = perp(d);
  const side = el.flip ? -1 : 1;
  const hinge = a;
  const tip = add(hinge, mul(n, side * el.width));
  // leaf
  ctx.strokeStyle = '#e8e9ec';
  ctx.lineWidth = 1.2;
  line(ctx, view, hinge, tip);
  // quarter-circle swing arc from the far jamb to the leaf tip
  const c = toScreen(view, hinge);
  const sb = toScreen(view, b);
  const st = toScreen(view, tip);
  const ang0 = Math.atan2(sb.y - c.y, sb.x - c.x);
  const ang1 = Math.atan2(st.y - c.y, st.x - c.x);
  let delta = ang1 - ang0;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  ctx.beginPath();
  ctx.arc(c.x, c.y, el.width * view.scale, ang0, ang1, delta < 0);
  ctx.strokeStyle = 'rgba(232,233,236,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawWindow(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  el: WindowElement,
  host: WallElement,
): void {
  const { a, b } = openingEnds(host, el);
  const n = perp(wallDir(host));
  const half = host.thickness / 2;
  ctx.lineWidth = 1;
  for (const k of [-half, 0, half]) {
    ctx.strokeStyle = k === 0 ? GLASS_COLOR : 'rgba(170,182,194,0.85)';
    line(ctx, sc.view, add(a, mul(n, k)), add(b, mul(n, k)));
  }
  // jambs across the thickness
  ctx.strokeStyle = sc.colors.text;
  line(ctx, sc.view, add(a, mul(n, -half)), add(a, mul(n, half)));
  line(ctx, sc.view, add(b, mul(n, -half)), add(b, mul(n, half)));
}

function drawColumn(ctx: CanvasRenderingContext2D, sc: Scene, el: ColumnElement): void {
  const mat = materialOf(el);
  pathPolygon(ctx, sc.view, columnCorners(el));
  ctx.fillStyle = hexToRgba(mat.color, 0.75);
  ctx.fill();
  ctx.strokeStyle = sc.colors.text;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawBeam(ctx: CanvasRenderingContext2D, sc: Scene, el: BeamElement): void {
  const mat = materialOf(el);
  pathPolygon(ctx, sc.view, beamCorners(el));
  ctx.setLineDash([8, 4]);
  ctx.strokeStyle = hexToRgba(mat.color, 0.95);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawStair(ctx: CanvasRenderingContext2D, sc: Scene, el: StairElement): void {
  const corners = stairCorners(el);
  pathPolygon(ctx, sc.view, corners);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fill();
  ctx.strokeStyle = '#c9ccd3';
  ctx.lineWidth = 1;
  ctx.stroke();
  const d = rot({ x: 1, y: 0 }, el.rotation);
  const n = perp(d);
  // treads every ~280mm
  const count = Math.max(1, Math.round(el.length / 280));
  const spacing = el.length / count;
  ctx.strokeStyle = 'rgba(201,204,211,0.55)';
  for (let i = 1; i < count; i++) {
    const p = add(el.position, mul(d, i * spacing));
    line(ctx, sc.view, p, add(p, mul(n, el.width)));
  }
  // up-arrow along the direction of ascent
  const mid = mul(n, el.width / 2);
  const a0 = add(add(el.position, mid), mul(d, el.length * 0.08));
  const a1 = add(add(el.position, mid), mul(d, el.length * 0.92));
  ctx.strokeStyle = sc.colors.textDim;
  ctx.lineWidth = 1.2;
  line(ctx, sc.view, a0, a1);
  const s1 = toScreen(sc.view, a1);
  const angScreen = angleOf(sub(toScreen(sc.view, a1), toScreen(sc.view, a0)));
  const ah = 7;
  ctx.beginPath();
  ctx.moveTo(s1.x, s1.y);
  ctx.lineTo(s1.x - ah * Math.cos(angScreen - 0.42), s1.y - ah * Math.sin(angScreen - 0.42));
  ctx.moveTo(s1.x, s1.y);
  ctx.lineTo(s1.x - ah * Math.cos(angScreen + 0.42), s1.y - ah * Math.sin(angScreen + 0.42));
  ctx.stroke();
  const s0 = toScreen(sc.view, a0);
  if (el.width * sc.view.scale > 26) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = sc.colors.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('UP', s0.x, s0.y);
  }
}

function drawFurniture(ctx: CanvasRenderingContext2D, sc: Scene, el: FurnitureElement): void {
  const { view } = sc;
  pathPolygon(ctx, view, furnitureCorners(el));
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(230,231,234,0.8)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const item = sc.catalogItem?.(el.catalogId);
  const c = toScreen(view, el.position);
  if (item?.symbolPath) {
    try {
      const unitPath = new Path2D(item.symbolPath);
      const m = new DOMMatrix()
        .translate(c.x, c.y)
        .rotate((-el.rotation * 180) / Math.PI)
        .scale(el.width * view.scale, el.depth * view.scale)
        .translate(-0.5, -0.5);
      const path = new Path2D();
      path.addPath(unitPath, m);
      ctx.strokeStyle = 'rgba(230,231,234,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke(path);
      return;
    } catch {
      /* bad path data — fall through to label */
    }
  }
  if (Math.min(el.width, el.depth) * view.scale > 24) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = sc.colors.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item?.name ?? el.name, c.x, c.y);
  }
}

function drawDimension(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  el: DimensionElement,
  eff: (e: AnyElement | undefined) => AnyElement | undefined,
): void {
  const { view } = sc;
  const { a, b } = resolveDimensionEnds(sc.model, el, eff);
  const L = dist(a, b);
  if (L < 1) return;
  const d = norm(sub(b, a));
  const n = perp(d);
  const off = el.offsetDist;
  const la = add(a, mul(n, off));
  const lb = add(b, mul(n, off));
  const sgn = off >= 0 ? 1 : -1;
  const gap = 5 / view.scale;
  const ext = 8 / view.scale;

  ctx.strokeStyle = DIM_COLOR;
  ctx.lineWidth = 1;
  // extension lines (small gap at the element, short overshoot past the line)
  line(ctx, view, add(a, mul(n, sgn * gap)), add(la, mul(n, sgn * ext)));
  line(ctx, view, add(b, mul(n, sgn * gap)), add(lb, mul(n, sgn * ext)));
  // dimension line
  line(ctx, view, la, lb);
  // 45° tick marks
  const sla = toScreen(view, la);
  const slb = toScreen(view, lb);
  const angS = angleOf(sub(slb, sla));
  const tick = 5;
  for (const s of [sla, slb]) {
    ctx.beginPath();
    ctx.moveTo(s.x - tick * Math.cos(angS + Math.PI / 4), s.y - tick * Math.sin(angS + Math.PI / 4));
    ctx.lineTo(s.x + tick * Math.cos(angS + Math.PI / 4), s.y + tick * Math.sin(angS + Math.PI / 4));
    ctx.stroke();
  }
  // value pill centred on the line, rotated to read along it
  const midS = { x: (sla.x + slb.x) / 2, y: (sla.y + slb.y) / 2 };
  let textAng = angS;
  if (textAng > Math.PI / 2 || textAng < -Math.PI / 2) textAng += Math.PI;
  const label = formatLength(L, sc.unit);
  ctx.save();
  ctx.translate(midS.x, midS.y);
  ctx.rotate(textAng);
  ctx.font = FONT;
  const tw = ctx.measureText(label).width + 10;
  roundRectPath(ctx, -tw / 2, -9, tw, 18, 4);
  ctx.fillStyle = 'rgba(29,31,36,0.9)';
  ctx.fill();
  ctx.fillStyle = DIM_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0.5);
  ctx.restore();
}

/** canvas baseline for a CAD vertical justification */
const V_BASELINE: Record<string, CanvasTextBaseline> = {
  baseline: 'alphabetic',
  bottom: 'bottom',
  middle: 'middle',
  top: 'top',
};

function drawTextEl(ctx: CanvasRenderingContext2D, sc: Scene, el: TextElement): void {
  const { view } = sc;
  const px = el.size * view.scale;
  if (px < 2) return;
  const s = toScreen(view, el.position);
  // CAD text carries explicit justification; tool-placed text stays centred
  const hAlign = el.hAlign ?? 'center';
  const vAlign = el.vAlign ?? 'middle';
  const lines = el.text.split('\n');

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(-el.rotation);
  ctx.font = `${px}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = el.color ?? sc.colors.text;
  ctx.textAlign = hAlign;
  ctx.textBaseline = V_BASELINE[vAlign] ?? 'middle';

  // multi-line MTEXT grows downward from the attachment point; centre and
  // bottom attachments shift the block so the anchor lands where CAD puts it
  const lh = px * 1.25;
  let y0 = 0;
  if (lines.length > 1) {
    if (vAlign === 'middle') y0 = -((lines.length - 1) * lh) / 2;
    else if (vAlign === 'bottom' || vAlign === 'baseline') y0 = -(lines.length - 1) * lh;
  }
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 0, y0 + i * lh);
  }
  ctx.restore();
}

// ------------------------------------------------------------------
// overlays
// ------------------------------------------------------------------

function strokeElementOutline(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  el: AnyElement,
  color: string,
  lw: number,
  eff: (e: AnyElement | undefined) => AnyElement | undefined,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  switch (el.type) {
    case 'wall':
      pathPolygon(ctx, sc.view, wallOutline(el));
      ctx.stroke();
      break;
    case 'door':
    case 'window': {
      const host = eff(sc.model.get(el.hostWallId));
      if (host?.type === 'wall') {
        pathPolygon(ctx, sc.view, openingPolygon(host, el));
        ctx.stroke();
      }
      break;
    }
    case 'slab':
      if (el.outline.length >= 3) {
        pathPolygon(ctx, sc.view, el.outline);
        ctx.stroke();
      }
      break;
    case 'room':
      if (el.boundary.length >= 3) {
        pathPolygon(ctx, sc.view, el.boundary);
        ctx.stroke();
      }
      break;
    case 'refline':
      if (el.points.length >= 2) {
        pathPolyline(ctx, sc.view, el.points, el.closed);
        ctx.stroke();
      }
      break;
    case 'column':
      pathPolygon(ctx, sc.view, columnCorners(el));
      ctx.stroke();
      break;
    case 'beam':
      pathPolygon(ctx, sc.view, beamCorners(el));
      ctx.stroke();
      break;
    case 'stair':
      pathPolygon(ctx, sc.view, stairCorners(el));
      ctx.stroke();
      break;
    case 'furniture':
      pathPolygon(ctx, sc.view, furnitureCorners(el));
      ctx.stroke();
      break;
    case 'dimension': {
      const { a, b } = resolveDimensionEnds(sc.model, el, eff);
      const n = mul(perp(norm(sub(b, a))), el.offsetDist);
      line(ctx, sc.view, add(a, n), add(b, n));
      break;
    }
    case 'text':
      pathPolygon(ctx, sc.view, textCorners(el));
      ctx.stroke();
      break;
  }
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, sc: Scene): void {
  if (!sc.snap) return;
  const s = toScreen(sc.view, sc.snap.point);
  const r = 5;
  ctx.strokeStyle = sc.colors.snap;
  ctx.lineWidth = 1.5;
  switch (sc.snap.kind) {
    case 'endpoint':
      ctx.strokeRect(s.x - r + 0.5, s.y - r + 0.5, r * 2, r * 2);
      break;
    case 'midpoint':
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r - 1);
      ctx.lineTo(s.x + r + 1, s.y + r);
      ctx.lineTo(s.x - r - 1, s.y + r);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'grid':
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x + r, s.y);
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y + r);
      ctx.stroke();
      break;
    case 'intersection':
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.stroke();
      break;
    case 'online':
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
}

/** the small filled square used for every draggable handle */
function gripSquare(ctx: CanvasRenderingContext2D, s: Vec2, colors: EditorColors): void {
  ctx.fillStyle = colors.selection;
  ctx.strokeStyle = colors.bg;
  ctx.lineWidth = 1.5;
  ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
  ctx.strokeRect(s.x - 4 + 0.5, s.y - 4 + 0.5, 7, 7);
}

/**
 * Guides for a transform gesture: the base point marker plus whatever makes
 * the pending transform legible — the "1×" reference circle for scale, the
 * +x reference ray and swept arc for rotate, the full-viewport axis for mirror.
 */
function drawXformOverlay(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const ov = sc.xform;
  if (!ov) return;
  const { view, colors } = sc;
  const b = toScreen(view, ov.base);
  ctx.save();
  ctx.lineWidth = 1;

  if (ov.kind === 'mirror') {
    const t = ov.to ? toScreen(view, ov.to) : null;
    const dx = t ? t.x - b.x : 0;
    const dy = t ? t.y - b.y : 0;
    const l = Math.hypot(dx, dy);
    if (t && l > 1e-6) {
      // the axis is an infinite line — run it right across the viewport
      const k = ((sc.w + sc.h) * 2) / l;
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = colors.selection;
      ctx.beginPath();
      ctx.moveTo(b.x - dx * k, b.y - dy * k);
      ctx.lineTo(b.x + dx * k, b.y + dy * k);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    if (ov.kind === 'scale' && ov.refDist !== null) {
      const r = ov.refDist * view.scale;
      if (r > 1 && r < 20000) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = hexToRgba(colors.accent, 0.55);
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (ov.kind === 'rotate') {
      // rotation is measured CCW from +x at the base point
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = hexToRgba(colors.accent, 0.5);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + 46, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ov.to) {
      const t = toScreen(view, ov.to);
      ctx.strokeStyle = colors.selection;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      if (ov.kind === 'rotate' && Math.hypot(t.x - b.x, t.y - b.y) > 2) {
        const a = Math.atan2(t.y - b.y, t.x - b.x);
        ctx.strokeStyle = hexToRgba(colors.selection, 0.7);
        ctx.beginPath();
        ctx.arc(b.x, b.y, 30, 0, a, a < 0);
        ctx.stroke();
      }
    }
  }

  ctx.strokeStyle = colors.selection;
  ctx.fillStyle = colors.bg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x - 9, b.y);
  ctx.lineTo(b.x + 9, b.y);
  ctx.moveTo(b.x, b.y - 9);
  ctx.lineTo(b.x, b.y + 9);
  ctx.stroke();
  ctx.restore();
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  sc: Scene,
  g: AnyElement,
  eff: (e: AnyElement | undefined) => AnyElement | undefined,
): void {
  switch (g.type) {
    case 'wall':
      drawWall(ctx, sc, g, []);
      break;
    case 'door':
    case 'window': {
      const host = eff(sc.model.get(g.hostWallId));
      if (host?.type !== 'wall') return;
      // visual gap: mask the host wall under the opening
      pathPolygon(ctx, sc.view, openingPolygon(host, g));
      ctx.fillStyle = sc.colors.bg;
      ctx.fill();
      ctx.strokeStyle = hexToRgba(sc.colors.accent, 0.9);
      ctx.lineWidth = 1;
      ctx.stroke();
      if (g.type === 'door') drawDoor(ctx, sc, g, host);
      else drawWindow(ctx, sc, g, host);
      break;
    }
    case 'slab':
      drawSlab(ctx, sc, g);
      break;
    case 'column':
      drawColumn(ctx, sc, g);
      break;
    case 'beam':
      drawBeam(ctx, sc, g);
      break;
    case 'stair':
      drawStair(ctx, sc, g);
      break;
    case 'furniture':
      drawFurniture(ctx, sc, g);
      break;
    case 'dimension':
      drawDimension(ctx, sc, g, eff);
      break;
    case 'refline':
      if (g.points.length >= 2) {
        pathPolyline(ctx, sc.view, g.points, g.closed);
        if (g.closed) {
          ctx.fillStyle = hexToRgba(sc.colors.accent, 0.08);
          ctx.fill();
        }
        ctx.strokeStyle = hexToRgba(sc.colors.accent, 0.9);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------
// main entry
// ------------------------------------------------------------------

export function drawScene(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { view, w, h, colors } = sc;
  ctx.save();
  // TRANSPARENT, because this canvas is an OVERLAY.
  //
  // It is mounted at z-index 2 directly over `.sheet`, which holds the drawing
  // as SVG — and its own stylesheet says so: "It is TRANSPARENT: the underlay
  // must stay visible through it (§12 — a CAD sheet is an underlay, never
  // edited)". It was not. `fillRect(colors.bg)` painted an opaque ground over
  // the whole pane on every frame, hiding the entire sheet SVG behind it, and
  // the CAD repaint below hid the fact by drawing the same geometry back on
  // top. The drawing looked right, so nothing looked wrong — until the read
  // sections were outlined in the SVG and the outlines could not be seen while
  // the Files preview, which has no canvas over it, showed them perfectly.
  ctx.clearRect(0, 0, w, h);

  drawGrid(ctx, sc);

  // NO CAD UNDERLAY HERE. `.sheet` already renders the imported drawing as
  // SVG, in the same viewBox its section highlights are emitted into, so the
  // drawing and its highlights cannot drift apart — they are one document.
  // Painting the display list here as well drew the drawing a SECOND time,
  // over the first, from a different mapping (`sheetView` fits the full pane;
  // `.sheet` is inset by its own 14px/18px padding), so the two were never
  // quite in register. The canvas now draws only what is genuinely the
  // editor's: the grid, and the BIM elements over the underlay.
  //
  // The CAD selection highlight IS still drawn here, and it has to be: it was
  // lost when the underlay repaint went, because that call was also what
  // painted `cadSelection` and `cadHover`. Clicking a line then selected it,
  // counted it in the status bar, and showed nothing — which reads as a
  // selection tool that does not work.
  //
  // Only the MARKED ops are painted, never the whole list. That is the whole
  // difference: the drawing comes from the sheet SVG underneath, and this is a
  // few strokes of amber on top of it.
  const cad = getCadSession();
  const marked = new Set<string>(sc.cadSelection);
  if (sc.cadHover) marked.add(sc.cadHover);
  if (marked.size && cad.list) {
    const ops = cad.list.ops.filter((op) => op.handle && marked.has(op.handle));
    if (ops.length) {
      paintDisplayList(ctx, { ...cad.list, ops }, view, {
        width: w,
        height: h,
        opacity: 1,
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        highlight: sc.cadSelection,
        highlightColor: colors.selection,
        hoverHandle: sc.cadHover,
        hoverColor: colors.selection,
      });
    }
  }

  const eff = (e: AnyElement | undefined): AnyElement | undefined =>
    e ? sc.overrides.get(e.id) ?? e : undefined;

  const els = sc.model.onLevel(sc.levelId).map((e) => sc.overrides.get(e.id) ?? e);
  const of = <T extends AnyElement>(t: T['type']): T[] =>
    els.filter((e): e is T => e.type === t);

  const walls = of<WallElement>('wall');
  const doors = of<DoorElement>('door');
  const windows = of<WindowElement>('window');
  const openingsByWall = new Map<string, Opening[]>();
  for (const o of [...doors, ...windows]) {
    const arr = openingsByWall.get(o.hostWallId);
    if (arr) arr.push(o);
    else openingsByWall.set(o.hostWallId, [o]);
  }
  const hostOf = (o: Opening): WallElement | undefined => {
    const hostRaw = eff(sc.model.get(o.hostWallId));
    return hostRaw?.type === 'wall' ? hostRaw : undefined;
  };

  // painter order
  for (const el of of<SlabElement>('slab')) drawSlab(ctx, sc, el);
  for (const el of of<RoomElement>('room')) drawRoom(ctx, sc, el);
  const vr = viewRect(sc);
  for (const el of of<RefLineElement>('refline')) {
    if (isLayerHidden(el, sc.hiddenLayers)) continue;
    if (!pointsVisible(el.points, vr)) continue;
    drawRefline(ctx, sc, el);
  }
  for (const el of walls) drawWall(ctx, sc, el, openingsByWall.get(el.id) ?? []);
  for (const el of doors) {
    const host = hostOf(el);
    if (host) drawDoor(ctx, sc, el, host);
  }
  for (const el of windows) {
    const host = hostOf(el);
    if (host) drawWindow(ctx, sc, el, host);
  }
  for (const el of of<ColumnElement>('column')) drawColumn(ctx, sc, el);
  for (const el of of<BeamElement>('beam')) drawBeam(ctx, sc, el);
  for (const el of of<StairElement>('stair')) drawStair(ctx, sc, el);
  for (const el of of<FurnitureElement>('furniture')) drawFurniture(ctx, sc, el);
  for (const el of of<DimensionElement>('dimension')) drawDimension(ctx, sc, el, eff);
  for (const el of of<TextElement>('text')) {
    if (isLayerHidden(el, sc.hiddenLayers)) continue;
    if (!pointVisible(el.position, vr)) continue;
    drawTextEl(ctx, sc, el);
  }

  // hover highlight (door/window tool)
  if (sc.hoverWallId) {
    const hw = eff(sc.model.get(sc.hoverWallId));
    if (hw?.type === 'wall') {
      pathPolygon(ctx, sc.view, wallOutline(hw));
      ctx.strokeStyle = hexToRgba(colors.accent, 0.9);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // selection overlays
  for (const id of sc.selection) {
    const raw = sc.model.get(id);
    if (!raw || raw.levelId !== sc.levelId) continue;
    const el = eff(raw);
    if (el) strokeElementOutline(ctx, sc, el, colors.selection, 1.75, eff);
  }

  // wall endpoint grips (single wall selected)
  if (sc.showGrips && sc.selection.size === 1) {
    const id = [...sc.selection][0];
    const el = eff(sc.model.get(id));
    if (el?.type === 'wall') {
      for (const p of [el.start, el.end]) gripSquare(ctx, toScreen(view, p), colors);
    }
  }

  // text resize grip (single text element selected)
  if (sc.textGrip) gripSquare(ctx, toScreen(view, sc.textGrip), colors);

  // tool ghosts
  if (sc.ghosts.length) {
    ctx.save();
    ctx.globalAlpha = 0.72;
    for (const g of sc.ghosts) drawGhost(ctx, sc, g, eff);
    ctx.restore();
  }

  // measure overlay
  if (sc.measure) {
    const { a, b } = sc.measure;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.25;
    line(ctx, view, a, b);
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      const s = toScreen(view, p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = colors.accent;
      ctx.fill();
    }
    const mid = toScreen(view, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    pill(ctx, mid.x, mid.y - 16, formatLength(dist(a, b), sc.unit), colors);
  }

  drawXformOverlay(ctx, sc);

  // readout pill (live length while drawing)
  if (sc.readout) {
    const s = toScreen(view, sc.readout.near);
    pill(ctx, s.x + 46, s.y - 22, sc.readout.text, colors);
  }

  drawSnapMarker(ctx, sc);

  // marquee (screen space)
  if (sc.marquee) {
    const { a, b, crossing } = sc.marquee;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const mw = Math.abs(a.x - b.x);
    const mh = Math.abs(a.y - b.y);
    ctx.fillStyle = hexToRgba(colors.accent, 0.08);
    ctx.fillRect(x, y, mw, mh);
    if (crossing) ctx.setLineDash([5, 4]);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, mw, mh);
    ctx.setLineDash([]);
  }

  ctx.restore();
}
