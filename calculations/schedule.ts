// ============================================================
// calculations/schedule.ts — THE ONLY PLACE A REINFORCEMENT ROW BECOMES A BbsRow.
//
//   bbs_reinforcement (BbsBar)  +  member  +  settings
//        → resolveGeometry()        member axes, cover and its status, the axis the bar runs along
//        → resolveCuttingLength()   ENTERED > SHAPE_FORMULA > BLOCKED — never zero
//        → calculateQuantity()      n per member (manual or ⌈span/spacing⌉+1) × member count
//        → calculateWeight()        total length, IS 1786 unit weight, weight, wastage
//        → BbsRow                   with its stage trace, cover source and fact dependencies
//   rows → buildSteelSummary()     grouped by diameter only
//        → reconcileSchedule()     Σ rows == summary, or the schedule says why not
//
// Every stage is persisted on the row (`trace`): the stages it reached, and if
// it stopped, the FAILED_STAGE, the MISSING_FACT, its SOURCE, the REASON and
// the ACTION that unblocks it. A row never silently zeros out: a quantity it
// could not derive is null, and the trace names what was wanted.
//
// The arithmetic itself is the engine's proven code, moved here verbatim from
// src/cad/bbs/build.ts (domain/india/bbs.ts supplies the IS 456 / IS 2502 /
// IS 1786 figures). `buildBbs` in build.ts is the caller: it prepares members
// and settings and hands every bar to `scheduleRow`. There is no second
// calculation engine.
// ============================================================
import {
  barWeight,
  bendDeduction,
  countBySpacing,
  developmentLength,
  hookAllowance,
  lapLength,
  shapeLength,
  steelSummary,
  stirrupArm,
  SHAPES,
  type ShapeCode,
  type SummaryLine, polylineLength } from '../src/domain/india/bbs';
import type { BbsBar, BbsMember, BbsRow, BbsSettings } from '../src/cad/bbs/types';
import { isLinearMember } from '../src/cad/bbs/build';
import { evaluateFormula, type FormulaVariables } from './formula';
import { validateRow } from './validation';

/** shapes whose arms are measured to the bar centre-line inside a member */
export const STIRRUP_SHAPES = new Set<ShapeCode>(['51', '52', '41', '60']);

export const STOCK_MM = 12000;

export const isStirrupBar = (t: BbsBar['barType']): boolean =>
  t === 'STIRRUP' || t === 'TIE' || t === 'RING';

/** the member axis a set of bars is distributed along */
export function axisLength(member: BbsMember, axis: BbsBar['distributionAxis']): number | null {
  const v =
    axis === 'L' ? member.lengthMm : axis === 'W' ? member.widthMm : member.heightMm;
  return typeof v === 'number' && v > 0 ? v : null;
}

/**
 * The axis a bar RUNS along, given the axis it is SPACED along.
 *
 * These are perpendicular and conflating them is silent. `distributionAxis` is
 * defined — in the model's own instructions — as the axis the bars repeat
 * across: a mat run spaced across a footing's 2300 width runs its 2500 length.
 * Measuring that run against 2300 produced bars 200 mm short apiece on F1, and
 * on an elongated footing it would be far worse. A vertical bar is spaced along
 * nothing, so H maps to itself.
 */
/**
 * The run a linear member's longitudinal bars and links measure over.
 *
 * A boundary wall's run comes from the site plan — the `wall.total_run` fact
 * — because no sheet states it. A beam's run is its own span, and a beam
 * schedule states that as the member's L. Either is a fact on record; a
 * member with neither has no run and its rows say so. Generic: no member
 * type is special-cased, only whether a length is on record.
 */
export function runOf(member: BbsMember, runMm: number | null): number | null {
  if (runMm !== null && runMm > 0) return runMm;
  return statedLengthOf(member);
}

/**
 * The member's length when it is a STATED fact — a schedule-table cell or a
 * person's answer — and null when it is a pointer at a section detail. A
 * typical-detail sheet's "L" for a wall is very often the width of a bay in
 * section, not the run; a beam schedule's SPAN is the span. The provenance
 * the member carries (`dimSources.L`) is what tells the two apart — never
 * the member's name or type.
 */
export function statedLengthOf(member: BbsMember): number | null {
  if (!(typeof member.lengthMm === 'number' && member.lengthMm > 0)) return null;
  const src = member.dimSources?.L ?? '';
  return /^(DRAWING_READ|USER_INPUT)\b/.test(src) ? member.lengthMm : null;
}

export function spanAxis(along: BbsBar['distributionAxis']): BbsBar['distributionAxis'] {
  if (along === 'L') return 'W';
  if (along === 'W') return 'L';
  return 'H';
}

/**
 * The member dimension a bent bar's return legs stand in.
 *
 * A bar running along L or W is a mat bar lying flat, and its end upturns rise
 * through the member's DEPTH. A bar already running vertically (H) — a pedestal
 * or column main — turns into the plan instead, so the shorter plan dimension
 * governs. Returns null when that dimension is not on the sheet, which is the
 * only honest answer when it is genuinely absent.
 */
export function perpendicularDepth(
  member: BbsMember,
  along: BbsBar['distributionAxis'],
): number | null {
  const pick = (v: number | undefined): number | null =>
    typeof v === 'number' && v > 0 ? v : null;
  if (along === 'H') {
    const l = pick(member.lengthMm);
    const w = pick(member.widthMm);
    if (l !== null && w !== null) return Math.min(l, w);
    return l ?? w;
  }
  return pick(member.heightMm);
}

/**
 * THE COVER THAT GOVERNS ONE MEMBER — not the one that governs the sheet.
 *
 * `cover.ts` resolves cover per member off the drawing's own cover table
 * (column 40, tie beam 30, foundation 50) and stamps the answer on the member.
 * This file consumes it. Before that thread existed, every branch below read
 * `settings.coverMm` — one flat figure, defaulting to 50 — so the table was
 * extracted, shown to the reader, and used in exactly zero cutting lengths.
 * A 350×400 tie beam's 8⌀ link then came out 2×(242+292) instead of
 * 2×(282+332): 160 mm short on every stirrup, in the direction that
 * under-orders.
 *
 * The flat setting stays as the fallback for a member the table does not
 * describe — but the fallback is REPORTED (`source: 'settings-default'`) and
 * lands on the row. A defaulted cover and one read off the sheet must never be
 * indistinguishable; that is the whole reason `cover.ts` refuses to borrow a
 * neighbouring row's figure in the first place.
 */
export interface ResolvedCover {
  mm: number;
  source: string;
  /** true when the sheet's cover table said nothing about this member */
  fallback: boolean;
  assumption?: 'ASSUMED' | 'TO_BE_VERIFIED' | 'BLOCKED';
}

export function coverFor(member: BbsMember, settings: BbsSettings): ResolvedCover {
  if (typeof member.coverMm === 'number' && Number.isFinite(member.coverMm) && member.coverMm >= 0) {
    return {
      mm: member.coverMm,
      source: member.coverSource ?? 'member-cover-table',
      fallback: false,
    };
  }
  return {
    mm: settings.coverMm,
    source: 'settings-default',
    fallback: true,
    assumption: settings.coverSource === 'default' ? 'TO_BE_VERIFIED' : 'ASSUMED',
  };
}

export interface LengthResult {
  cuttingLengthMm: number | null;
  source: BbsRow['lengthSource'];
  working?: string;
  /** a, b, c… as a commercial schedule prints them; negative = bend deduction */
  segments?: { label: string; mm: number }[];
  warnings: string[];
  missing?: string;
  /** the member axis the straight length was measured along, when it was */
  measuredAlong?: 'L' | 'W' | 'H';
  /** the lap included INSIDE cuttingLengthMm, per bar — reported, never added again */
  lapMm?: number;
  /**
   * Set when the anchorage gate rejected the length: the axis it was measured
   * along is DISPUTED — its value on record cannot be this bar's length. It is
   * a question for a person (or a re-read), never a verdict on the callout.
   */
  disputedAxis?: 'L' | 'W' | 'H';
}

/**
 * Cutting length from the shape formula.
 *
 * For a stirrup or tie the arms are `member − 2·cover − φ`: the bar's own
 * diameter comes off because the dimension runs to the bar centre. Omitting
 * that φ is the most common stirrup error in a hand-written schedule.
 */
/** How many 90° corners a library shape turns — the bends a deduction applies to. */
export function bendCornersOf(code: ShapeCode): number {
  switch (code) {
    case '51':
    case '41':
      return 4;
    case '52':
    case '21':
      return 2;
    case '11':
      return 1;
    default:
      return 0;
  }
}

export function computeLength(
  bar: BbsBar,
  member: BbsMember,
  settings: BbsSettings,
  runMm: number | null = null,
): LengthResult {
  const warnings: string[] = [];
  const dia = Number(bar.diaMm);

  // A linear member carries TWO families of non-link steel, told apart by
  // how the drawing states them:
  //
  //   stated count, no spacing ("2-16TOR")      → LONGITUDINAL. Runs the
  //     structure: cutting = run + a lap every stock length.
  //   spaced across the run ("T8@200c/c")       → TRANSVERSE. A wall
  //     vertical runs the HEIGHT and marches the run; only its COUNT comes
  //     from the run. Treating it as longitudinal would have cut every wall
  //     vertical at 100 m the moment the run was answered.
  //   spaced along H ("distribution @250 up the face") → horizontal
  //     run-bars: longitudinal length, counted up the height.
  const linear = isLinearMember(member);
  const spacedAcrossRun =
    linear &&
    !isStirrupBar(bar.barType) &&
    !STIRRUP_SHAPES.has(bar.shapeCode) &&
    !!bar.spacingMm &&
    bar.spacingMm > 0 &&
    bar.distributionAxis !== 'H';
  // A LONGITUDINAL BAR ON A LINEAR MEMBER measures over one of two things:
  // the TOTAL RUN of a continuous structure (a boundary wall — run + laps at
  // stock length), or the member's own stated span (a beam whose schedule
  // states it — span − 2×cover, per member, like any straight bar). Which
  // one is a matter of what is on record, not of the member's name: a run
  // fact takes the run formula; a stated span falls through to the straight
  // bar measured along L; neither is a refusal that names both.
  const longitudinal =
    linear &&
    !isStirrupBar(bar.barType) &&
    !STIRRUP_SHAPES.has(bar.shapeCode) &&
    !spacedAcrossRun;
  const spanStated = statedLengthOf(member);
  if (longitudinal && runMm === null && spanStated === null) {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings,
      missing:
        `this bar runs the structure, and neither ${member.mark}'s length nor the TOTAL RUN is on record — ` +
        `give ${member.mark}.length (or answer the run question) and this row computes`,
    };
  }
  if (longitudinal && runMm !== null) {
    const run = runMm;
    const lapEach = (settings.ldMultiple ?? 50) * dia;
    const laps = Math.max(Math.ceil(run / STOCK_MM) - 1, 0);
    const total = run + laps * lapEach;
    return {
      cuttingLengthMm: total,
      source: 'SHAPE_FORMULA',
      measuredAlong: 'L',
      lapMm: laps * lapEach,
      working:
        `run ${(run / 1000).toFixed(1)} m + ${laps} lap${laps === 1 ? '' : 's'} × ` +
        `${lapEach.toFixed(0)} mm (${settings.ldMultiple ?? 50}φ, stock ${STOCK_MM / 1000} m) = ${total.toFixed(0)}`,
      segments: [
        { label: `run ${(run / 1000).toFixed(1)} m`, mm: run },
        ...(laps > 0 ? [{ label: `${laps} laps @ ${lapEach.toFixed(0)}`, mm: laps * lapEach }] : []),
      ],
      warnings,
    };
  }
  const shape = SHAPES[bar.shapeCode];
  if (!shape) {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings,
      missing: `unknown shape code "${bar.shapeCode}"`,
    };
  }

  const resolvedCover = coverFor(member, settings);
  const cover = resolvedCover.mm;
  const dims: Record<string, number> = {};
  // The working opens by naming the cover and where it came from, because
  // every arm below is `something − 2×cover − φ` and a checker cannot verify
  // one of those without knowing which cover went in.
  const parts: string[] = [
    `cover ${cover} mm (${
      resolvedCover.fallback
        // True whether or not the sheet HAS a cover table: this line is written
        // where the table is not in scope, and "the cover table does not
        // describe P1" is a false statement about a sheet that carries no
        // table at all. The row's warning, which can see the notes, draws the
        // distinction.
        ? `project default — this sheet does not state the cover for ${member.mark}`
        : resolvedCover.source
    })`,
  ];
  // true once the bent-shape branch has supplied B/C from the member depth
  let legsDerived = false;
  /** for a straight/bent bar: which member axis its length was read off, and its value */
  let measuredAlong: 'L' | 'W' | 'H' | undefined;
  let measuredMm: number | undefined;

  if (isStirrupBar(bar.barType) || STIRRUP_SHAPES.has(bar.shapeCode)) {
    // A LINK'S CUTTING LENGTH IS A PERIMETER, AND ONLY A CLOSING SHAPE HAS ONE.
    //
    // The branch below computes A and B — the two arms of the cross-section —
    // and then hands them to `shapeLength(bar.shapeCode, dims)`. If the shape
    // is '00' (Straight) that formula is literally `A`: the arms are computed,
    // B is discarded, and ONE ARM is written into the schedule as the cutting
    // length of a closed link.
    //
    // A live run did exactly this on every link on the sheet. A 350 × 350 tie
    // printed 242 mm — 350 − 2×50 − 8, one side of the hoop — where a closed
    // link is 2 × (A + B) plus its hooks, roughly four times that. Nothing
    // looked wrong: 242 is a plausible length, it is arithmetically correct for
    // the formula it was given, and every downstream gate checked it against
    // that same formula. The wrong shape is the whole defect, and it arrives
    // by default: a callout the model never issued a `shape` decision for is
    // built as '00'.
    //
    // So the shape is checked, not corrected. Rewriting '00' to '51' here
    // would be this file deciding the bar is a closed link rather than an open
    // one or a spiral, which is the drawing's call and no one else's.
    if (!STIRRUP_SHAPES.has(bar.shapeCode)) {
      const s = SHAPES[bar.shapeCode];
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing:
          `this bar is a ${bar.barType} — a link — but its shapeCode is "${bar.shapeCode}"` +
          (s ? ` (${s.label}), whose formula is "${s.formulaText}"` : '') +
          '. That returns one ARM of the cross-section, not the perimeter a link is cut to: a ' +
          'closed link is 2 × (A + B) plus its hooks, less the bend deductions. Set shapeCode to ' +
          `one of ${[...STIRRUP_SHAPES].map((c) => `${c} (${SHAPES[c].label})`).join(', ')} — ` +
          'whichever the detail actually draws.',
      };
    }

    // A link wraps the member's CROSS-SECTION — the two axes perpendicular to
    // the one it marches along. Which two that is depends on the member, and
    // hardcoding width × length was right only for a member whose length is a
    // cross-sectional dimension:
    //
    //   column   links stacked up H  → arms are L × W   (350 × 350)   ✓ by luck
    //   tie beam stirrups along L    → arms are W × H   (350 × 400)
    //
    // With the old rule the tie beam took its LENGTH as an arm. On a member
    // spanning a 100 m run that produced a single 200-metre stirrup and 52 t
    // of imaginary T8 — 98% of the whole schedule — from a sheet whose real
    // stirrup is 1.2 m. It is the worst kind of error: enormous, arithmetically
    // consistent, and invisible in a total.
    const axes = { L: member.lengthMm, W: member.widthMm, H: member.heightMm };
    const PERPENDICULAR = {
      L: ['W', 'H'],
      W: ['L', 'H'],
      H: ['L', 'W'],
    } as const;

    let names: readonly ['L' | 'W' | 'H', 'L' | 'W' | 'H'];
    if (bar.distributionAxis) {
      // A LOOKUP THAT CANNOT SILENTLY PRODUCE undefined.
      //
      // Run 009 crashed on the next line but one. `distributionAxis` was "y",
      // PERPENDICULAR['y'] was undefined, and `names[0]` threw a TypeError that
      // killed a live run mid-flight. The boundary in contract.ts is what stops
      // an illegal axis arriving here at all; this is the second line of
      // defence, because a raw TypeError is the least useful way for a schedule
      // to fail and it discards everything else the run had established.
      //
      // It reports rather than throws, and names the value — an UNAVAILABLE row
      // with a reason survives into the schedule as a visible gap.
      const perpendicular = PERPENDICULAR[bar.distributionAxis];
      if (!perpendicular) {
        return {
          cuttingLengthMm: null,
          source: 'UNAVAILABLE',
          warnings,
          missing:
            `this bar is spaced along "${bar.distributionAxis}", which is not one of the member's ` +
            'axes (L, W, H). The axis a bar marches along decides which two axes its links wrap, ' +
            'so nothing can be cut until it is stated correctly.',
        };
      }
      names = perpendicular;
    } else {
      // No axis stated. The cross-section is never the member's longest axis,
      // so the two smallest are the only defensible reading — and it is
      // recorded as an inference rather than passed off as read.
      const ranked = (['L', 'W', 'H'] as const)
        .filter((k) => typeof axes[k] === 'number' && (axes[k] as number) > 0)
        .sort((p, q) => (axes[p] as number) - (axes[q] as number));
      if (ranked.length < 2) {
        return {
          cuttingLengthMm: null,
          source: 'UNAVAILABLE',
          warnings,
          missing: 'member cross-section — fewer than two axes are on this sheet',
        };
      }
      names = [ranked[0], ranked[1]];
      warnings.push(
        `no distribution axis was given for this link, so its cross-section was taken as the two ` +
          `smallest axes (${names[0]}=${axes[names[0]]}, ${names[1]}=${axes[names[1]]})`,
      );
    }

    // A link cannot wrap a member's DOMINANT axis.
    //
    // The perpendicular rule above is right about which plane a link lies in,
    // but it still trusts the declared axis. A link declared as spaced along W
    // on a member whose L is the 100 m run takes L as an arm and produces the
    // same 200-metre stirrup by a different route. That is not a link, and no
    // declaration makes it one: a prismatic member's cross-section excludes
    // the axis it runs along, by definition.
    //
    // "Dominant" is measured, not assumed — a footing at 1800 x 1500 x 400 has
    // no dominant axis and is untouched by this, which is why the ratio test
    // is here rather than a bare "never use the longest axis".
    const present = (['L', 'W', 'H'] as const)
      .map((k) => axes[k])
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((p, q) => q - p);
    if (present.length >= 2 && present[0] > present[1] * 4) {
      const dominant = present[0];
      const wrapsDominant = names.some((k) => axes[k] === dominant);
      if (wrapsDominant) {
        const which = names.find((k) => axes[k] === dominant);
        return {
          cuttingLengthMm: null,
          source: 'UNAVAILABLE',
          warnings,
          missing:
            `this link would wrap ${which}=${dominant} mm, the member's dominant axis — that is ` +
            `its run, not its cross-section` +
            (bar.distributionAxis
              ? `. It is declared as spaced along ${bar.distributionAxis}, which is inconsistent ` +
                'with a link: a link marches ALONG the dominant axis and wraps the other two.'
              : '.'),
        };
      }
    }

    const a = axes[names[0]];
    const b = axes[names[1]];
    if (!(a && a > 0) || !(b && b > 0)) {
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing:
          `member cross-section (${names[0]} × ${names[1]}) not on this sheet` +
          (bar.distributionAxis ? ` — this link is spaced along ${bar.distributionAxis}` : ''),
      };
    }
    dims.A = stirrupArm(a, cover, dia);
    dims.B = stirrupArm(b, cover, dia);
    parts.push(
      `A = ${names[0]} ${a} − 2×${cover} − ${dia} = ${dims.A.toFixed(0)}`,
      `B = ${names[1]} ${b} − 2×${cover} − ${dia} = ${dims.B.toFixed(0)}`,
    );
    if (dims.A <= 0 || dims.B <= 0) {
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing: `cover ${cover} mm leaves no room in a ${Math.min(a, b)} mm section`,
      };
    }
  } else {
    // A straight or bent bar runs along ONE named axis of the member. If that
    // axis is not on this sheet, the length is unavailable — falling back to a
    // different dimension would silently schedule a pedestal's bars to its
    // plan width instead of its height, which is exactly the invented number
    // this module exists to prevent.
    // The axis the bar RUNS along — perpendicular to the one it repeats
    // across. On a linear member a transverse bar runs the HEIGHT regardless
    // of which plan axis it is spaced along: spanAxis(L)=W would hand a wall
    // vertical the 200 mm thickness as its length.
    // a longitudinal bar on a member whose span is stated runs that span
    const wanted = spacedAcrossRun ? 'H' : longitudinal ? 'L' : spanAxis(bar.distributionAxis ?? 'H');
    const axis = axisLength(member, wanted);
    if (spacedAcrossRun && !(axis && axis > 0)) {
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing:
          'a transverse bar on a wall/beam runs the member HEIGHT, which is not ' +
          'answered — give the height and this row computes',
      };
    }
    if (!(axis && axis > 0)) {
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing:
          `member ${wanted} dimension not on this sheet — pedestal and column ` +
          'heights are usually on the foundation GA or a section drawing',
      };
    }
    measuredAlong = wanted ?? undefined;
    measuredMm = axis;
    // the cover, unless the drawing dimensioned a different end distance
    const endGap = bar.endDeductionMm ?? cover;
    dims.A = axis - 2 * endGap;
    parts.push(
      `A = ${axis} − 2×${endGap}${bar.endDeductionMm !== undefined ? ' (X/Y from the schedule)' : ''} = ${dims.A.toFixed(0)}`,
    );

    // A bent bar needs its return legs. On a footing or slab mat bar those are
    // the end upturns, and they are NOT missing information: the leg runs from
    // the bottom cover to the top cover, so it is the member's depth less both
    // covers — and the depth is in the schedule table like every other
    // dimension. Refusing to derive it was treating a stated dimension as an
    // absent one, which left every row of a perfectly complete footing
    // schedule unpriced.
    //
    // This stays inside the no-guess rule because both inputs are read off the
    // drawing and the substituted arithmetic is shown in `lengthWorking`. When
    // the depth genuinely is not on the sheet, it still refuses.
    if (shape.dims.length > 1 && shape.code !== '00') {
      const depth = perpendicularDepth(member, wanted);
      if (!(depth && depth > 0)) {
        return {
          cuttingLengthMm: null,
          source: 'UNAVAILABLE',
          warnings,
          missing:
            `shape ${shape.code} (${shape.label}) needs ${shape.dims.join(', ')}; the return ` +
            'legs come from the member depth, which is not on this sheet',
        };
      }
      // The upper mat layer rests on the lower one, so its legs start a bar
      // diameter higher. Set by conventions.ts, never by the model.
      const layer = bar.upperLayer ? dia : 0;
      const leg = depth - 2 * cover - layer;
      if (leg <= 0) {
        return {
          cuttingLengthMm: null,
          source: 'UNAVAILABLE',
          warnings,
          missing: `cover ${cover} mm leaves no return leg in a ${depth} mm depth`,
        };
      }
      for (const d of shape.dims) {
        if (d === 'A') continue;
        dims[d] = leg;
      }
      legsDerived = true;
      parts.push(
        `${shape.dims.filter((d) => d !== 'A').join(' = ')} = ${depth} − 2×${cover}` +
          `${layer ? ` − ${layer} (upper layer)` : ''} = ${leg.toFixed(0)} (end upturn)`,
      );
      warnings.push(
        `Return legs taken as the ${depth} mm depth less 2 × ${cover} mm cover. If the detail ` +
          'shows a shorter upturn, correct the cover or the shape.',
      );
    }
  }

  const base = shapeLength(bar.shapeCode, dims);
  if (base === null) {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings,
      missing: `shape formula ${shape.formulaText} produced no length`,
    };
  }
  parts.push(`${shape.formulaText} = ${base.toFixed(0)}`);

  // The segment breakdown a, b, c… — the form every commercial BBS prints the
  // cutting length in, because a checker verifies the LEGS, not the total. The
  // engine computes these anyway to reach `base`; keeping them costs nothing
  // and turns the export from a number into something auditable.
  // Order them as the bar is BENT, not as the formula names them.
  //
  // For a U the shape's dims are A (the run) then B, C (the return legs), but
  // a commercial schedule prints leg, run, leg — 0.250 | 2.400 | 0.250 —
  // because that is the order a detailer reads them off the bar. Printing
  // 2.400 | 0.250 | 0.250 holds the same numbers and is harder to check.
  const segments: { label: string; mm: number }[] = [];
  const bent = legsDerived && shape.dims.length >= 3;
  const order = bent
    ? [shape.dims[1], shape.dims[0], ...shape.dims.slice(2)]
    : shape.dims;
  for (const d of order) {
    const v = dims[d];
    if (typeof v === 'number') segments.push({ label: d, mm: v });
  }

  // hooks add, bends deduct — see IS 2502
  let total = base;
  for (const [end, hook] of [['start', bar.hookStart], ['end', bar.hookEnd]] as const) {
    if (!hook || hook === 'none') continue;
    // A bent shape whose return legs we derived ALREADY has the upturn in B
    // and C. Adding a hook allowance on top would count the same steel twice —
    // the upturn IS the hook. Commercial schedules show exactly the legs plus
    // the bend deduction, and nothing else.
    if (legsDerived) {
      warnings.push(
        `${end} ${hook} ignored: the ${shape.code} return legs already include the upturn.`,
      );
      continue;
    }
    const a = hookAllowance(dia, hook);
    total += a;
    segments.push({ label: `hook ${end}`, mm: a });
    parts.push(`+ ${end} ${hook} = ${a.toFixed(0)}`);
  }

  const corners = bendCornersOf(bar.shapeCode);
  if (corners > 0) {
    const d = bendDeduction(dia, 90, settings.bendMode, {
      stirrup: isStirrupBar(bar.barType),
    });
    total -= corners * d.deductionMm;
    segments.push({ label: 'bend deduction', mm: -corners * d.deductionMm });
    parts.push(`− ${corners} × 90° bend (${d.note}) = ${(corners * d.deductionMm).toFixed(0)}`);
  }

  if (total <= 0) {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings,
      missing: 'deductions exceed the developed length — check cover and section',
    };
  }

  // A BAR SHORTER THAN ITS OWN ANCHORAGE CANNOT BE CUT — AND THAT IS A
  // QUESTION ABOUT THE DIMENSION, NEVER A VERDICT ON THE CALLOUT.
  //
  // A section dimension picked up as a length produces a SHORT number, and a
  // short number computes all the way to a weight with nothing objecting.
  // The floor is IS 456 cl 26.2.1: a bar develops its strength over its
  // development length, so a length under Ld has nowhere to anchor.
  //
  // What the gate may NOT do is turn that arithmetic failure into a reading of
  // the drawing ("this is a dimension, not a bar"). F3-M1 and F3-M3 on the
  // foundations sheet were declared "not a bar" on the strength of a W = 200
  // that a schedule table two inches away states as 3800. The row is held
  // with the AXIS DISPUTED — the value on record cannot be this bar's length —
  // and the orchestrator re-reads the section and asks the person. It is the
  // dimension that is in question, and the callout keeps its meaning.
  //
  // Links are exempt: a link's length is a closed perimeter held by its hooks,
  // not an anchorage, and a 242 mm hoop round a 350 mm column is real steel.
  const isLink = isStirrupBar(bar.barType) || STIRRUP_SHAPES.has(bar.shapeCode);
  if (!isLink) {
    const ldMm = settings.ldMultiple
      ? settings.ldMultiple * dia
      : developmentLength(dia, settings.concreteGrade, settings.steelGrade)?.ldMm;
    if (typeof ldMm === 'number' && ldMm > 0 && total < ldMm) {
      const axisName = measuredAlong === 'L' ? 'length' : measuredAlong === 'W' ? 'width' : 'height';
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        ...(measuredAlong !== undefined ? { measuredAlong, disputedAxis: measuredAlong } : {}),
        missing:
          (measuredAlong !== undefined ? `AXIS DISPUTED (${member.mark}.${axisName}) — ` : '') +
          `this bar comes out ${total.toFixed(0)} mm long` +
          (measuredAlong !== undefined && measuredMm !== undefined
            ? `, measured along the member's ${measuredAlong} = ${measuredMm} mm`
            : '') +
          `, which is under the ${ldMm.toFixed(0)} mm development length a T${dia} needs to anchor ` +
          '(IS 456 cl 26.2.1). The callout is still a reinforcement bar; the figure on record ' +
          `for ${measuredAlong !== undefined ? `${member.mark}'s ${measuredAlong}` : 'the axis it runs along'} cannot be its length. ` +
          'Re-read the section and the nearby callouts, check "distributionAxis" (the axis the ' +
          'bars are SPACED along; they RUN along its perpendicular) and the member dimension, ' +
          `and if still unclear confirm ${measuredAlong !== undefined ? `${member.mark}.${axisName}` : 'the dimension'} in mm.`,
      };
    }
  }

  // Fix 5: Closed-tie geometry must be confirmed before accepting CL
  if (bar.barType === 'TIE' || bar.shapeCode === '51' || bar.shapeCode === '52') {
    if (!(typeof member.lengthMm === 'number' && member.lengthMm > 0 && typeof member.widthMm === 'number' && member.widthMm > 0)) {
      return {
        cuttingLengthMm: null,
        source: 'UNAVAILABLE',
        warnings,
        missing: 'Closed-tie geometry requires both plan dimensions to be confirmed.',
      };
    }
  }

  // The cover's STATUS (DRAWING_READ / USER_INPUT / ASSUMED) rides the row
  // beside the length — see scheduleRow. It does not change the length's
  // SOURCE: a length from the shape formula is SHAPE_FORMULA whatever cover it
  // was cut to, and the assumption is reported as itself, not disguised as a
  // different derivation.
  return {
    cuttingLengthMm: total,
    segments,
    source: 'SHAPE_FORMULA',
    working: `${parts.join(';  ')}  →  ${total.toFixed(0)} mm`,
    warnings,
    ...(measuredAlong !== undefined ? { measuredAlong } : {}),
  };
}

/** bars per member, from a spacing or a stated count */
export function countBars(
  bar: BbsBar,
  member: BbsMember,
  settings: BbsSettings,
  runMm: number | null = null,
): { count: number | null; warnings: string[]; missing?: string } {
  const warnings: string[] = [];
  // A multi-legged link is SETS of hoops. "4L-8TOR@150" states four legs; a
  // two-legged hoop provides two, so each set is two hoops of the same
  // cross-section arms. The callout stated the legs and the drawing stated the
  // spacing of the SETS — pricing the set as one hoop halved the steel, which
  // is exactly what a schedule must never quietly do.
  const hoops =
    (isStirrupBar(bar.barType) || STIRRUP_SHAPES.has(bar.shapeCode)) &&
    typeof bar.legs === 'number' &&
    bar.legs > 2
      ? Math.ceil(bar.legs / 2)
      : 1;
  const setNote = (sets: number): void => {
    if (hoops > 1) {
      warnings.push(
        `${bar.legs}-legged: ${sets} set(s) × ${hoops} hoops = ${sets * hoops} bars. Each hoop ` +
          'is priced at the full cross-section arms; an inner hoop drawn narrower would be shorter.',
      );
    }
  };
  // Stirrups AND transverse bars (wall verticals) on a linear member march
  // the RUN — only bars spaced along H (horizontals climbing the face) count
  // against a member axis.
  if (
    isLinearMember(member) &&
    bar.spacingMm &&
    bar.spacingMm > 0 &&
    (isStirrupBar(bar.barType) ||
      STIRRUP_SHAPES.has(bar.shapeCode) ||
      bar.distributionAxis !== 'H')
  ) {
    const run = runOf(member, runMm);
    if (run === null) {
      return {
        count: null,
        warnings,
        missing:
          `these bars are spaced at ${bar.spacingMm} c/c along the run of ${member.mark}, and neither ` +
          `${member.mark}'s length nor the TOTAL RUN is on record — no count was assumed. ` +
          `Give ${member.mark}.length (or answer the run) and this row counts.`,
      };
    }
    const sets = Math.floor(run / bar.spacingMm) + 1;
    setNote(sets);
    return { count: sets * hoops, warnings };
  }
  if (typeof bar.manualCount === 'number' && bar.manualCount > 0) {
    setNote(bar.manualCount);
    return { count: bar.manualCount * hoops, warnings };
  }
  if (!(bar.spacingMm && bar.spacingMm > 0)) {
    return {
      count: null,
      warnings,
      missing: `"${bar.fromCallout}" states neither a spacing nor a number of bars, so nothing ` +
        'divides into a count — no count was assumed.',
    };
  }
  const along = bar.distributionAxis ?? 'H';
  const axis = axisLength(member, along);
  if (axis === null) {
    // THE FIELD IT WAITS ON, BY NAME.
    //
    // These bars are spaced along an axis of the member, so the count is that
    // axis divided by the spacing. Without the axis there is no count — and
    // the row must say WHICH dimension it is waiting on, because that sentence
    // is what the gap panel turns into a question and what a person answers.
    return {
      count: null,
      warnings,
      missing:
        `these bars are spaced at ${bar.spacingMm} c/c along ${member.mark}'s ${along}, and ${along} ` +
        'is not resolved on this sheet — so the count cannot be derived and no count was assumed. ' +
        `Resolve ${member.mark}.${along} and this row counts.`,
    };
  }
  // Bars stop at the cover line, so the span they divide into is
  // `axis − 2×cover` — the same per-member cover the cutting length used. A
  // count taken against 50 mm and a length taken against 30 would be two
  // different members' arithmetic on one row.
  const c = countBySpacing(axis, bar.spacingMm, coverFor(member, settings).mm);
  if (!c) {
    return {
      count: null,
      warnings,
      missing: `${axis} mm at ${bar.spacingMm} c/c produced no positions — check the spacing.`,
    };
  }
  if (c.warning) warnings.push(c.warning);
  setNote(c.count);
  return { count: c.count * hoops, warnings };
}

/** deterministic, stable, unique per member — the drawing rarely carries marks */
export function assignMark(bar: BbsBar, used: Set<string>): string {
  if (bar.barMark && !used.has(bar.barMark)) {
    used.add(bar.barMark);
    return bar.barMark;
  }
  const prefix = isStirrupBar(bar.barType) ? 'T' : 'M';
  let i = 1;
  let mark = `${bar.memberMark}-${prefix}${i}`;
  while (used.has(mark)) mark = `${bar.memberMark}-${prefix}${++i}`;
  used.add(mark);
  return mark;
}

// ============================================================
// THE STAGE PIPELINE
// ============================================================

/** The stages a row passes through, in order. */
export const ROW_STAGES = [
  'INPUT_RESOLVED',
  'GEOMETRY_RESOLVED',
  'CUTTING_LENGTH_RESOLVED',
  'QUANTITY_RESOLVED',
  'TOTAL_BARS_RESOLVED',
  'TOTAL_LENGTH_RESOLVED',
  'UNIT_WEIGHT_RESOLVED',
  'WEIGHT_RESOLVED',
  'VALIDATED',
] as const;
export type RowStage = (typeof ROW_STAGES)[number];

/** Where a row's cover came from — the vocabulary the schedule reports in. */
export type CoverStatus = 'DRAWING_READ' | 'USER_INPUT' | 'ASSUMED';

export interface RowStageTrace {
  /** the stages reached, in order */
  stages: RowStage[];
  /** the first stage that could not complete, when one could not */
  failedStage?: RowStage;
  /** the fact id the row is waiting on, when one can be named ("F8.length") */
  missingFact?: string;
  /** where the missing figure was looked for */
  source?: string;
  /** the engine's own reason, verbatim */
  reason?: string;
  /** what unblocks the row */
  action?: string;
  /** the fact ids this row's figures rest on — the manifest's dependency list */
  factsUsed: string[];
  /** cover, as spent */
  coverMm: number;
  coverSource: string;
  coverStatus: CoverStatus;
  /** the axis the cutting length was measured along, when it was */
  measuredAlong?: 'L' | 'W' | 'H';
  /** the callout text the row was read from, verbatim */
  sourceText: string;
  /** the drawing entity handles behind that callout, when the reader kept them */
  sourceHandles: string[];
  /** how each figure was arrived at */
  method: {
    cuttingLength: 'ENTERED' | 'DRAWN_GEOMETRY' | 'CUSTOM_FORMULA' | 'SHAPE_FORMULA' | 'BLOCKED';
    quantity: 'MANUAL' | 'AUTO_SPACING' | 'CUSTOM_FORMULA' | 'RUN' | 'BLOCKED';
    unitWeight: 'IS_1786_NOMINAL' | 'DENSITY_FALLBACK' | 'NONE';
  };
  /** the substituted arithmetic, as the engine wrote it */
  formula?: string;
  /** where each member axis the row read came from (DRAWING_READ / USER_INPUT / pointer) */
  dimSources: Partial<Record<'L' | 'W' | 'H', string>>;
}

export interface ScheduleRowInput {
  bar: BbsBar;
  member: BbsMember;
  settings: BbsSettings;
  /** the run in mm, when a linear job has one */
  runMm: number | null;
  /** a cutting length a person typed for this bar — ENTERED, never derived */
  enteredCuttingLengthMm?: number;
  /** the sheet declares the cutting length a design input — where, and what it says */
  declaredInput?: { where: string; saidAs: string } | null;
  /** the member count from a project fact, when the interpretation carries none */
  takeoffCount: number | null;
  /** the sheet's cover table, for the row's own wording of a fallback */
  coverTable: readonly { member: string }[];
  /** the mark this row will carry */
  barMark: string;
  /** the derivation text the row prints */
  description: string;
}

const AXIS_NAME = { L: 'length', W: 'width', H: 'height' } as const;

const factIdFor = (mark: string, axis: 'L' | 'W' | 'H'): string => `${mark}.${AXIS_NAME[axis]}`;

/** The cover status in the schedule's vocabulary. */
export function coverStatusOf(cover: ResolvedCover, settings: BbsSettings): CoverStatus {
  if (!cover.fallback) {
    return /user|supplied|stated|answer/i.test(cover.source) ? 'USER_INPUT' : 'DRAWING_READ';
  }
  if (settings.coverSource === 'stated') return 'USER_INPUT';
  if (settings.coverSource === 'sheet') return 'DRAWING_READ';
  return 'ASSUMED';
}

// ------------------------------------------------------------
// 1. geometry
// ------------------------------------------------------------

export interface GeometryResolution {
  ok: boolean;
  cover: ResolvedCover;
  coverStatus: CoverStatus;
  /** the member axes as resolved, mm; absent = not on record */
  axes: Partial<Record<'L' | 'W' | 'H', number>>;
  /** the axis this bar runs along, when the bar type fixes one */
  runsAlong?: 'L' | 'W' | 'H';
  /** the axis it is spaced along, when it is spaced */
  spacedAlong?: 'L' | 'W' | 'H';
  /** the axes this row needs and does not have */
  missingAxes: ('L' | 'W' | 'H')[];
  factsUsed: string[];
}

/**
 * What the member offers this bar: its axes, the cover the arms are cut to,
 * and which axis the bar runs along. Nothing is measured here — the member's
 * dims were resolved upstream from DRAWING_READ / USER_INPUT facts; this
 * stage only reads them and names what is absent.
 */
export function resolveGeometry(input: Pick<ScheduleRowInput, 'bar' | 'member' | 'settings'>): GeometryResolution {
  const { bar, member, settings } = input;
  const cover = coverFor(member, settings);
  const coverStatus = coverStatusOf(cover, settings);
  const axes: GeometryResolution['axes'] = {};
  const factsUsed: string[] = [];
  const take = (axis: 'L' | 'W' | 'H', v: number | undefined): void => {
    if (typeof v === 'number' && v > 0) {
      axes[axis] = v;
      factsUsed.push(factIdFor(member.mark, axis));
    }
  };
  take('L', member.lengthMm);
  take('W', member.widthMm);
  take('H', member.heightMm);
  factsUsed.push(cover.fallback ? 'settings.cover' : `${member.mark}.cover`);

  const link = isStirrupBar(bar.barType) || STIRRUP_SHAPES.has(bar.shapeCode);
  const linear = isLinearMember(member);
  let runsAlong: GeometryResolution['runsAlong'];
  let spacedAlong: GeometryResolution['spacedAlong'];
  const needed: ('L' | 'W' | 'H')[] = [];
  if (link) {
    const along = (bar.distributionAxis ?? 'L') as 'L' | 'W' | 'H';
    spacedAlong = along;
    const perp = { L: ['W', 'H'], W: ['L', 'H'], H: ['L', 'W'] } as const;
    needed.push(...(perp[along] ?? ['W', 'H']));
  } else if (linear && bar.distributionAxis !== 'H') {
    runsAlong = 'H';
    spacedAlong = bar.distributionAxis ?? 'L';
    needed.push('H');
  } else {
    const along = bar.distributionAxis ?? 'H';
    spacedAlong = along;
    runsAlong = spanAxis(along) ?? undefined;
    if (runsAlong) needed.push(runsAlong);
    if (bar.spacingMm && !(typeof bar.manualCount === 'number' && bar.manualCount > 0)) needed.push(along);
  }
  const missingAxes = [...new Set(needed)].filter((a) => !(axes[a] && axes[a]! > 0));
  return { ok: missingAxes.length === 0, cover, coverStatus, axes, runsAlong, spacedAlong, missingAxes, factsUsed };
}

// ------------------------------------------------------------
// 2. cutting length
// ------------------------------------------------------------

export type CuttingLengthResolution = LengthResult & {
  /** the priority the row was cut by */
  by: 'ENTERED' | 'DRAWN_GEOMETRY' | 'CUSTOM_FORMULA' | 'SHAPE_FORMULA' | 'BLOCKED';
};

/**
 * Cutting length priority: an entered figure > the shape formula > BLOCKED.
 * A missing cutting length is null with a reason. It is never replaced by 0.
 */
export function resolveCuttingLength(
  input: Pick<ScheduleRowInput, 'bar' | 'member' | 'settings' | 'runMm' | 'enteredCuttingLengthMm' | 'declaredInput'>,
  geometry: GeometryResolution,
): CuttingLengthResolution {
  const typed = input.enteredCuttingLengthMm;
  if (typeof typed === 'number' && Number.isFinite(typed) && typed > 0) {
    return {
      cuttingLengthMm: typed,
      source: 'ENTERED',
      working: `${typed.toFixed(0)} mm entered by hand — not derived from the drawing`,
      warnings: [],
      by: 'ENTERED',
    };
  }
  const { member, settings } = input;

  // 2. THE DRAWING'S OWN GEOMETRY. A bar the detail actually draws is cut to
  // what is drawn — a polyline's segments summed, or a developed length the
  // sheet states — and no library formula is consulted. A custom shape (CUS)
  // with nothing drawn behind it has no length and says so.
  const drawn = input.bar.drawnGeometry;
  if (drawn) {
    const fromVertices = drawn.vertices && drawn.vertices.length >= 2 ? polylineLength(drawn.vertices, drawn.closed) : null;
    const developed =
      typeof drawn.developedLengthMm === 'number' && drawn.developedLengthMm > 0 ? drawn.developedLengthMm : fromVertices;
    if (developed && developed > 0) {
      return {
        cuttingLengthMm: developed,
        source: 'DRAWN_GEOMETRY',
        working:
          `${developed.toFixed(0)} mm — the drawing's own geometry (${drawn.source}` +
          `${fromVertices !== null && developed === fromVertices ? `, ${drawn.vertices!.length} vertices summed` : ', developed length as stated'})` +
          '; no shape formula applied',
        segments: [{ label: 'drawn', mm: developed }],
        warnings: [],
        by: 'DRAWN_GEOMETRY',
      };
    }
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings: [],
      missing: `this bar's drawn geometry (${drawn.source}) has no measurable length — neither a developed length nor two or more vertices`,
      by: 'BLOCKED',
    };
  }
  if (input.bar.shapeCode === 'CUS') {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings: [],
      missing: "shape CUS is the drawing's own geometry, and none was recorded for this bar — trace the bar on the detail or give its developed length",
      by: 'BLOCKED',
    };
  }

  // 3. A STATED FORMULA for the length, over the approved variables only.
  if (input.bar.lengthFormula) {
    const vars = formulaVariablesFor(input.bar, member, geometry.cover.mm);
    const f = evaluateFormula(input.bar.lengthFormula, vars);
    if (f.ok && f.value! > 0) {
      return {
        cuttingLengthMm: f.value!,
        source: 'CUSTOM_FORMULA',
        working: `${f.value!.toFixed(0)} mm — stated formula: ${f.working}`,
        segments: [{ label: 'formula', mm: f.value! }],
        warnings: [],
        by: 'CUSTOM_FORMULA',
      };
    }
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings: [],
      missing: `the stated length formula "${input.bar.lengthFormula}" could not be evaluated — ${f.reason ?? 'it produced no positive length'}`,
      by: 'BLOCKED',
    };
  }

  const cover = geometry.cover;
  // A COVER NOBODY STATED CANNOT PRODUCE A CUTTING LENGTH.
  //
  // Every arm of a link is `section − 2×cover − φ` and both ends of a straight
  // bar are `axis − 2×cover`, so cover is not a detail of the arithmetic — it
  // is most of it. With no cover on the sheet, none supplied, and the caller
  // having established that (`coverSource === 'default'`), a computed length
  // would be a plausible figure resting on something that was never a
  // reading, printed beside lengths that WERE read with nothing to tell them
  // apart. The row is held open with `settings.cover` as its MISSING fact and
  // the cover is asked for. Only the LENGTH is refused: the count is arrived
  // at from spacing and a member axis and still states itself.
  //
  // `coverSource` absent means the caller never established it either way —
  // the row then computes and reports the cover ASSUMED, out loud.
  if (cover.fallback && settings.coverSource === 'default') {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings: [],
      missing:
        `no cover is established for ${member.mark} — this sheet states none and none has ` +
        `been supplied, and cover is in every arm of this bar. The ${cover.mm} mm ` +
        'project default was NOT used to cut it. Give the clear cover in mm and this row computes.',
      by: 'BLOCKED',
    };
  }
  if (input.declaredInput) {
    return {
      cuttingLengthMm: null,
      source: 'UNAVAILABLE',
      warnings: [],
      missing:
        `this drawing declares the cutting length a design input — ${input.declaredInput.where} ` +
        `reads "${input.declaredInput.saidAs}". Nothing on the sheet fixes it, so nothing has ` +
        'been derived: give the cutting length in mm and this row computes.',
      by: 'BLOCKED',
    };
  }
  const derived = computeLength(input.bar, member, settings, input.runMm);
  return { ...derived, by: derived.cuttingLengthMm === null ? 'BLOCKED' : 'SHAPE_FORMULA' };
}

// ------------------------------------------------------------
// 3. quantity
// ------------------------------------------------------------

export interface QuantityResolution {
  /** bars per member — MANUAL count, or ⌈(axis − 2·cover) / spacing⌉ + 1 */
  barsPerMember: number | null;
  mode: 'MANUAL' | 'AUTO_SPACING' | 'CUSTOM_FORMULA' | 'RUN' | 'BLOCKED';
  memberCount: number | null;
  totalBars: number | null;
  warnings: string[];
  missing?: string;
  memberMissing?: string;
  factsUsed: string[];
}

/**
 * n = manual_quantity, or ⌈span / spacing⌉ + 1 with span = axis − 2×cover;
 * totalBars = n × member count. An explicit member count is never re-derived
 * from spacing. A count that cannot be derived is null — never 0.
 */
export function calculateQuantity(
  input: Pick<ScheduleRowInput, 'bar' | 'member' | 'settings' | 'runMm' | 'takeoffCount'>,
): QuantityResolution {
  const { bar, member, settings, runMm } = input;
  // A STATED FORMULA for the count outranks spacing arithmetic, as a manual
  // count does: the person said how many, in their own terms.
  const formulaCount = bar.countFormula
    ? (() => {
        const f = evaluateFormula(bar.countFormula, formulaVariablesFor(bar, member, coverFor(member, settings).mm));
        return f.ok && f.value! > 0
          ? { count: Math.ceil(f.value!), warnings: [`bars per member by stated formula: ${f.working}`] }
          : {
              count: null,
              warnings: [] as string[],
              missing: `the stated count formula "${bar.countFormula}" could not be evaluated — ${f.reason ?? 'it produced no positive count'}`,
            };
      })()
    : null;
  const cnt = formulaCount ?? countBars(bar, member, settings, runMm);
  const factsUsed: string[] = [];
  const mode: QuantityResolution['mode'] =
    cnt.count === null
      ? 'BLOCKED'
      : formulaCount
        ? 'CUSTOM_FORMULA'
        : typeof bar.manualCount === 'number' && bar.manualCount > 0
          ? 'MANUAL'
          : isLinearMember(member) && bar.spacingMm && bar.distributionAxis !== 'H'
            ? 'RUN'
            : 'AUTO_SPACING';
  if (mode === 'RUN') factsUsed.push('wall.total_run');
  if (mode === 'AUTO_SPACING') {
    const along = (bar.distributionAxis ?? 'H') as 'L' | 'W' | 'H';
    factsUsed.push(factIdFor(member.mark, along));
  }
  const memberCount = member.count > 0 ? member.count : (input.takeoffCount ?? null);
  factsUsed.push(`${member.mark}.count`);
  const totalBars = cnt.count === null || memberCount === null ? null : cnt.count * memberCount;
  const memberMissing =
    memberCount === null
      ? `Member count not stated on this sheet — supply ${member.mark}.count via a project fact or the Specification.`
      : undefined;
  return {
    barsPerMember: cnt.count,
    mode,
    memberCount,
    totalBars,
    warnings: cnt.warnings,
    missing: cnt.missing,
    memberMissing,
    factsUsed,
  };
}

// ------------------------------------------------------------
// 4. weight
// ------------------------------------------------------------

export interface WeightResolution {
  totalLengthM: number | null;
  unitWeightKgPerM: number | null;
  weightKg: number | null;
  weightWithWastageKg: number | null;
  unitWeightSource?: string;
}

/**
 * totalLengthM = cuttingLength × totalBars / 1000; weightKg = totalLengthM ×
 * unit weight (IS 1786 nominal mass); wastage on top. Null all the way down
 * when the length or the count is null.
 */
export function calculateWeight(
  cuttingLengthMm: number | null,
  totalBars: number | null,
  diaMm: number,
  wastagePct: number,
): WeightResolution {
  if (cuttingLengthMm === null || totalBars === null || !(totalBars > 0)) {
    return { totalLengthM: null, unitWeightKgPerM: null, weightKg: null, weightWithWastageKg: null };
  }
  const w = barWeight(cuttingLengthMm, totalBars, diaMm, wastagePct);
  if (!w) {
    return { totalLengthM: null, unitWeightKgPerM: null, weightKg: null, weightWithWastageKg: null };
  }
  return {
    totalLengthM: w.totalLengthM,
    unitWeightKgPerM: w.unitWeightKgPerM,
    weightKg: w.weightKg,
    weightWithWastageKg: w.weightWithWastageKg,
    unitWeightSource: w.unitWeightSource,
  };
}

// ------------------------------------------------------------
// the row
// ------------------------------------------------------------

export interface ScheduledRow {
  row: BbsRow;
  trace: RowStageTrace;
  /** what the engine could not do, for the result's `incomplete` list */
  incomplete: { barMark: string; reason: string }[];
}

/** The action that unblocks a stage, from what it was waiting on. */
function actionFor(missingFact: string | undefined, reason: string): string {
  if (missingFact === 'settings.cover') return 'Give the clear cover in mm; every row cut to the default recomputes.';
  if (missingFact === 'wall.total_run') return 'Answer the total run; every per-running-metre quantity multiplies by it.';
  if (missingFact && /\.count$/.test(missingFact)) return `Confirm how many ${missingFact.replace(/\.count$/, '')} there are in the whole job.`;
  if (missingFact && /\.(length|width|height)$/.test(missingFact)) {
    return `Provide ${missingFact} in mm (or correct the axis this bar runs along) and this row recalculates.`;
  }
  if (/cutting length/i.test(reason)) return 'Give the cutting length in mm; the row is marked ENTERED.';
  return 'Resolve the fact named in the reason and this row recalculates.';
}

/** The fact a refusal names, when it names one. */
function missingFactIn(mark: string, reason: string | undefined, geometry: GeometryResolution): string | undefined {
  const firstMissing = geometry.missingAxes.length ? factIdFor(mark, geometry.missingAxes[0]) : undefined;
  if (!reason) return firstMissing;
  if (/no cover is established/i.test(reason)) return 'settings.cover';
  if (/TOTAL RUN/i.test(reason)) return 'wall.total_run';
  const disputed = /measured along the member['’]s\s+([LWH])\b/i.exec(reason);
  if (disputed) return factIdFor(mark, disputed[1].toUpperCase() as 'L' | 'W' | 'H');
  const resolve = /Resolve\s+([A-Z0-9]+)\.([LWH])\b/i.exec(reason);
  if (resolve) return factIdFor(resolve[1].toUpperCase(), resolve[2].toUpperCase() as 'L' | 'W' | 'H');
  const single = /member\s+([LWH])\s+dimension/i.exec(reason);
  if (single) return factIdFor(mark, single[1].toUpperCase() as 'L' | 'W' | 'H');
  if (/member HEIGHT/i.test(reason)) return factIdFor(mark, 'H');
  const section = /cross-section\s*\(\s*([LWH])\s*[×x]\s*([LWH])\s*\)/i.exec(reason);
  if (section) {
    const a = section[1].toUpperCase() as 'L' | 'W' | 'H';
    const b = section[2].toUpperCase() as 'L' | 'W' | 'H';
    return factIdFor(mark, geometry.axes[a] ? b : a);
  }
  if (/count not stated/i.test(reason)) return `${mark}.count`;
  if (/member depth/i.test(reason)) return factIdFor(mark, 'H');
  return firstMissing;
}

/**
 * One reinforcement row, through every stage, with its trace. This is the
 * function `buildBbs` calls per bar — and nothing else builds a BbsRow.
 */
export function scheduleRow(input: ScheduleRowInput): ScheduledRow {
  const { bar, member, settings, barMark } = input;
  const dia = Number(bar.diaMm);
  const incomplete: { barMark: string; reason: string }[] = [];
  const stages: RowStage[] = ['INPUT_RESOLVED'];
  const factsUsed = new Set<string>();
  const warnings: string[] = [];

  // 1. geometry
  const geometry = resolveGeometry(input);
  for (const f of geometry.factsUsed) factsUsed.add(f);
  if (geometry.ok) stages.push('GEOMETRY_RESOLVED');

  // 2. cutting length
  const len = resolveCuttingLength(input, geometry);
  warnings.push(...len.warnings);
  if (len.cuttingLengthMm !== null) {
    if (!stages.includes('GEOMETRY_RESOLVED')) stages.push('GEOMETRY_RESOLVED');
    stages.push('CUTTING_LENGTH_RESOLVED');
  }

  // 3. quantity
  const qty = calculateQuantity(input);
  for (const f of qty.factsUsed) factsUsed.add(f);
  warnings.push(...qty.warnings);
  if (qty.barsPerMember !== null) stages.push('QUANTITY_RESOLVED');
  if (qty.totalBars !== null) stages.push('TOTAL_BARS_RESOLVED');

  // 4. weight
  const w = calculateWeight(len.cuttingLengthMm, qty.totalBars, dia, settings.wastagePct);
  if (w.totalLengthM !== null) stages.push('TOTAL_LENGTH_RESOLVED');
  if (w.unitWeightKgPerM !== null) stages.push('UNIT_WEIGHT_RESOLVED');
  if (w.weightKg !== null) stages.push('WEIGHT_RESOLVED');
  if (w.unitWeightSource === 'DENSITY_FALLBACK') {
    warnings.push(`${dia} mm is not in IS 1786 Table 1 — unit weight from π/4·d²·7850 instead of nominal mass.`);
  }

  // cover, on the row — the assumption is visible, table or no table
  const cover = geometry.cover;
  if (cover.fallback) {
    const table = input.coverTable;
    warnings.push(
      geometry.coverStatus === 'ASSUMED'
        ? table.length
          ? `Cover ${cover.mm} mm ASSUMED — the ${cover.mm} mm project default, not this sheet's: the cover table names ` +
            `${table.map((c) => `"${c.member}"`).join(', ')}, none of which describes ${member.mark}. ` +
            'Say which row governs it and this row recomputes.'
          : `Cover ${cover.mm} mm ASSUMED — the ${cover.mm} mm project default: this sheet states no cover for ` +
            `${member.mark}, and none was supplied. It is in every arm of this bar, so the ` +
            'cutting length is only as right as that assumption. Give the cover and this row recomputes.'
        : `Cover ${cover.mm} mm from ${geometry.coverStatus === 'USER_INPUT' ? 'your answer (USER_INPUT)' : "the drawing's general note (DRAWING_READ)"}` +
          ` — no row of a cover table names ${member.mark}.`,
    );
  }

  // Ld beside the row, the second opinion
  const derivedLd = developmentLength(dia, settings.concreteGrade, settings.steelGrade);
  if (derivedLd) {
    const ld = settings.ldMultiple ? settings.ldMultiple * dia : derivedLd.ldMm;
    const lap = lapLength(dia, ld);
    warnings.push(
      settings.ldMultiple
        ? `Ld ${ld.toFixed(0)} mm (project convention ${settings.ldMultiple}φ); IS 456 gives ${derivedLd.ldMm.toFixed(0)} mm. Lap ${lap.lapMm.toFixed(0)} mm (${lap.governedBy}).`
        : `Ld ${derivedLd.ldMm.toFixed(0)} mm — ${derivedLd.working}. Lap ${lap.lapMm.toFixed(0)} mm (${lap.governedBy}).`,
    );
  }

  if (len.missing) incomplete.push({ barMark, reason: len.missing });
  if (qty.missing) incomplete.push({ barMark, reason: qty.missing });
  if (qty.memberMissing) incomplete.push({ barMark, reason: qty.memberMissing });

  const complete = w.weightKg !== null;
  if (complete) stages.push('VALIDATED');

  // the trace: which stage stopped it, on what, and what to do
  let failedStage: RowStage | undefined;
  let reason: string | undefined;
  if (!complete) {
    if (len.cuttingLengthMm === null) {
      failedStage = geometry.ok ? 'CUTTING_LENGTH_RESOLVED' : 'GEOMETRY_RESOLVED';
      reason = len.missing;
    } else if (qty.barsPerMember === null) {
      failedStage = 'QUANTITY_RESOLVED';
      reason = qty.missing;
    } else if (qty.totalBars === null) {
      failedStage = 'TOTAL_BARS_RESOLVED';
      reason = qty.memberMissing;
    } else {
      failedStage = 'WEIGHT_RESOLVED';
      reason = 'the weight could not be computed from the length and count above';
    }
  }
  const missingFact = complete ? undefined : missingFactIn(member.mark, reason, geometry);
  const dimsLine = (['L', 'W', 'H'] as const)
    .map((a) => `${a}=${geometry.axes[a] ?? 'not on record'}${member.dimSources?.[a] ? ` (${member.dimSources[a]})` : ''}`)
    .join(', ');
  const trace: RowStageTrace = {
    stages,
    ...(failedStage ? { failedStage } : {}),
    ...(missingFact ? { missingFact } : {}),
    ...(failedStage
      ? {
          source:
            missingFact && /\.(length|width|height)$/.test(missingFact)
              ? `${member.mark} dimensions as resolved: ${dimsLine}`
              : missingFact === 'settings.cover'
                ? `cover: ${cover.source}`
                : `member ${member.mark}, callout "${bar.fromCallout}"`,
          reason: reason ?? 'not computed',
          action: actionFor(missingFact, reason ?? ''),
        }
      : {}),
    factsUsed: [...factsUsed],
    coverMm: cover.mm,
    coverSource: cover.source,
    coverStatus: geometry.coverStatus,
    ...(len.measuredAlong ? { measuredAlong: len.measuredAlong } : {}),
    sourceText: bar.fromCallout,
    sourceHandles: [...(bar.handles ?? [])],
    method: {
      cuttingLength: len.by,
      quantity: qty.mode,
      unitWeight:
        w.unitWeightKgPerM === null ? 'NONE' : w.unitWeightSource === 'DENSITY_FALLBACK' ? 'DENSITY_FALLBACK' : 'IS_1786_NOMINAL',
    },
    ...(len.working ? { formula: len.working } : {}),
    dimSources: { ...(member.dimSources ?? {}) },
  };

  // THE SECOND OPINION — an independent derivation beside the primary.
  let secondOpinion: BbsRow['secondOpinion'];
  if (len.cuttingLengthMm !== null && len.by !== 'ENTERED') {
    const so = secondOpinionLength(bar, member, settings, input.runMm);
    if (so) {
      const toleranceMm = secondOpinionToleranceMm(len.cuttingLengthMm, dia, bendCornersOf(bar.shapeCode));
      const diffMm = so.lengthMm - len.cuttingLengthMm;
      const withinTolerance = Math.abs(diffMm) <= toleranceMm;
      secondOpinion = {
        lengthMm: so.lengthMm,
        terms: so.terms,
        working: so.working,
        primaryMm: len.cuttingLengthMm,
        diffMm,
        toleranceMm,
        withinTolerance,
      };
      if (!withinTolerance) {
        warnings.push(
          `SECOND OPINION disagrees: independent derivation ${so.lengthMm.toFixed(0)} mm vs primary ${len.cuttingLengthMm.toFixed(0)} mm ` +
            `(difference ${diffMm.toFixed(0)} mm, tolerance ${toleranceMm.toFixed(0)} mm). Terms: ${so.working}. ` +
            'Neither was chosen — settle which geometry the detail draws.',
        );
      }
    }
  }

  const row: BbsRow = {
    barMark,
    memberMark: bar.memberMark,
    barType: bar.barType,
    diaMm: dia,
    shapeCode: bar.shapeCode,
    cuttingLengthMm: len.cuttingLengthMm,
    lengthSource: len.source,
    lengthWorking: len.working,
    segments: len.segments,
    description: input.description,
    barsPerMember: qty.barsPerMember,
    memberCount: qty.memberCount,
    totalBars: qty.totalBars,
    missing: [len.missing, qty.missing, qty.memberMissing].filter(Boolean).join('  ·  ') || undefined,
    coverMm: cover.mm,
    coverSource: cover.source,
    coverStatus: geometry.coverStatus,
    coverAssumption: cover.assumption,
    spacingMm: bar.spacingMm,
    totalLengthM: w.totalLengthM,
    unitWeightKgPerM: w.unitWeightKgPerM,
    weightKg: w.weightKg,
    weightWithWastageKg: w.weightWithWastageKg,
    warnings,
    handles: bar.handles,
    fromCallout: bar.fromCallout,
    ...(len.disputedAxis ? { disputedAxis: len.disputedAxis } : {}),
    ...(typeof len.lapMm === 'number' && len.lapMm > 0 ? { lapMm: len.lapMm } : {}),
    ...(secondOpinion ? { secondOpinion } : {}),
    ...(typeof bar.confidence === 'number' ? { confidence: bar.confidence } : {}),
    trace,
  };
  // CALCULATED IS NOT VALIDATED — the row carries both.
  row.engineering = validateRow(row).status;
  return { row, trace, incomplete };
}

// ------------------------------------------------------------
// summary and reconciliation
// ------------------------------------------------------------

/** The steel summary, grouped by diameter only, from the rows that computed. */
export function buildSteelSummary(rows: readonly BbsRow[], wastagePct: number): SummaryLine[] {
  return steelSummary(
    rows
      .filter((r) => r.cuttingLengthMm !== null && r.totalBars !== null && r.totalBars > 0)
      .map((r) => ({
        diaMm: r.diaMm,
        cuttingLengthMm: r.cuttingLengthMm as number,
        totalBars: r.totalBars as number,
        ...(typeof r.lapMm === 'number' ? { lapMm: r.lapMm } : {}),
      })),
    wastagePct,
  );
}

export interface Reconciliation {
  ok: boolean;
  rowsTotalLengthM: number;
  summaryTotalLengthM: number;
  rowsTotalWeightKg: number;
  summaryTotalWeightKg: number;
  /** per diameter, where the two disagree */
  differences: { diaMm: number; lengthDiffM: number; weightDiffKg: number }[];
  /** rows that carry no weight — in no total */
  openRows: string[];
}

/**
 * Σ row.totalLengthM must equal Σ summary.totalLengthM and Σ row.totalWeightKg
 * must equal Σ summary.totalWeightKg, per diameter and overall. Open rows are
 * listed, not zeroed.
 */
export function reconcileSchedule(rows: readonly BbsRow[], summary: readonly SummaryLine[]): Reconciliation {
  const byDia = new Map<number, { m: number; kg: number }>();
  const openRows: string[] = [];
  for (const r of rows) {
    if (r.weightKg === null || r.totalLengthM === null) {
      openRows.push(r.barMark);
      continue;
    }
    const at = byDia.get(r.diaMm) ?? { m: 0, kg: 0 };
    at.m += r.totalLengthM;
    at.kg += r.weightKg;
    byDia.set(r.diaMm, at);
  }
  const differences: Reconciliation['differences'] = [];
  const dias = new Set([...byDia.keys(), ...summary.map((s) => s.diaMm)]);
  for (const dia of dias) {
    const rowsAt = byDia.get(dia) ?? { m: 0, kg: 0 };
    const line = summary.find((s) => s.diaMm === dia);
    const lengthDiffM = (line?.totalLengthM ?? 0) - rowsAt.m;
    const weightDiffKg = (line?.totalWeightKg ?? 0) - rowsAt.kg;
    if (Math.abs(lengthDiffM) > 0.005 || Math.abs(weightDiffKg) > 0.005) {
      differences.push({ diaMm: dia, lengthDiffM, weightDiffKg });
    }
  }
  const rowsTotalLengthM = [...byDia.values()].reduce((n, a) => n + a.m, 0);
  const rowsTotalWeightKg = [...byDia.values()].reduce((n, a) => n + a.kg, 0);
  const summaryTotalLengthM = summary.reduce((n, s) => n + s.totalLengthM, 0);
  const summaryTotalWeightKg = summary.reduce((n, s) => n + s.totalWeightKg, 0);
  return {
    ok: differences.length === 0,
    rowsTotalLengthM,
    summaryTotalLengthM,
    rowsTotalWeightKg,
    summaryTotalWeightKg,
    differences,
    openRows,
  };
}

// ------------------------------------------------------------
// the snapshot printed before a schedule is returned
// ------------------------------------------------------------

/** The variables a row can offer a stated formula. T is the depth when the member has no separate thickness. */
export function formulaVariablesFor(bar: BbsBar, member: BbsMember, coverMm: number): FormulaVariables {
  const v: FormulaVariables = {};
  if (typeof member.lengthMm === 'number' && member.lengthMm > 0) v.L = member.lengthMm;
  if (typeof member.widthMm === 'number' && member.widthMm > 0) v.W = member.widthMm;
  if (typeof member.heightMm === 'number' && member.heightMm > 0) {
    v.H = member.heightMm;
    v.T = member.heightMm;
  }
  if (typeof bar.spacingMm === 'number' && bar.spacingMm > 0) v.S = bar.spacingMm;
  if (Number.isFinite(coverMm) && coverMm >= 0) v.COVER = coverMm;
  const dia = Number(bar.diaMm);
  if (dia > 0) v.DIA = dia;
  return v;
}

// ------------------------------------------------------------
// the second opinion
// ------------------------------------------------------------
//
// An INDEPENDENT cutting length beside the primary. The primary applies the
// shape library's formula and the configured bend mode. This one rebuilds
// the bar from its parts — straight arms, then each corner as an arc — in
// exact-arc geometry, adds hooks, development and lap as their own terms, and
// shows every one. It never shares the primary's total; it shares only the
// member's dimensions and the cover, which are facts, not arithmetic.
//
// The two are then compared. Within tolerance, the row is corroborated. Past
// it, the row is REJECTED for a person to settle — the engine does not pick.

const SECOND_OPINION_TOLERANCE_PCT = 2;

export interface SecondOpinionDerivation {
  lengthMm: number;
  terms: { term: string; mm: number; note?: string }[];
  working: string;
}

export function secondOpinionLength(
  bar: BbsBar,
  member: BbsMember,
  settings: BbsSettings,
  runMm: number | null = null,
): SecondOpinionDerivation | null {
  const dia = Number(bar.diaMm);
  if (!(dia > 0)) return null;
  const cover = coverFor(member, settings).mm;
  const terms: { term: string; mm: number; note?: string }[] = [];
  const link = isStirrupBar(bar.barType) || STIRRUP_SHAPES.has(bar.shapeCode);
  const linear = isLinearMember(member);
  const axes = { L: member.lengthMm, W: member.widthMm, H: member.heightMm } as const;
  const has = (k: 'L' | 'W' | 'H'): boolean => typeof axes[k] === 'number' && (axes[k] as number) > 0;

  // 1. straight arms and the corners between them
  let corners = 0;
  let arms: number[] = [];
  if (link) {
    let a: number;
    let b: number;
    if (bar.distributionAxis) {
      const perp = { L: ['W', 'H'], W: ['L', 'H'], H: ['L', 'W'] } as const;
      const pair = perp[bar.distributionAxis];
      if (!pair || !has(pair[0]) || !has(pair[1])) return null;
      a = axes[pair[0]] as number;
      b = axes[pair[1]] as number;
    } else {
      const ranked = (['L', 'W', 'H'] as const).filter(has).sort((p, q) => (axes[p] as number) - (axes[q] as number));
      if (ranked.length < 2) return null;
      a = axes[ranked[0]] as number;
      b = axes[ranked[1]] as number;
    }
    const A = a - 2 * cover - dia;
    const B = b - 2 * cover - dia;
    if (!(A > 0) || !(B > 0)) return null;
    if (bar.shapeCode === '60') {
      const d = Math.min(A, B);
      terms.push({ term: 'ring circumference π × D', mm: Math.PI * d, note: `D = ${d.toFixed(0)} centre-line` });
    } else if (bar.shapeCode === '52') {
      arms = [B, A, B];
      corners = 2;
    } else {
      arms = [A, B, A, B];
      corners = 4;
    }
  } else {
    const spacedAcrossRun = linear && !!bar.spacingMm && bar.spacingMm > 0 && bar.distributionAxis !== 'H';
    const longitudinal = linear && !spacedAcrossRun;
    if (longitudinal) {
      const span = runMm ?? statedLengthOf(member);
      if (span === null) return null;
      terms.push({ term: 'straight along the run', mm: span });
      if (runMm !== null) {
        const lapEach = (settings.ldMultiple ?? 50) * dia;
        const laps = Math.max(Math.ceil(runMm / STOCK_MM) - 1, 0);
        terms.push({
          term: `lap ${laps} × ${lapEach.toFixed(0)}`,
          mm: laps * lapEach,
          note: `${settings.ldMultiple ?? 50}φ per lap, stock ${STOCK_MM / 1000} m`,
        });
      }
      const total = terms.reduce((n, t) => n + t.mm, 0);
      return { lengthMm: total, terms, working: terms.map((t) => `${t.term} = ${t.mm.toFixed(0)}`).join(' + ') + ` = ${total.toFixed(0)}` };
    }
    const wanted = spacedAcrossRun ? 'H' : spanAxis(bar.distributionAxis ?? 'H');
    const axis = axisLength(member, wanted);
    if (!(axis && axis > 0)) return null;
    const endGap = bar.endDeductionMm ?? cover;
    const A = axis - 2 * endGap;
    if (!(A > 0)) return null;
    const shape = SHAPES[bar.shapeCode];
    if (!shape) return null;
    const legs = shape.code === '00' ? 0 : Math.max(shape.dims.length - 1, 0);
    if (legs > 0) {
      const depth = perpendicularDepth(member, wanted);
      if (!(depth && depth > 0)) return null;
      const leg = depth - 2 * cover - (bar.upperLayer ? dia : 0);
      if (!(leg > 0)) return null;
      if (shape.code === '34') {
        // a crank: the arm plus the extra the inclined length adds, at 45°
        arms = [A];
        const angle = 45;
        const incline = leg / Math.sin((angle * Math.PI) / 180) - leg;
        terms.push({ term: `crank inclined length at ${angle}°`, mm: incline });
      } else {
        arms = [leg, A, ...Array.from({ length: legs - 1 }, () => leg)];
        corners = legs;
      }
    } else {
      arms = [A];
    }
  }
  for (const [i, mm] of arms.entries()) terms.push({ term: `arm ${String.fromCharCode(65 + i)}`, mm });

  // 2. each corner as an arc: the arms meet at a point; the bar turns on an
  //    arc of radius R to the centre-line, which is SHORTER than the corner
  //    by R(2·tan(θ/2) − θ). Shown as allowance (the arc) and deduction (the
  //    two tangent lengths), so nothing is hidden inside a net figure.
  if (corners > 0) {
    const theta = Math.PI / 2;
    const R = (link ? 2 : 4) * dia + dia / 2;
    const tangents = 2 * R * Math.tan(theta / 2);
    const arc = R * theta;
    terms.push({ term: `bend deduction ${corners} × 2R·tan(θ/2)`, mm: -corners * tangents, note: `R = ${R.toFixed(1)} mm to centre-line, θ = 90°` });
    terms.push({ term: `bend allowance ${corners} × R·θ`, mm: corners * arc });
  }

  // 3. hooks, IS 2502
  for (const [end, hook] of [['start', bar.hookStart], ['end', bar.hookEnd]] as const) {
    if (!hook || hook === 'none') continue;
    if (!link && arms.length > 1) continue; // a return leg is already the upturn
    terms.push({ term: `${end} ${hook}`, mm: hookAllowance(dia, hook) });
  }

  // 4. development, when the settings state an anchorage
  if (typeof settings.anchorageMm === 'number' && settings.anchorageMm > 0) {
    terms.push({ term: 'development (anchorage)', mm: settings.anchorageMm });
  }

  const total = terms.reduce((n, t) => n + t.mm, 0);
  if (!(total > 0)) return null;
  return {
    lengthMm: total,
    terms,
    working: terms.map((t) => `${t.term} = ${t.mm >= 0 ? '' : '−'}${Math.abs(t.mm).toFixed(0)}`).join(' ; ') + ` ⇒ ${total.toFixed(0)}`,
  };
}

/** The tolerance the two derivations must agree within: the larger of 2 % and three diameters. */
export function secondOpinionToleranceMm(primaryMm: number, diaMm: number, corners = 0): number {
  // The two derivations treat a corner differently BY DESIGN — the primary by
  // the conventional table (2φ at 90°), the second opinion by the exact arc
  // (R(2·tan(θ/2) − θ), about 1.1φ for a link and 1.9φ for a main bar). That
  // spread is known and small; one diameter per corner covers it, so a
  // disagreement past the tolerance is a wrong arm, a missed hook or a wrong
  // shape — the errors the second opinion exists to catch — never the bend
  // convention itself.
  return Math.max((SECOND_OPINION_TOLERANCE_PCT / 100) * primaryMm, 3 * diaMm) + corners * diaMm;
}

// ------------------------------------------------------------
// row-level reconciliation — DRIFT
// ------------------------------------------------------------

export interface RowDrift {
  barMark: string;
  field:
    | 'member'
    | 'diaMm'
    | 'spacingMm'
    | 'barsPerMember'
    | 'cuttingLengthMm'
    | 'totalBars'
    | 'totalLengthM'
    | 'weightKg'
    | 'weightWithWastageKg';
  stored: number | string | null;
  recalculated: number | string | null;
}

const DRIFT_FIELDS: RowDrift['field'][] = [
  'member', 'diaMm', 'spacingMm', 'barsPerMember', 'cuttingLengthMm', 'totalBars', 'totalLengthM', 'weightKg', 'weightWithWastageKg',
];

/**
 * Re-run the pipeline's answers against what was stored, field by field. A
 * difference is DRIFT — reported, never absorbed. Rows present on one side
 * only are drift on every field.
 */
export function reconcileRows(stored: readonly BbsRow[], recalculated: readonly BbsRow[]): RowDrift[] {
  const out: RowDrift[] = [];
  const byMark = new Map(recalculated.map((r) => [r.barMark, r]));
  const value = (r: BbsRow, f: RowDrift['field']): number | string | null =>
    f === 'member' ? r.memberMark : ((r as unknown as Record<string, unknown>)[f] as number | null | undefined) ?? null;
  const same = (a: number | string | null, b: number | string | null): boolean => {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.005 * Math.max(1, Math.abs(a));
    return false;
  };
  for (const st of stored) {
    const r = byMark.get(st.barMark);
    for (const f of DRIFT_FIELDS) {
      const a = value(st, f);
      const b = r ? value(r, f) : null;
      if (!same(a, b)) out.push({ barMark: st.barMark, field: f, stored: a, recalculated: b });
    }
  }
  const storedMarks = new Set(stored.map((st) => st.barMark));
  for (const r of recalculated) {
    if (storedMarks.has(r.barMark)) continue;
    for (const f of DRIFT_FIELDS) out.push({ barMark: r.barMark, field: f, stored: null, recalculated: value(r, f) });
  }
  return out;
}

export interface ScheduleSnapshotInput {
  drawing: string;
  drawingHash: string;
  /** the highest ledger sequence the build read, or a label */
  factVersion: string | number;
  rows: readonly BbsRow[];
  /** fact ids the build found MISSING (asked, unanswered) */
  missingFacts?: readonly string[];
  /** fact ids the sheet carries but could not be read confidently */
  unreadableFacts?: readonly string[];
  /** rows the manifest marks stale */
  staleRows?: readonly string[];
  reconciliation?: Reconciliation;
}

/** CURRENT DRAWING / DRAWING HASH / FACT VERSION / … — one line each. */
export function scheduleSnapshot(input: ScheduleSnapshotInput): string[] {
  const rows = input.rows;
  const calculated = rows.filter((r) => r.weightKg !== null).length;
  const blocked = rows.length - calculated;
  const missing = [
    ...new Set(input.missingFacts ?? rows.map((r) => r.trace?.missingFact).filter((x): x is string => !!x)),
  ];
  const lines = [
    `CURRENT DRAWING   ${input.drawing}`,
    `DRAWING HASH      ${input.drawingHash}`,
    `FACT VERSION      ${input.factVersion}`,
    `TOTAL ROWS        ${rows.length}`,
    `CALCULATED ROWS   ${calculated}`,
    `BLOCKED ROWS      ${blocked}`,
    `STALE ROWS        ${(input.staleRows ?? []).length}${input.staleRows?.length ? ` — ${input.staleRows.join(', ')}` : ''}`,
    `MISSING FACTS     ${missing.length}${missing.length ? ` — ${missing.join(', ')}` : ''}`,
    `UNREADABLE FACTS  ${(input.unreadableFacts ?? []).length}${input.unreadableFacts?.length ? ` — ${input.unreadableFacts.join(', ')}` : ''}`,
  ];
  if (input.reconciliation) {
    const r = input.reconciliation;
    lines.push(
      r.ok
        ? `RECONCILED        rows ${r.rowsTotalLengthM.toFixed(2)} m / ${r.rowsTotalWeightKg.toFixed(2)} kg == summary ${r.summaryTotalLengthM.toFixed(2)} m / ${r.summaryTotalWeightKg.toFixed(2)} kg` +
            (r.openRows.length ? ` (${r.openRows.length} open row(s) in no total)` : '')
        : `NOT RECONCILED    ${r.differences.map((d) => `T${d.diaMm}: Δ${d.lengthDiffM.toFixed(2)} m / Δ${d.weightDiffKg.toFixed(2)} kg`).join('; ')}`,
    );
  }
  return lines;
}
