// Unit sanity.
//
// $INSUNITS is frequently wrong. Drawings get started from a template, saved
// through a converter, or authored by someone who never touched the setting —
// and a header claiming inches on a drawing dimensioned in millimetres makes
// every length 25.4x too large. Nothing downstream can detect that: a BOQ, a
// bar bending schedule and a 3D export will all be confidently, silently wrong.
//
// So the declared unit is treated as a claim to be checked, not a fact. The
// drawing's own dimension annotations are the strongest evidence available:
// if a label reads "150" and the geometry it annotates measures 150 drawing
// units, then one unit is one millimetre whatever the header says.
import type { CadEntity, Vec2 } from '../types';

export interface UnitVerdict {
  /** millimetres per drawing unit, after checking */
  unitScale: number;
  /** what the header claimed */
  declaredScale: number;
  /** true when we overrode the header */
  overridden: boolean;
  reason: string;
}

/** plausible outer size of a real drawing sheet's content, in metres */
const MAX_PLAUSIBLE_M = 2000; // a long site/road drawing can genuinely be km-scale
const MIN_PLAUSIBLE_M = 0.05;

/**
 * Bare numeric labels are how CAD dimensions render: "150", "3425", "225".
 * On a metric building drawing these cluster in the tens-to-thousands range
 * and are, by definition, expressed in the drawing's own units.
 */
function dimensionLabels(entities: CadEntity[]): number[] {
  const out: number[] = [];
  for (const e of entities) {
    if (e.type !== 'text') continue;
    const s = e.text.trim();
    // a pure number, optionally with a decimal — no units, no words
    if (!/^\d{2,6}(?:\.\d+)?$/.test(s)) continue;
    const v = Number(s);
    if (Number.isFinite(v) && v >= 10 && v <= 100_000) out.push(v);
  }
  return out;
}

function extentOf(entities: CadEntity[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (p: Vec2): void => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const e of entities) {
    if (e.type === 'line') { eat(e.a); eat(e.b); }
    else if (e.type === 'polyline') for (const v of e.vertices) eat({ x: v.x, y: v.y });
    else if (e.type === 'circle' || e.type === 'arc') {
      eat({ x: e.center.x - e.radius, y: e.center.y - e.radius });
      eat({ x: e.center.x + e.radius, y: e.center.y + e.radius });
    }
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.max(maxX - minX, maxY - minY);
}

/**
 * Check the declared scale against the drawing itself.
 *
 * Only ever falls back to millimetres — the overwhelmingly common real unit for
 * the drawings this tool handles — and only when the declared unit produces a
 * result that cannot be a building. It never invents an exotic scale.
 */
export function verifyUnitScale(
  declaredScale: number,
  entities: CadEntity[],
): UnitVerdict {
  const keep = (reason: string): UnitVerdict => ({
    unitScale: declaredScale,
    declaredScale,
    overridden: false,
    reason,
  });

  const raw = extentOf(entities);
  if (raw <= 0) return keep('No geometry to check the declared unit against.');

  const declaredM = (raw * declaredScale) / 1000;
  const asMmM = raw / 1000;

  // the header is already millimetres, or the result is plausible — leave it
  if (declaredScale === 1) return keep('Drawing units are millimetres.');
  if (declaredM >= MIN_PLAUSIBLE_M && declaredM <= MAX_PLAUSIBLE_M) {
    return keep(`Declared unit gives a plausible ${declaredM.toFixed(1)} m extent.`);
  }

  // the declared unit produces something absurd. Do the dimension labels agree
  // with reading the units as millimetres?
  const labels = dimensionLabels(entities);
  const labelledMm =
    labels.length >= 5 &&
    labels.filter((v) => v >= 25 && v <= 20_000).length >= labels.length * 0.6;

  const mmPlausible = asMmM >= MIN_PLAUSIBLE_M && asMmM <= MAX_PLAUSIBLE_M;

  if (mmPlausible && (labelledMm || declaredM > MAX_PLAUSIBLE_M)) {
    return {
      unitScale: 1,
      declaredScale,
      overridden: true,
      reason:
        `Header declares ${declaredScale === 25.4 ? 'inches' : `x${declaredScale} units`}, ` +
        `which would make this drawing ${declaredM.toFixed(0)} m across. ` +
        `Read as millimetres it is ${asMmM.toFixed(1)} m` +
        (labelledMm ? `, and its dimension labels are millimetre values.` : '.') +
        ' Using millimetres.',
    };
  }

  return keep(
    `Declared unit gives ${declaredM.toFixed(0)} m, which looks wrong, but no better reading was found.`,
  );
}
