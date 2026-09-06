// ============================================================
// Detailing conventions — the choices a drawing does not state.
//
// WHY THIS IS A MODULE AND NOT A FIX
//
// Comparing our schedule against a real QS workbook left a gap that arithmetic
// could not close:
//
//   38.72 MT  every mat bar scheduled bent
//   36.99 MT  alternate bars bent up, the rest straight   ← −1.73 MT
//   34.85 MT  the QS sheet
//
// The remainder is not error. It is that office's practice: what wastage rate
// they carry, whether the upper layer's legs are shortened by a bar diameter,
// whether chairs are scheduled at all. Another firm answers all of those
// differently and is equally correct.
//
// So conventions are DATA, not behaviour. Hardcoding one office's choices to
// hit 34.85 would produce a tool that is quietly wrong for the next client with
// no way to see why. Each convention here is a stated setting, applied as a
// visible transform on the interpretation, and reported on the export beside
// the total it produced.
//
// These run BEFORE `buildBbs`, in the same position as user overrides, so every
// downstream number is computed from the converted bars rather than patched
// afterwards.
// ============================================================
import { countBySpacing } from '../../domain/india/bbs';
import type { BbsBar, BbsInterpretation, BbsMember, BbsSettings } from './types';

export interface BbsConventions {
  /**
   * Alternate mat bars are bent up at the ends and the rest run straight.
   *
   * Standard Indian footing and slab detailing, and worth 4.5% of the tonnage
   * on the drawing this was measured against. A callout reading `10@150c/c`
   * then means bent bars at 300 c/c interleaved with straight bars at 300 c/c —
   * which is exactly how the QS workbook lists them, as a pair of rows with the
   * second suffixed "-Alt".
   */
  alternateBentUp: boolean;
  /**
   * The upper mat layer sits one bar diameter higher, so its end legs are
   * shorter by φ.
   *
   * Visible in the reference sheet as 0.240 against 0.250 on an otherwise
   * identical footing. Worth well under 1%, included because it is cheap and
   * because a checker comparing leg by leg will notice its absence.
   */
  layerOffset: boolean;
  /**
   * How far the straight half of an alternate pair stops short of the face,
   * at each end, in mm.
   *
   * The foundation drawing dimensions this as "X/Y TYP." and the footing
   * schedule lists X and Y per footing. It is a stated end distance, NOT the
   * cover: on this job it is 100 where the cover is 50, and treating it as
   * cover leaves every straight bar 100 mm long. Zero means "use the cover",
   * which is the right default for a drawing that does not dimension it.
   */
  altEndDeductionMm: number;
  /** chairs / spacer bars per member — a practice item, on no callout */
  chairsPerMember: number;
  /** chair bar diameter, when chairs are scheduled */
  chairDiaMm: number;
}

export const DEFAULT_CONVENTIONS: BbsConventions = {
  // Off by default. Every convention here CHANGES A QUANTITY, so none may be
  // switched on behind the user's back — the drawing does not state them and
  // the tool must not pretend it read them.
  alternateBentUp: false,
  layerOffset: false,
  altEndDeductionMm: 0,
  chairsPerMember: 0,
  chairDiaMm: 12,
};

/**
 * How many bars a spacing-driven run works out to, before it is split.
 *
 * Deliberately the same `countBySpacing` the engine uses, so the halves add
 * back up to exactly what an unsplit run would have produced.
 */
function spacingCount(
  b: BbsBar,
  m: BbsMember | undefined,
  settings: BbsSettings,
): number | null {
  if (!m || !b.spacingMm || b.spacingMm <= 0) return null;
  const along = b.distributionAxis;
  const axis = along === 'L' ? m.lengthMm : along === 'W' ? m.widthMm : m.heightMm;
  if (!axis || axis <= 0) return null;
  return countBySpacing(axis, b.spacingMm, settings.coverMm)?.count ?? null;
}

/** a mat bar is a flat layer of a slab or footing, not a link or a vertical */
function isMatBar(b: BbsBar): boolean {
  return (
    (b.barType === 'BOTTOM' || b.barType === 'TOP' || b.barType === 'MAIN' ||
      b.barType === 'DISTRIBUTION' || b.barType === 'CROSS') &&
    b.shapeCode !== '00' &&
    (b.distributionAxis === 'L' || b.distributionAxis === 'W')
  );
}

/**
 * Which mat bars alternate.
 *
 * Bending alternate bars UP is bottom-mat detailing: the bar rises at its ends
 * to lap into what sits above. Top bars have nowhere to rise to, and the
 * reference schedule bears this out — its bottom runs come in bent/straight
 * pairs while every top run is bent, with no "-Alt" line anywhere.
 *
 * Applying the convention to the top mat as well removed 10.8 m from F1 alone
 * and made the schedule lighter than the issued one.
 *
 * A member whose bars carry no TOP/BOTTOM distinction is treated as a single
 * mat, where the whole run alternates — a one-way slab is the common case.
 */
function alternates(b: BbsBar, layered: Set<string>): boolean {
  if (!isMatBar(b)) return false;
  if (b.barType === 'TOP') return false;
  if (b.barType === 'BOTTOM') return true;
  return !layered.has(b.memberMark);
}

/**
 * Which plan axis carries the UPPER layer.
 *
 * In a two-way mat the bars spanning the LONGER plan dimension sit at the
 * bottom, and the perpendicular set rests on top of them. Checked against the
 * reference sheet: on a 2.300 × 2.500 footing the bars spanning 2.500 carry
 * full-depth legs (0.250) and those spanning 2.300 are one diameter shorter
 * (0.240), which is the upper set.
 */
function upperLayerAxis(m: BbsMember): 'L' | 'W' | null {
  const l = m.lengthMm;
  const w = m.widthMm;
  if (!l || !w || l === w) return null;
  // The bar spanning the SHORTER dimension is the upper one — and it is SPACED
  // along the longer. The returned value is compared against
  // `distributionAxis`, so it must name the spacing axis, not the span: on
  // 2300 × 2500 the upper run spans W and is therefore distributed along L.
  return l < w ? 'W' : 'L';
}

export interface ConventionReport {
  /** one line per convention that actually changed something */
  applied: string[];
}

/**
 * Apply the stated conventions to a reading.
 *
 * Returns a new interpretation plus a report of what was changed, so the panel
 * and the export can say which practice produced the figure rather than
 * presenting it as the only possible answer.
 */
export function applyConventions(
  interpretation: BbsInterpretation,
  conv: BbsConventions,
  settings: BbsSettings,
): { interpretation: BbsInterpretation; report: ConventionReport } {
  const applied: string[] = [];
  const byMark = new Map(interpretation.members.map((m) => [m.mark, m]));
  let bars: BbsBar[] = interpretation.bars;

  // ---- 1. alternate bars bent up ----
  // members that state a top and a bottom layer, so "alternate" means bottom
  const layered = new Set(
    interpretation.bars
      .filter((b) => b.barType === 'TOP' || b.barType === 'BOTTOM')
      .map((b) => b.memberMark),
  );

  if (conv.alternateBentUp) {
    let split = 0;
    let skippedTop = 0;
    bars = bars.flatMap((b) => {
      if (!alternates(b, layered)) {
        if (isMatBar(b)) skippedTop += 1;
        return [b];
      }
      split += 1;
      // Each set now stands at twice the stated spacing; interleaved they
      // still read as the callout's spacing on the drawing.
      const spacing = b.spacingMm ? b.spacingMm * 2 : undefined;

      // The split must PRESERVE the number of bars. Doubling the spacing and
      // letting each half re-derive its own count rounds up twice: a 16-bar
      // run became 9 bent plus 9 straight, so ticking this box ADDED steel
      // instead of removing it — the opposite of what the convention means.
      // So the count is resolved once, here, and handed to both halves.
      const whole = b.manualCount ?? spacingCount(b, byMark.get(b.memberMark), settings);
      const bent = whole === null ? undefined : Math.ceil(whole / 2);
      const straight = whole === null ? undefined : Math.floor(whole / 2);

      return [
        { ...b, spacingMm: spacing, manualCount: bent },
        {
          ...b,
          spacingMm: spacing,
          manualCount: straight,
          alternate: true,
          ...(conv.altEndDeductionMm > 0 ? { endDeductionMm: conv.altEndDeductionMm } : {}),
          shapeCode: '00' as const,
          hookStart: 'none' as const,
          hookEnd: 'none' as const,
          barMark: b.barMark ? `${b.barMark}-Alt` : undefined,
          note: [b.note, 'alternate bar, straight'].filter(Boolean).join('; '),
        },
      ];
    });
    if (split) {
      applied.push(
        `Alternate bars bent up: ${split} bottom-mat run${split === 1 ? '' : 's'} split into a bent set and a straight set, each at twice the stated spacing` +
          (skippedTop
            ? `; ${skippedTop} top-mat run${skippedTop === 1 ? '' : 's'} left fully bent, as the top layer does not bend up`
            : '') +
          (conv.altEndDeductionMm > 0
            ? `; the straight bars stop ${conv.altEndDeductionMm} mm short of each face, as the schedule dimensions X/Y.`
            : '.'),
      );
    }
  }

  // ---- 2. upper-layer offset ----
  if (conv.layerOffset) {
    let offset = 0;
    bars = bars.map((b) => {
      if (!isMatBar(b) && b.shapeCode === '00') return b;
      const m = byMark.get(b.memberMark);
      if (!m) return b;
      const upper = upperLayerAxis(m);
      if (!upper || b.distributionAxis !== upper) return b;
      offset += 1;
      return { ...b, upperLayer: true };
    });
    if (offset) {
      applied.push(
        `Upper-layer offset: ${offset} bar run${offset === 1 ? '' : 's'} on the upper mat have their end legs shortened by one bar diameter.`,
      );
    }
  }

  // ---- 3. chairs ----
  if (conv.chairsPerMember > 0) {
    const chairs: BbsBar[] = interpretation.members.map((m) => ({
      memberMark: m.mark,
      barType: 'EXTRA' as const,
      diaMm: conv.chairDiaMm,
      // a chair is a stepped support: two feet, two risers and a seat
      shapeCode: '21' as const,
      distributionAxis: 'L' as const,
      manualCount: conv.chairsPerMember,
      fromCallout: 'practice item — not on the drawing',
      handles: [],
      barMark: `${m.mark}-CH`,
      note: 'chair / spacer, scheduled by convention',
    }));
    bars = [...bars, ...chairs];
    applied.push(
      `Chairs: ${conv.chairsPerMember} per member at ${conv.chairDiaMm} mm added as a practice item. They appear on no callout.`,
    );
  }

  // ---- 4. wastage, reported rather than applied here ----
  if (settings.wastagePct > 0) {
    applied.push(
      `Wastage: ${settings.wastagePct}% added to every weight. Totals are stated INCLUDING it.`,
    );
  } else {
    applied.push('Wastage: none. Totals are net cut weight.');
  }

  return { interpretation: { ...interpretation, bars }, report: { applied } };
}
