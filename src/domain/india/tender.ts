// ============================================================
// Reading a tender Bill of Quantities — the runtime half of the
// `boq-tender` skill.
//
// The skill file is development-time and is not bundled, so what a request or
// a comparison needs lives here, versioned beside the code — the same choice
// `billing.ts` and `BBS_SYSTEM_PROMPT` make.
//
// THE NUMBER THAT SHAPES THIS FILE
//
// A real issued tender (Oriental Nagpur, electrical works) has 597 rows and
// **70 of them carry a quantity**. Under 12%. The rest is scope, exclusions,
// specification and headings. So the first job of any BOQ reader is not to
// extract items — it is to work out which rows ARE items, and to be honest
// that a drawing take-off can only ever address part of them.
// ============================================================

export type BoqRowKind =
  | 'title'
  | 'preamble'
  | 'section'
  | 'item'
  | 'subitem'
  | 'rate-only'
  | 'blank';

export interface TenderRow {
  /** 1-based row in the source sheet, so a finding can be pointed at */
  row: number;
  /** the Sr. No. cell, verbatim: "1.2", "a)", "iii)", "H" */
  ref: string;
  description: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  kind: BoqRowKind;
  /** the numbered item this sub-item belongs under */
  parentRef?: string;
  /** why it was classified rate-only, when it was */
  rateOnlyReason?: string;
}

// ------------------------------------------------------------
// units
// ------------------------------------------------------------

/**
 * One tender, four spellings, two units.
 *
 * `RM` (18 rows) and `Mtrs.` (25 rows) are both running metres; `Nos`, `Nos.`
 * and `No.` are all counts. Comparing unit strings directly would split a
 * cable item in half for no reason, so nothing compares units without coming
 * through here first.
 */
const UNIT_ALIASES: Record<string, string> = {
  rm: 'rmt',
  rmt: 'rmt',
  'r.m': 'rmt',
  mtr: 'rmt',
  mtrs: 'rmt',
  m: 'rmt',
  metre: 'rmt',
  meters: 'rmt',
  no: 'nos',
  nos: 'nos',
  number: 'nos',
  each: 'nos',
  set: 'set',
  sets: 'set',
  pair: 'pair',
  sqm: 'sqm',
  'sq.m': 'sqm',
  sqmt: 'sqm',
  cum: 'cum',
  'cu.m': 'cum',
  kg: 'kg',
  mt: 'mt',
  ls: 'ls',
  'l.s': 'ls',
  lot: 'ls',
};

export function normaliseUnit(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/[\s.]+$/g, '').replace(/\.$/, '');
  return UNIT_ALIASES[k] ?? UNIT_ALIASES[k.replace(/\./g, '')] ?? k;
}

// ------------------------------------------------------------
// rate-only and friends
// ------------------------------------------------------------

/** these mean rate-only whatever else the row carries */
const EXPLICIT: { re: RegExp; reason: string }[] = [
  { re: /\brate\s*only\b|\(\s*R\.?O\.?\s*\)/i, reason: 'rate-only — quantity is measured on site' },
  { re: /\bprovisional\s*(sum|item|quantity)\b/i, reason: 'provisional sum — a budget allowance, adjusted against actuals' },
  { re: /\bday\s*work\b/i, reason: 'day work — priced per hour for instructed work' },
  { re: /\bcontingenc(y|ies)\b/i, reason: 'contingency allowance' },
];

/**
 * These mean rate-only ONLY when the row carries no quantity.
 *
 * Tested against a real tender and this distinction is the whole game.
 * "as required" appears in the SCOPE wording of ordinary measured items —
 *
 *   "…stay set with turn buckles 7/2 MM GI stranded wire, stay insulators,
 *    complete as required including…"          1 set, priced normally
 *
 * — and also as the entire quantity of a genuine rate-only line:
 *
 *   "Panel General Accessories as required"     no quantity at all
 *
 * Treating the first as rate-only excluded three properly measured items from
 * the bill. A phrase inside a specification is not a contract term.
 */
const CONDITIONAL: { re: RegExp; reason: string }[] = [
  { re: /\bas\s+required\b/i, reason: '"as required" with no quantity — scope is open, priced to a requirement' },
  { re: /\bif\s+required\b|\bwherever\s+required\b/i, reason: 'conditional scope — quantity unknown at tender' },
  { re: /\bas\s+per\s+site\s+(condition|requirement)/i, reason: 'site-dependent scope' },
];

/**
 * Is this a line whose quantity is unknowable at tender?
 *
 * These must never be measured against, and never reported as "missing from
 * the drawing" — they are missing by design. Flagging a correctly-working
 * contract term as a defect is how a review list becomes unread.
 */
export function rateOnlyReason(description: string, quantity?: number): string | null {
  for (const p of EXPLICIT) {
    if (p.re.test(description)) return p.reason;
  }
  const hasQuantity = typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0;
  if (hasQuantity) return null;
  for (const p of CONDITIONAL) {
    if (p.re.test(description)) return p.reason;
  }
  return null;
}

// ------------------------------------------------------------
// classification
// ------------------------------------------------------------

const ITEM_REF = /^\d+(\.\d+)*$/;
const ALPHA_SUB = /^[a-z]\)$/i;
const ROMAN_SUB = /^[ivxlc]+\)$/i;
const PREAMBLE_REF = /^[A-Z]$/;

/**
 * Classify one row of a tender BOQ.
 *
 * The parent numbered row usually carries the SPECIFICATION and no quantity;
 * its lettered children carry the sizes and the numbers. A reader that keeps
 * only rows with quantities throws away the specification those quantities
 * belong to, which is how "3 x 240 Sq.mm. Cable — 1500 RM" loses the fact that
 * it is 22 kV XLPE armoured.
 */
export function classifyRow(
  ref: string,
  description: string,
  quantity?: number,
  unit?: string,
): BoqRowKind {
  const r = ref.trim();
  const d = description.trim();
  if (!d && quantity === undefined) return 'blank';
  if (PREAMBLE_REF.test(r)) return 'preamble';

  if (quantity !== undefined && unit) {
    // a measured row can still be explicitly rate-only, but "as required" in
    // its scope wording does not make it so — see rateOnlyReason
    if (rateOnlyReason(d, quantity)) return 'rate-only';
    return ALPHA_SUB.test(r) || ROMAN_SUB.test(r) ? 'subitem' : 'item';
  }

  // A NUMBERED row with no quantity is the parent carrying the specification;
  // its a)/b) children hold the sizes and the numbers. Classifying it
  // rate-only because its scope says "complete as required" removed three
  // properly measured cable items from the bill — the skill documents this
  // shape and the code has to honour it before reaching for rate-only.
  if (ITEM_REF.test(r)) return 'section';
  if (rateOnlyReason(d, quantity)) return 'rate-only';
  if (ALPHA_SUB.test(r) || ROMAN_SUB.test(r)) return 'subitem';
  return 'preamble';
}

// ------------------------------------------------------------
// what a drawing can answer
// ------------------------------------------------------------

export type Measurability = 'countable' | 'linear' | 'specification' | 'unknown';

const NOT_FROM_DRAWINGS =
  /termination|lug|gland|jointing\s*kit|danger\s*plate|testing|commissioning|documentation|painting\s*of\s*conduit|earth\s*pit\s*chamber\s*cover|label/i;

const COUNTABLE =
  /panel|\bDB\b|distribution\s*board|transformer|\bDG\b|\bRMU\b|\bACB\b|\bMCCB\b|\bMCB\b|switch|socket|fitting|luminaire|fan\b|\bCT\b|meter|isolator|feeder\s*pillar/i;

const LINEAR = /cable|conductor|\bwire\b|strip|conduit|tray|trunking|busduct|rising\s*main|pipe/i;

/**
 * Can a drawing take-off supply this line at all?
 *
 * Answering honestly is more useful than answering optimistically: an item
 * marked `specification` is not a gap in the drawings and should never appear
 * in a "missing" list.
 */
export function measurability(description: string): Measurability {
  if (NOT_FROM_DRAWINGS.test(description)) return 'specification';
  if (LINEAR.test(description)) return 'linear';
  if (COUNTABLE.test(description)) return 'countable';
  return 'unknown';
}

/**
 * Strip the SITC boilerplate so two descriptions can be compared on substance.
 *
 * "Supplying, installing, testing & commissioning of" opens nearly every item
 * in an Indian tender — preamble clause B usually makes it the default for the
 * whole bill. Matching on it matches everything.
 */
export function itemSubstance(description: string): string {
  return description
    .replace(
      /^\s*(supply(ing)?|providing|design(ing)?|manufactur(e|ing)|fabricat(e|ing))[^:]*?\bof\b\s*/i,
      '',
    )
    .replace(/\b(complete\s+with|including|inclusive\s+of|as\s+per|conforming\s+to)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TenderSummary {
  rows: number;
  measurable: number;
  rateOnly: number;
  preamble: number;
  /** normalised unit → how many measurable rows use it */
  units: Record<string, number>;
}

export function summarise(rows: readonly TenderRow[]): TenderSummary {
  const units: Record<string, number> = {};
  let measurable = 0;
  let rateOnly = 0;
  let preamble = 0;
  for (const r of rows) {
    if (r.kind === 'rate-only') rateOnly += 1;
    else if (r.kind === 'preamble' || r.kind === 'title') preamble += 1;
    else if ((r.kind === 'item' || r.kind === 'subitem') && r.unit && r.quantity !== undefined) {
      measurable += 1;
      const u = normaliseUnit(r.unit);
      units[u] = (units[u] ?? 0) + 1;
    }
  }
  return { rows: rows.length, measurable, rateOnly, preamble, units };
}
