// ============================================================
// References — how a number gets from the drawing into the schedule.
//
// THE CLOSED SET. Exactly three forms are permitted, and the parser REJECTS
// anything else by name rather than ignoring it:
//
//   scalar          one number, in one place
//   difference      |a − b| where both sides are scalars — two LEVELS
//   dimension-path  a chain of real dimensions the engine walks and sums
//
// There is deliberately no general expression language. `sum` over arbitrary
// operands, nesting, constants and multipliers would each be one small step,
// and together they are the invention this architecture exists to prevent: a
// model that can write `a*2 + 150` can write any number it likes and dress it
// as provenance.
//
// WHY dimension-path EXISTS AT ALL
//
// A height on a section is frequently not a dimension and not a difference of
// two levels. The benchmark sheet carries NO numeric levels — "F.G.L." and
// "E.G.L." are names — and no single dimension spans a column. The height is
// a chain: 1500 + 900 + 300, three separate dimensions drawn end to end.
//
// A chain is safe to sum ONLY because the engine can check it is a chain: each
// segment is a real dimension node, all on one axis, each endpoint touching
// the next, no segment used twice, and every segment drawn at one scale. That
// is verification, not arithmetic-by-model. A model that lists three unrelated
// dimensions gets a rejection naming which link failed, not a number — and
// when the links leave a hole, the dimensions lying inside it are named.
//
// The anchors are PROVENANCE and optional: they say what the span runs
// between, and the segments' own geometry is what proves it. Requiring them as
// ids cost one live run every column height it had otherwise measured
// correctly, on two label fields that contribute no arithmetic.
//
// EVERY FAILURE IS TOTAL AND NAMED. A reference that half-resolves is dropped
// whole and reported with the side that failed. Half a height is worse than no
// height: it looks like an answer.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';

export type ScalarRef =
  | { kind: 'entity-number'; evidenceId: string; part: number }
  | { kind: 'table-number'; tableId: string; row: number; column: number; part: number }
  | { kind: 'user-fact'; factId: string };

export interface DifferenceRef {
  kind: 'difference';
  a: ScalarRef;
  b: ScalarRef;
}

export interface DimensionPathRef {
  kind: 'dimension-path';
  axis: 'x' | 'y';
  /**
   * Evidence ids naming the two ends of the span — PROVENANCE, and optional.
   * The segments' own geometry proves the chain; these only say what it runs
   * between. Named in words rather than ids, they are recorded as a note.
   */
  fromAnchor?: string;
  toAnchor?: string;
  /** the dimensions to walk, in any order; the engine sorts and checks them */
  segmentEvidenceIds: string[];
}

export type DimRef = ScalarRef | DifferenceRef | DimensionPathRef;

export interface Resolution {
  ok: boolean;
  /** millimetres, when ok */
  mm?: number;
  /** every evidence id the value depends on — the provenance trail */
  evidenceIds: string[];
  /** why it failed, naming the exact link — shown to the model and the user */
  reason?: string;
  /** how it was arrived at, for the working column */
  working?: string;
}

const fail = (reason: string, evidenceIds: string[] = []): Resolution => ({
  ok: false,
  evidenceIds,
  reason,
});

/** endpoints closer than this are the same point */
const JOIN_TOL_MM = 2;

// ------------------------------------------------------------
// units
// ------------------------------------------------------------

/**
 * One detector, used everywhere a written number becomes millimetres.
 *
 * Levels are conventionally written in metres — "+0.300", "−1.500" — while
 * dimensions are millimetres. Deciding per call site is how two call sites end
 * up disagreeing by a factor of a thousand, so this is the only place that
 * decides.
 *
 * The rule is deliberately narrow: a decimal point AND a magnitude below the
 * smallest believable millimetre dimension. "1500" is mm. "1.500" is metres.
 * "1500.0" is mm, because 1500 m is not a member. Anything ambiguous stays as
 * written, because guessing is what this file exists to avoid.
 */
export function toMillimetres(value: number, rawText?: string): number {
  const written = rawText?.trim() ?? String(value);
  const looksDecimal = /\d\.\d/.test(written);
  if (looksDecimal && Math.abs(value) < 30) return value * 1000;
  return value;
}

// ------------------------------------------------------------
// scalar
// ------------------------------------------------------------

/**
 * Where a fact on the project record came from — carried WITH the value so
 * nothing downstream has to guess. A schedule-table cell the sheet prints and
 * a number a person typed both reach the engine through the same record; the
 * first must never be described as "you told us", and the second must never
 * be described as a reading.
 */
export type EngineFactSource = 'DRAWING_READ' | 'USER_INPUT' | 'DERIVED' | 'ASSUMED';

/** One fact as the engine sees it: a millimetre value with its provenance. */
export interface EngineFact {
  mm: number;
  /** the words it was given in, when a person gave it */
  saidAs?: string;
  /** provenance — absent means the caller did not say, and it is treated as supplied */
  source?: EngineFactSource;
  /** the text on the sheet it was read from ("FOOTING SCHEDULE : row F8, DEPTH D: 575") */
  sourceText?: string;
  /** the ledger id it came from ("F8.height"), when it came from a ledger */
  factId?: string;
}

/** How a fact is described in a working line, according to where it came from. */
export function describeEngineFact(fact: EngineFact): string {
  const said = fact.saidAs ? ` ("${fact.saidAs}")` : '';
  switch (fact.source) {
    case 'DRAWING_READ':
      return `${fact.mm} mm — read from the drawing${fact.sourceText ? ` (${fact.sourceText})` : said}`;
    case 'DERIVED':
      return `${fact.mm} mm — derived${fact.sourceText ? ` (${fact.sourceText})` : said}`;
    case 'ASSUMED':
      return `${fact.mm} mm — ASSUMED${fact.sourceText ? ` (${fact.sourceText})` : said}`;
    default:
      return `${fact.mm} mm — you told us${said}`;
  }
}

export interface ResolveContext {
  graph: EvidenceGraph;
  /** reconstructed schedule tables, when the sheet has any */
  tables?: readonly { title: string; rows: string[][] }[];
  /** facts on the project record, in millimetres unless the id says otherwise, each with its provenance */
  userFacts?: Readonly<Record<string, EngineFact>>;
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function resolveScalar(ref: ScalarRef, ctx: ResolveContext): Resolution {
  // Reached not only through resolveRef's checked entry but from inside
  // `difference` sides and placement pitchRefs — model-shaped objects that may
  // be absent or a bare number. Run 014's crash class is exactly this seam, so
  // the guard is here, at the one place every scalar passes through.
  if (!ref || typeof ref !== 'object' || typeof (ref as { kind?: unknown }).kind !== 'string') {
    return fail(
      'this is not a scalar reference — it must be an object whose "kind" is one of ' +
        'entity-number, table-number, user-fact (a bare number is not a reference)',
    );
  }
  if (ref.kind === 'user-fact') {
    const hit = ctx.userFacts?.[ref.factId];
    if (!hit) return fail(`user fact "${ref.factId}" is not on the record`);
    return {
      ok: true,
      mm: hit.mm,
      evidenceIds: [`FACT-${ref.factId}`],
      working: describeEngineFact(hit),
    };
  }

  if (ref.kind === 'table-number') {
    const table = ctx.tables?.find((t) => t.title === ref.tableId);
    if (!table) return fail(`no table "${ref.tableId}" on this sheet`);
    const cell = table.rows[ref.row]?.[ref.column];
    if (cell === undefined) {
      return fail(`"${ref.tableId}" has no cell at row ${ref.row} column ${ref.column}`);
    }
    const parts = numbersIn(cell);
    const v = parts[ref.part - 1];
    if (v === undefined) {
      return fail(
        `"${ref.tableId}" row ${ref.row} column ${ref.column} reads ${JSON.stringify(cell)}, ` +
          `which has no number ${ref.part}`,
      );
    }
    return {
      ok: true,
      mm: toMillimetres(v, cell),
      evidenceIds: [],
      working: `${v} — ${ref.tableId} row ${ref.row} col ${ref.column}`,
    };
  }

  const node = ctx.graph.byId.get(ref.evidenceId);
  if (!node) return fail(`no evidence "${ref.evidenceId}" on this sheet`);
  const parts = node.valueParts ?? (node.rawText ? numbersIn(node.rawText) : []);
  const v = parts[ref.part - 1];
  if (v === undefined) {
    return fail(
      `${ref.evidenceId} reads ${JSON.stringify(node.rawText ?? '')}, which has no number ${ref.part}`,
      [ref.evidenceId],
    );
  }
  return {
    ok: true,
    mm: toMillimetres(v, node.rawText),
    evidenceIds: [ref.evidenceId],
    working: `${v} — ${ref.evidenceId}${node.rawText ? ` "${node.rawText}"` : ''}`,
  };
}

// ------------------------------------------------------------
// difference
// ------------------------------------------------------------

export function resolveDifference(ref: DifferenceRef, ctx: ResolveContext): Resolution {
  // a missing side is refused by name, never dereferenced
  if (!ref.a || !ref.b) {
    return fail(
      `difference: ${!ref.a ? '"a"' : '"b"'} is missing — a difference needs two scalar sides, ` +
        '{"kind":"difference","a":{…},"b":{…}}',
    );
  }
  const a = resolveScalar(ref.a, ctx);
  const b = resolveScalar(ref.b, ctx);
  // Named, per side. "The difference failed" sends someone hunting both ends.
  if (!a.ok) return fail(`difference: side a failed — ${a.reason}`, a.evidenceIds);
  if (!b.ok) return fail(`difference: side b failed — ${b.reason}`, b.evidenceIds);
  const mm = Math.abs((a.mm ?? 0) - (b.mm ?? 0));
  if (!(mm > 0)) {
    return fail('difference: both sides resolved to the same level, so the span is zero', [
      ...a.evidenceIds,
      ...b.evidenceIds,
    ]);
  }
  return {
    ok: true,
    mm,
    evidenceIds: [...a.evidenceIds, ...b.evidenceIds],
    working: `|${a.mm} − ${b.mm}| = ${mm} mm`,
  };
}

// ------------------------------------------------------------
// dimension path
// ------------------------------------------------------------

/**
 * Walk a chain of dimensions and sum it — but only after proving it IS a chain.
 *
 * Every check below has a failure the model can act on, and none of them can
 * be satisfied by a number: the model chose which dimensions, the geometry
 * decides whether they connect.
 */
export function resolveDimensionPath(ref: DimensionPathRef, ctx: ResolveContext): Resolution {
  // a non-array here (a number, a lone string) would be iterated below —
  // refused by name instead, the same rule as everywhere on this boundary
  if (ref.segmentEvidenceIds !== undefined && !Array.isArray(ref.segmentEvidenceIds)) {
    return fail(
      'dimension-path: "segmentEvidenceIds" must be an array of dimension evidence ids, ' +
        `and what arrived was not an array`,
    );
  }
  const ids = ref.segmentEvidenceIds ?? [];
  if (ids.length === 0) return fail('dimension-path: no segments given');

  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return fail(`dimension-path: ${id} is listed twice — a segment cannot be counted twice`, ids);
    }
    seen.add(id);
  }

  const segs: import('./evidence').DimensionEvidence[] = [];
  for (const id of ids) {
    const node = ctx.graph.byId.get(id);
    if (!node) return fail(`dimension-path: no evidence "${id}" on this sheet`, ids);
    if (node.kind !== 'dimension') {
      return fail(
        `dimension-path: ${id} is ${node.kind}, not a dimension — only real dimensions can be summed`,
        ids,
      );
    }
    const dim = ctx.graph.dimensions.find((d) => d.id === id);
    if (!dim) return fail(`dimension-path: ${id} carries no measurable span`, ids);
    if (dim.axis !== ref.axis) {
      return fail(
        `dimension-path: ${id} measures along ${dim.axis ?? 'no clear axis'}, not ${ref.axis}`,
        ids,
      );
    }
    segs.push(dim);
  }

  // Order the segments along the axis, then require each to continue the last.
  //
  // CONTIGUITY IS MEASURED ALONG THE AXIS ONLY. A vertical chain's segments
  // routinely differ by tens of millimetres perpendicular, because their
  // extension lines touch different faces of the thing being dimensioned —
  // on the benchmark sheet the 1500 ends at x=10249193 and the 900 it plainly
  // continues starts at x=10249143. Judging that 50 mm offset as a broken
  // chain rejects the very drawings this exists to read. Whether the segments
  // belong together is the model's call, backed by the anchors; whether they
  // SPAN CONTIGUOUSLY is geometry's, and geometry only cares about the axis.
  const key = ref.axis === 'x' ? 'x' : 'y';
  const lo = (d: (typeof segs)[number]): number => Math.min(d.from[key], d.to[key]);
  const hi = (d: (typeof segs)[number]): number => Math.max(d.from[key], d.to[key]);
  const ordered = [...segs].sort((p, q) => lo(p) - lo(q));

  // A printed value and a geometric span can differ by a fixed dimension-style
  // scale — this sheet draws at twice its annotation. That is fine while every
  // segment shares the factor, and unsafe the moment they do not: summing a
  // 1:1 and a 1:2 dimension produces a number with no meaning. Consistency is
  // checkable precisely because both halves are on hand.
  const ratios = ordered.map((d) => {
    const span = hi(d) - lo(d);
    return span > 0 ? d.valueMm / span : null;
  });
  const known = ratios.filter((r): r is number => r !== null);
  if (known.length > 1) {
    const min = Math.min(...known);
    const max = Math.max(...known);
    if (max - min > min * 0.02) {
      const worst = ordered[ratios.indexOf(max)];
      return fail(
        `dimension-path: the segments are drawn at different scales — ${worst.id} prints ` +
          `${worst.valueMm} over a span of ${Math.round(hi(worst) - lo(worst))}, which does not ` +
          'match its neighbours. Summing dimensions of different scales produces a meaningless ' +
          'total, so the path was refused.',
        ids,
      );
    }
  }

  let cursor = lo(ordered[0]);
  let total = 0;
  const trail: string[] = [];
  for (const d of ordered) {
    const gap = Math.abs(lo(d) - cursor);
    if (gap > JOIN_TOL_MM) {
      // NAME WHAT SITS IN THE HOLE.
      //
      // "the chain does not span continuously" is true and leaves the caller
      // nowhere to go: one live run re-sent the same broken chain three times.
      // The engine has just measured the hole, and the graph knows which
      // dimensions lie inside it on this axis — saying so is reporting
      // geometry, not choosing a height. WHICH of them belongs in the chain
      // remains entirely the caller's judgement, and a wrong pick still fails
      // this same walk.
      const holeLo = Math.min(cursor, lo(d));
      const holeHi = Math.max(cursor, lo(d));
      const inGap = lo(d) > cursor
        ? ctx.graph.dimensions
            .filter((cand) => cand.axis === ref.axis && !seen.has(cand.id))
            .filter((cand) => {
              const cLo = Math.min(cand.from[key], cand.to[key]);
              const cHi = Math.max(cand.from[key], cand.to[key]);
              return cLo >= holeLo - JOIN_TOL_MM && cHi <= holeHi + JOIN_TOL_MM;
            })
            .slice(0, 8)
        : [];
      return fail(
        `dimension-path: ${d.id} ${lo(d) < cursor ? 'overlaps the previous segment by' : 'starts'} ` +
          `${Math.round(gap)} mm ${lo(d) < cursor ? '' : 'past where the previous segment ended'} — ` +
          'the chain does not span continuously, so the sum would measure a gap or count twice' +
          (inGap.length
            ? `. Dimension(s) lying in that ${Math.round(gap)} mm gap on the same axis: ` +
              `${inGap.map((c) => `${c.id} (${c.valueMm})`).join(', ')} — include the one(s) that belong, if any do.`
            : lo(d) > cursor
              ? `. Nothing on this axis was found inside that gap, so the span may not be a chain of drawn dimensions at all.`
              : ''),
        ids,
      );
    }
    total += d.valueMm;
    trail.push(`${d.id} ${d.valueMm}`);
    cursor = hi(d);
  }

  // The anchors are PROVENANCE, and they are optional.
  //
  // They were required, and only ever existence-checked: nothing here verifies
  // that they geometrically bound the chain, because the walk above already
  // proved the segments join end to end and their own endpoints ARE the span.
  // So a caller who names them in prose — "footing base", "top of column
  // (+300 LVL)" — was losing an otherwise fully verified 1500 + 900 + 300 to
  // two label fields that contribute no arithmetic. One live run lost every
  // column height that way, having chosen exactly the right segments.
  //
  // Given as ids, they are still checked and still recorded; given as anything
  // else, the chain stands on its own geometry and the labels are reported
  // rather than fatal.
  const anchors = [ref.fromAnchor, ref.toAnchor].filter((a): a is string => typeof a === 'string' && a.length > 0);
  const realAnchors = anchors.filter((a) => ctx.graph.byId.has(a));
  const prose = anchors.filter((a) => !ctx.graph.byId.has(a));

  return {
    ok: true,
    mm: total,
    evidenceIds: [...ids, ...realAnchors],
    working:
      `${trail.join(' + ')} = ${total} mm (chain verified end to end on ${ref.axis})` +
      (prose.length
        ? ` — anchor${prose.length > 1 ? 's' : ''} ${prose.map((p) => JSON.stringify(p)).join(' and ')} ` +
          'named in words, not as evidence ids, so recorded as a note rather than provenance; ' +
          'the sum rests on the segments, which do join.'
        : ''),
  };
}

// ------------------------------------------------------------
// the one entry point
// ------------------------------------------------------------

const SCALAR_KINDS = new Set(['entity-number', 'table-number', 'user-fact']);

/**
 * Resolve any permitted reference, and reject every unpermitted one BY NAME.
 *
 * The rejection matters as much as the resolution: a model that reaches for
 * `{op:'sum'}` must be told that operator does not exist, not silently handed
 * a blank field it will then try to fill another way.
 */
export function resolveRef(ref: unknown, ctx: ResolveContext): Resolution {
  if (!ref || typeof ref !== 'object') return fail('no reference given');
  const kind = (ref as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return fail('reference has no "kind" — it must be one of entity-number, table-number, user-fact, difference, dimension-path');
  }
  if (SCALAR_KINDS.has(kind)) return resolveScalar(ref as ScalarRef, ctx);
  if (kind === 'difference') return resolveDifference(ref as DifferenceRef, ctx);
  if (kind === 'dimension-path') return resolveDimensionPath(ref as DimensionPathRef, ctx);
  return fail(
    `"${kind}" is not a permitted reference. Only entity-number, table-number, user-fact, ` +
      'difference and dimension-path exist — there is no general arithmetic.',
  );
}

/** Is this shape a reference at all? Used by the stripper's whitelist. */
export function looksLikeRef(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  return (
    typeof kind === 'string' &&
    (SCALAR_KINDS.has(kind) || kind === 'difference' || kind === 'dimension-path')
  );
}

export type { EvidenceGraph, EvidenceNode };
