// IS 1200 measurement rules.
//
// Indian BOQs are measured to IS 1200 (Method of measurement of building and
// civil engineering works). Gross geometry is NOT a quotable figure: brickwork
// deducts openings over 0.1 m², plaster deducts over 0.5 m² and is measured per
// face, RCC ignores the volume displaced by reinforcement.
//
// These functions take measured geometry and apply the rule. They do not
// measure anything themselves.

/** m² below which an opening is ignored in masonry (IS 1200 part 3) */
export const MASONRY_DEDUCT_THRESHOLD_M2 = 0.1;
/** m² below which an opening is ignored in plaster (IS 1200 part 12) */
export const PLASTER_DEDUCT_THRESHOLD_M2 = 0.5;
/** openings between this and the plaster threshold deduct one face only */
export const PLASTER_SINGLE_FACE_LIMIT_M2 = 3;

export interface Opening {
  /** mm */
  width: number;
  /** mm */
  height: number;
}

const areaM2 = (o: Opening): number => (o.width * o.height) / 1e6;

export interface MasonryQuantity {
  /** m³ actually payable */
  netVolume: number;
  grossVolume: number;
  deductedVolume: number;
  ignoredOpenings: number;
  basis: string;
}

/**
 * Brick/block masonry in m³, net of openings over 0.1 m².
 *
 * Small openings are deliberately NOT deducted — the rule assumes the labour
 * of forming them offsets the material saved.
 */
export function masonryVolume(
  lengthMm: number,
  heightMm: number,
  thicknessMm: number,
  openings: Opening[],
): MasonryQuantity {
  const gross = (lengthMm * heightMm * thicknessMm) / 1e9;
  let deducted = 0;
  let ignored = 0;
  for (const o of openings) {
    if (areaM2(o) > MASONRY_DEDUCT_THRESHOLD_M2) {
      deducted += (o.width * o.height * thicknessMm) / 1e9;
    } else {
      ignored += 1;
    }
  }
  return {
    grossVolume: gross,
    deductedVolume: deducted,
    netVolume: Math.max(0, gross - deducted),
    ignoredOpenings: ignored,
    basis: `IS 1200: openings over ${MASONRY_DEDUCT_THRESHOLD_M2} m² deducted`,
  };
}

export interface PlasterQuantity {
  /** m² payable */
  netArea: number;
  grossArea: number;
  deductedArea: number;
  addedReveals: number;
  basis: string;
}

/**
 * Plaster in m² for ONE face.
 *
 * Openings up to 0.5 m² are ignored; 0.5–3 m² deduct one face only (so when
 * measuring a single face, half the opening area); over 3 m² deduct fully and
 * add back the reveal/jamb area.
 */
export function plasterArea(
  lengthMm: number,
  heightMm: number,
  thicknessMm: number,
  openings: Opening[],
): PlasterQuantity {
  const gross = (lengthMm * heightMm) / 1e6;
  let deducted = 0;
  let reveals = 0;
  for (const o of openings) {
    const a = areaM2(o);
    if (a <= PLASTER_DEDUCT_THRESHOLD_M2) continue;
    if (a <= PLASTER_SINGLE_FACE_LIMIT_M2) {
      // one face only — this call measures one face, so half applies
      deducted += a / 2;
    } else {
      deducted += a;
      // jambs and soffit come back as plastered area
      reveals += ((2 * o.height + o.width) * thicknessMm) / 1e6;
    }
  }
  return {
    grossArea: gross,
    deductedArea: deducted,
    addedReveals: reveals,
    netArea: Math.max(0, gross - deducted + reveals),
    basis: `IS 1200: ≤${PLASTER_DEDUCT_THRESHOLD_M2} m² ignored, ≤${PLASTER_SINGLE_FACE_LIMIT_M2} m² one face, larger deducted with reveals added`,
  };
}

/** RCC in m³ — reinforcement volume is NOT deducted, and is billed separately by weight */
export function concreteVolume(lengthMm: number, widthMm: number, depthMm: number): number {
  return (lengthMm * widthMm * depthMm) / 1e9;
}

// ------------------------------------------------------------
// area basis (RERA)
// ------------------------------------------------------------

export type AreaBasis = 'carpet' | 'builtUp' | 'superBuiltUp' | 'plinth';

export const AREA_BASIS_LABEL: Record<AreaBasis, string> = {
  carpet: 'Carpet area',
  builtUp: 'Built-up area',
  superBuiltUp: 'Super built-up area',
  plinth: 'Plinth area',
};

export const AREA_BASIS_NOTE: Record<AreaBasis, string> = {
  carpet: 'Usable floor area within walls — the RERA selling basis.',
  builtUp: 'Carpet area plus wall thickness and balcony.',
  superBuiltUp: 'Built-up area plus a share of common areas (loading factor).',
  plinth: 'Measured to the outer face of external walls (IS 3861).',
};

/**
 * A room polygon traced from wall INNER faces is carpet area — which is what
 * our room detection produces. Stating the basis matters: quoting built-up as
 * carpet overstates a flat by 10–15%.
 */
export const ROOM_BOUNDARY_BASIS: AreaBasis = 'carpet';

// ------------------------------------------------------------
// BOQ units
// ------------------------------------------------------------

export type BoqUnit = 'nos' | 'rmt' | 'sqm' | 'cum' | 'kg' | 'mt' | 'ls';

export const BOQ_UNIT_LABEL: Record<BoqUnit, string> = {
  nos: 'Nos.',
  rmt: 'Rmt',
  sqm: 'sq.m',
  cum: 'cu.m',
  kg: 'kg',
  mt: 'MT',
  ls: 'L.S.',
};

/** the unit an item of this kind is conventionally billed in */
export function boqUnitFor(kind: string): BoqUnit {
  const k = kind.toLowerCase();
  if (/wall|masonry|brick|concrete|rcc|excavat/.test(k)) return 'cum';
  if (/plaster|paint|floor|tile|ceiling|slab\s*area|formwork|shutter/.test(k)) return 'sqm';
  if (/cable|conduit|pipe|skirting|railing|beam\s*length|duct/.test(k)) return 'rmt';
  if (/steel|reinforc|rebar/.test(k)) return 'kg';
  return 'nos';
}
