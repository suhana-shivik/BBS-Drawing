// BBS engine — the arithmetic half.
//
// Everything numeric in a schedule is produced here, from `domain/india/bbs.ts`,
// out of inputs the drawing stated and the model merely organised. The model's
// interpretation reaches this file as structure (which bar belongs to which
// member, what shape it is) and never as a figure.
//
// The rule that governs every branch below: when a dimension the schedule needs
// is not available, the row reports UNAVAILABLE. It never substitutes a
// plausible number. A BBS that quietly invents a cutting length is worse than
// one with a visible gap — the gap gets filled by a detailer, the invention
// gets cut in steel.
// THE ROW ARITHMETIC LIVES IN calculations/schedule.ts. `buildBbs` below is
// its caller: it grounds members, resolves settings and hands every bar to
// `scheduleRow`; the geometry → cutting length → quantity → weight stages and
// their trace are that module's, and there is no second engine here.
import {
  assignMark,
  buildSteelSummary,
  reconcileSchedule,
  scheduleRow,
} from '../../../calculations/schedule';
import type {
  BbsBar,
  BbsInterpretation,
  BbsMember,
  BbsResult,
  BbsRow,
  BbsSettings,
  DrawingExtract,
} from './types';
import type { BBSBuildManifest } from '../../core/bbs/schemas';
import { describeBar } from './describe';
import type { BbsOverrides } from './overrides';
import { cuttingLengthInputFor, designInputsFrom } from './designInputs';
import { validateSchedule } from '../../../calculations/validation';

/**
 * The mark a bar will carry, computed the same way `buildBbs` computes it.
 *
 * Overrides are keyed by mark, so the panel has to be able to work out a bar's
 * mark BEFORE the schedule is built. Exported so there is exactly one
 * definition of that rule rather than two that can drift apart.
 */
export function barMarksFor(interpretation: BbsInterpretation): string[] {
  const used = new Set<string>();
  return interpretation.bars.map((b) => assignMark(b, used));
}

export const DEFAULT_SETTINGS: BbsSettings = {
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 50,
  bendMode: 'CONVENTIONAL',
  wastagePct: 3,
};

/**
 * Where each setting came from.
 *
 * 'default' is the one that matters: it means NOBODY said this — not the
 * sheet, not the person — and the schedule is resting on DEFAULT_SETTINGS.
 * Concrete and steel grade derive the development length, which is the gate
 * that decides whether a bar is a bar at all, and cover is in every stirrup
 * arm. Merging them in silently made a schedule built on three assumptions
 * indistinguishable from one built on three readings.
 */
export type SettingSource = 'default' | 'sheet' | 'stated';

export interface SettingsResolution {
  settings: BbsSettings;
  /** by BbsSettings key — only the keys this resolver decides are present */
  sources: Partial<Record<keyof BbsSettings, SettingSource>>;
}

/**
 * Settings the drawing itself stated beat the defaults; a caller's explicit
 * settings beat both. Nothing is inferred that the sheet did not say — and
 * `sources` records which of the three it was for every key, so a caller can
 * ask about the ones nobody supplied.
 */
export function resolveSettings(
  extract: DrawingExtract,
  override: Partial<BbsSettings> = {},
): SettingsResolution {
  const settings = settingsFromExtract(extract, override);
  const lapRule = extract.notes.globalRules?.find(
    (r) => r.kind === 'lap' && r.multiple !== undefined,
  );
  const sourceOf = (key: keyof BbsSettings, sheetHasIt: boolean): SettingSource =>
    override[key] !== undefined ? 'stated' : sheetHasIt ? 'sheet' : 'default';
  const sources = {
    concreteGrade: sourceOf('concreteGrade', extract.notes.concreteGrade !== undefined),
    steelGrade: sourceOf('steelGrade', extract.notes.steelGrade !== undefined),
    coverMm: sourceOf('coverMm', extract.notes.coverMm !== undefined),
    ldMultiple: sourceOf('ldMultiple', lapRule !== undefined),
  };
  // Carried ON the settings as well as beside them: `buildBbs` takes a
  // settings object and nothing else, and it is the place that has to refuse
  // to cut a bar to a cover nobody stated.
  return { settings: { ...settings, coverSource: sources.coverMm }, sources };
}

export function settingsFromExtract(
  extract: DrawingExtract,
  override: Partial<BbsSettings> = {},
): BbsSettings {
  // "LAPS, SPLICES & BOND LENGTH SHOULD BE 50 D" is the sheet stating its own
  // development-length multiple — the project's fact, which beats a derivation
  const lapRule = extract.notes.globalRules?.find(
    (r) => r.kind === 'lap' && r.multiple !== undefined,
  );
  return {
    ...DEFAULT_SETTINGS,
    ...(extract.notes.concreteGrade ? { concreteGrade: extract.notes.concreteGrade } : {}),
    ...(extract.notes.steelGrade ? { steelGrade: extract.notes.steelGrade } : {}),
    ...(extract.notes.coverMm !== undefined ? { coverMm: extract.notes.coverMm } : {}),
    ...(lapRule ? { ldMultiple: lapRule.multiple } : {}),
    ...override,
  };
}

/**
 * Fill missing member dimensions from the sheet's own declarations.
 *
 * "TYPICAL DETAIL OF C1-350x350" IS the drawing stating C1's cross-section —
 * with exactly the authority of a schedule row. Before this ran, a member the
 * model failed to dimension left every link UNAVAILABLE and the gap panel
 * asked the user for a number printed on the sheet, which is the precise
 * failure that makes a tool look illiterate.
 *
 * Only MISSING axes are filled; a dimension the model grounded from a table
 * or a person typed always wins. Two dims: the larger is the length, matching
 * the long-bar convention. A third dim is taken as the height — right for
 * "H-POLE 150X150X2400", knowingly rough for a panel's 50 thk, which is why
 * it too never overwrites.
 */
export function groundDeclaredDims(
  interpretation: BbsInterpretation,
  declared: DrawingExtract['declared'],
): BbsInterpretation {
  // Keyed on a normalised name, not the verbatim one.
  //
  // The map was built from `d.name` as written and queried with
  // `mark.toUpperCase()`, so a declaration this office happens to spell in
  // mixed case grounded nothing — and the panel then asked the user for a
  // thickness the sheet states sixteen times. The benchmark sheet shouts its
  // declarations in capitals and hid the bug; the next office's will not.
  const key = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const byName = new Map((declared ?? []).map((d) => [key(d.name), d]));
  const members = interpretation.members.map((m) => {
    // Readings cached before the plausibility gate existed can carry a 1 mm
    // "width" read off the mark text "C1". Strip the impossible here so the
    // declaration can fill the blank — otherwise only a paid re-read heals it.
    const sane = (v: number | undefined): number | undefined =>
      typeof v === 'number' && v >= 30 && v <= 30000 ? v : undefined;
    const cleaned = { ...m, lengthMm: sane(m.lengthMm), widthMm: sane(m.widthMm), heightMm: sane(m.heightMm) };
    const hit = byName.get(key(m.mark));
    if (!hit || hit.dimsMm.length < 1) return cleaned;
    // "RCC WALL 200THK." is a one-dimension declaration: the THICKNESS. It
    // grounds the width — and the panel was asking the user for a number the
    // sheet states sixteen times because this required two dims.
    if (hit.dimsMm.length === 1) {
      const next1 = { ...cleaned };
      if (!(next1.widthMm && next1.widthMm > 0)) next1.widthMm = hit.dimsMm[0];
      next1.missing = next1.missing.filter((ax) => !(ax === 'W' && next1.widthMm));
      next1.incomplete = next1.missing.length > 0;
      return next1;
    }
    const [a, b, c] = hit.dimsMm;
    const next = { ...cleaned };
    if (!(next.lengthMm && next.lengthMm > 0)) next.lengthMm = Math.max(a, b);
    if (!(next.widthMm && next.widthMm > 0)) next.widthMm = Math.min(a, b);
    if (c !== undefined && !(next.heightMm && next.heightMm > 0)) next.heightMm = c;
    next.missing = next.missing.filter(
      (ax) =>
        !(
          (ax === 'L' && next.lengthMm) ||
          (ax === 'W' && next.widthMm) ||
          (ax === 'H' && next.heightMm)
        ),
    );
    next.incomplete = next.missing.length > 0;
    return next;
  });
  return { ...interpretation, members };
}

// ------------------------------------------------------------
// linear members — steel that runs the STRUCTURE, not the section
// ------------------------------------------------------------

/** bar stock arrives in 12 m lengths; a longer run laps */

/**
 * A tie beam, plinth beam or wall RUNS — its longitudinal steel is measured
 * along the structure, its stirrups are counted along the run. Scheduling one
 * as a counted object swallows its cross-section as its "length": the GAMCO
 * tie beam printed 0.25 m T16 longitudinals — 350 minus cover — as computed
 * rows, and a 100 m wall totalled 0.731 MT without one figure LOOKING wrong.
 */
/** the words that make a member a thing that RUNS rather than a thing that sits */
const LINEAR_WORDS = /\b(beam|wall|fence|parapet|drain)\b/i;

/**
 * Is a member with this mark (and declared type, when the sheet gives one) a
 * RUNNING structure — one whose extent is a length along which bars repeat?
 *
 * This is the ONE question that decides whether a run is a dimension of the
 * member at all. A beam, a wall, a fence, a parapet, a drain have a run; a
 * footing, a column, a pedestal, a slab panel, a stair flight do not — they
 * are counted, and each one's bars are cut from its own plan size. Every
 * caller that would ask for, apply, or compare against a TOTAL RUN must ask
 * this first, so that the question is only ever put for a member it can
 * answer for. See `isLinearMember` for the same test on a scheduled member.
 */
export function isLinearMark(mark: string, type = ''): boolean {
  if (type && LINEAR_WORDS.test(type)) return true;
  if (LINEAR_WORDS.test(mark)) return true;
  return /^(TB|PB|GB|LB|RB|BW|RW)\d{0,3}$/i.test(mark.trim());
}

export function isLinearMember(member: BbsMember): boolean {
  if (LINEAR_WORDS.test(member.type)) return true;
  // THE MARK IS THE ONLY PLACE THE WORD APPEARS ON THE ORCHESTRATED PATH.
  //
  // `type` was the only thing tested, and the orchestrated build names every
  // member `type: 'member'` — it has no type to give. So "RCC WALL" was not a
  // wall: its bars took the counted-object path, and a bar the drawing spaces
  // along the wall's run was measured across its 200 mm THICKNESS instead of
  // its height. That printed a 100 mm "wall bar", 501 of them, and the row
  // computed cleanly all the way to a weight.
  //
  // A declared member's mark IS its name on this kind of sheet — "RCC WALL",
  // "TIE BEAM", "BOUNDARY WALL" — so the same words are read from it.
  if (LINEAR_WORDS.test(member.mark)) return true;
  return /^(TB|PB|GB|LB|RB|BW|RW)\d{0,3}$/i.test(member.mark.trim());
}

/** the answered total run, in mm — from the interview's take-off facts */
export function runMmFromTakeoff(takeoff: Record<string, unknown> | undefined): number | null {
  if (!takeoff) return null;
  for (const [key, raw] of Object.entries(takeoff)) {
    if (!/run|length/i.test(key)) continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) continue;
    // an answer under 1000 is metres (nobody has a 999 mm boundary wall);
    // anything larger is already mm
    return v < 1000 ? v * 1000 : v;
  }
  return null;
}

/** member count from takeoff / project facts, e.g. p1_count = 20 */
export function countFromTakeoff(mark: string, takeoff: Record<string, unknown> | undefined): number | null {
  if (!takeoff) return null;
  const cleanMark = mark.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, raw] of Object.entries(takeoff)) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      k === `${cleanMark}count` ||
      k === `${cleanMark}qty` ||
      k === `${cleanMark}quantity` ||
      k === `${cleanMark}number` ||
      k === `${cleanMark}members`
    ) {
      let val: unknown = raw;
      if (typeof raw === 'object' && raw !== null) {
        if ('mm' in raw) val = (raw as { mm: unknown }).mm;
        else if ('value' in raw) val = (raw as { value: unknown }).value;
        else if ('count' in raw) val = (raw as { count: unknown }).count;
      }
      const num = Number(val);
      if (Number.isFinite(num) && num > 0) return num;
    }
  }
  return null;
}

export function buildBbs(
  extract: DrawingExtract,
  interpretation: BbsInterpretation,
  settings: BbsSettings = DEFAULT_SETTINGS,
  overrides?: BbsOverrides,
  takeoff?: Record<string, unknown>,
): BbsResult {
  const runMm = runMmFromTakeoff(takeoff);
  // Read once per build, not per row: a template writes the same declaration
  // down a whole column and re-reading the table for every bar would say the
  // same thing thirty times.
  const designInputs = designInputsFrom(extract);

  // ---- counts that follow from the run ----
  //
  // A typical-detail sheet draws one bay and states no count, so every member
  // arrives as 1 — and on a 100 m boundary wall that under-orders the steel by
  // roughly fifty times. The count is not unknowable, only un-writable on that
  // sheet: the drawing dimensions the pitch, the user gives the run, and the
  // two together are the count. The model recorded the rule (`countRule`); the
  // arithmetic happens here, where the run is finally known.
  //
  // Only applied where nothing better exists. A count read off plan tags or a
  // schedule column is evidence and outranks a derivation.
  const withCounts = interpretation.members.map((m) => {
    const takeoffCount = countFromTakeoff(m.mark, takeoff);
    if (takeoffCount !== null) {
      return { ...m, count: takeoffCount };
    }
    if (runMm !== null && m.countRule && m.countRule.pitchMm > 0 && m.count <= 1) {
      const { pitchMm, endsInclusive } = m.countRule;
      const n = Math.floor(runMm / pitchMm) + (endsInclusive ? 1 : 0);
      return n > 0 ? { ...m, count: n } : m;
    }
    return m;
  });
  const byMark = new Map(withCounts.map((m) => [m.mark, m]));
  const rows: BbsRow[] = [];
  const incomplete: { barMark: string; reason: string }[] = [];
  const used = new Set<string>();
  const coverTable = extract.notes.coverByMember ?? [];

  // EVERY ROW GOES THROUGH calculations/schedule.ts — geometry, cutting length,
  // quantity, weight — and comes back with its stage trace. Nothing here
  // computes a figure; this loop only prepares each bar's inputs (its member,
  // an entered length, a declared design input, a project count) and files
  // what the row could not do.
  for (const bar of interpretation.bars) {
    const barMark = assignMark(bar, used);
    const member = byMark.get(bar.memberMark);
    const dia = Number(bar.diaMm); // NUMERIC arrives as "8.00"

    if (!member) {
      incomplete.push({ barMark, reason: `member "${bar.memberMark}" is not in the schedule` });
      continue;
    }

    // A cutting length typed by the user replaces the derivation outright.
    // The person reading the drawing can see an upturn the schedule never
    // dimensioned; refusing their number in favour of our own would make the
    // engine's caution useless rather than careful. It is marked ENTERED so
    // the row never passes it off as something we worked out.
    const typedLen = overrides?.bars?.[barMark]?.cuttingLengthMm;
    // THE SHEET'S OWN REFUSAL OUTRANKS ANY DERIVATION. A schedule block that
    // writes "CUTTING LENGTH — INPUT" against this bar has already settled the
    // question: the figure is a design decision the drawing does not carry.
    const declaredInput =
      typedLen === undefined
        ? cuttingLengthInputFor(designInputs, { mark: barMark, memberMark: bar.memberMark, diaMm: dia })
        : null;

    const scheduled = scheduleRow({
      bar,
      member,
      settings,
      runMm,
      enteredCuttingLengthMm: typeof typedLen === 'number' && Number.isFinite(typedLen) && typedLen > 0 ? typedLen : undefined,
      declaredInput: declaredInput ? { where: declaredInput.where, saidAs: declaredInput.saidAs } : null,
      takeoffCount: countFromTakeoff(member.mark, takeoff),
      coverTable,
      barMark,
      description: describeBar(bar, member),
    });
    rows.push(scheduled.row);
    incomplete.push(...scheduled.incomplete);
  }

  // Grouped by diameter only, from the rows that computed — and reconciled
  // against them before anything is returned.
  const summary = buildSteelSummary(rows, settings.wastagePct);
  const reconciliation = reconcileSchedule(rows, summary);
  // CALCULATED IS NOT VALIDATED. The rows above reached (or did not reach) a
  // weight; this says which of them can be relied on, and why the schedule
  // as a whole is or is not FINAL.
  const validation = validateSchedule(rows, { reconciliationOk: reconciliation.ok });

  // ---- the output sanity gate ----
  // Nobody owned the plausibility of the TOTAL: every input had a gate, and a
  // 100 m boundary wall still totalled 0.731 MT without one figure looking
  // wrong, because each row was locally defensible. A QS's last act is this
  // exact ratio — steel per running metre — and a schedule that skips it isn't
  // finished, it's unchecked.
  const sanity: string[] = [];
  if (runMm !== null && runMm > 0) {
    const totalKg = summary.reduce((a, s) => a + s.totalWeightWithWastageKg, 0);
    const kgPerM = totalKg / (runMm / 1000);
    if (kgPerM < 20) {
      sanity.push(
        `SANITY: ${totalKg.toFixed(0)} kg over a ${(runMm / 1000).toFixed(0)} m run is ` +
          `${kgPerM.toFixed(1)} kg/m. A reinforced boundary wall of this kind carries roughly ` +
          '40–120 kg per metre — steel is MISSING from this schedule (unscaled counts, an ' +
          'unmodelled wall, or unanswered questions), not cheap.',
      );
    } else if (kgPerM > 200) {
      sanity.push(
        `SANITY: ${kgPerM.toFixed(0)} kg per metre of run is far above the usual 40–120 kg/m — ` +
          'check for a double-counted run or a mis-read diameter before anyone prices this.',
      );
    }
  }
  const scope = takeoff
    ? Object.entries(takeoff).find(([k]) => /scope/i.test(k))?.[1]
    : undefined;
  if (typeof scope === 'string' && /typical/i.test(scope)) {
    sanity.push(
      'SANITY: you answered that the layout is ONE TYPICAL STRETCH, but member counts are ' +
        'still the as-drawn tag counts — they have not been scaled across the total run. ' +
        'The counted members below are one stretch, not the job.',
    );
  }

  const drawingHash =
    extract.hash ?? (typeof extract.drawingName === 'string' ? extract.drawingName : 'drawing-hash');
  // THE DEPENDENCY MAP, PER ROW, BY FACT ID. Each row's trace names the facts
  // its figures rest on — "F8.length", "F8.count", "settings.cover",
  // "wall.total_run" — so that when one of them changes, exactly the rows that
  // read it are marked STALE and rebuilt. The ledger sequence numbers are
  // stamped in by the caller that holds the ledger (studio/realData.ts);
  // here every fact is version 1 of this build.
  const factIds: string[] = [];
  const factVersions: Record<string, number> = {};
  const noteFact = (id: string): void => {
    if (!factIds.includes(id)) factIds.push(id);
    factVersions[id] = 1;
  };
  if (takeoff) for (const k of Object.keys(takeoff)) noteFact(k);
  const rowDeps = rows.map((r) => {
    const own = r.trace?.factsUsed ?? [];
    for (const id of own) noteFact(id);
    return {
      rowId: `${r.memberMark}:${r.barMark}`,
      factIds: [...own, ...(takeoff ? Object.keys(takeoff) : [])],
      drawingHash,
    };
  });

  const manifest: BBSBuildManifest = {
    buildId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `build-${Date.now()}`,
    builtAt: Date.now(),
    drawingHash,
    factIds: Array.from(new Set(factIds)),
    factVersions,
    rowDeps,
    status: incomplete.length === 0 ? 'FINAL' : 'VALIDATED',
  };

  return {
    settings,
    // the derived counts, not the raw ones — the Member dimensions table shows
    // what the schedule was actually built from, or the two disagree on screen
    members: withCounts,
    rows,
    summary,
    reconciliation,
    validation,
    incomplete,
    interpretation,
    sanity,
    manifest,
  };
}
