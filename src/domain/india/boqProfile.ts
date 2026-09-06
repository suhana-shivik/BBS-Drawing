// ============================================================
// How THIS client writes a bill.
//
// WHY A PROFILE, RATHER THAN ONE HOUSE STYLE
//
// The `boq-tender` skill describes what Indian tender BOQs have in common.
// What it cannot describe is the part that differs per client and matters most
// to whether output is accepted: which sections they use and in what order,
// how they open an item, which spelling of running-metre they write, how many
// preamble clauses they carry, and whether they bill a cable termination as
// its own line or fold it into the cable.
//
// One real tender used FOUR spellings for two units inside a single issued
// document. There is no correct answer to standardise on — only *their*
// answer. So the system learns a profile per client from bills they have
// already issued, and writes future ones in that shape.
//
// WHAT IS LEARNED AND WHAT IS NOT
//
// Everything here is extracted DETERMINISTICALLY from a bill they wrote:
// counts, orders, spellings, phrasings. No model is involved in building a
// profile, so a profile cannot hallucinate a convention the client does not
// have. A model may later be given the profile to write in that voice — but
// the voice itself is measured.
//
// Nothing here carries a quantity. A profile is about FORM.
// ============================================================
import { classifyRow, normaliseUnit, type TenderRow } from './tender';

export interface BoqProfile {
  /** the client this belongs to — free text, matched case-insensitively */
  client: string;
  /** where it was learned from, so a convention can be defended */
  learnedFrom: string[];
  at: number;

  /** section headings in the order the client uses them */
  sections: string[];
  /** the numbering shapes seen: "1.2", "a)", "iii)" */
  numbering: { items: string; subItems: string[] };
  /** unit spellings this client writes, normalised form → their spelling */
  unitSpelling: Record<string, string>;
  /** how items open — "Supplying, installing, testing & commissioning of" */
  itemOpenings: string[];
  /** preamble clauses, carried verbatim into new bills for this client */
  preamble: string[];
  /**
   * Companion items this client bills SEPARATELY.
   *
   * The difference between a bill they accept and one they query: Oriental
   * bills cable terminations as their own line (8 Sets against 4 runs), while
   * another client folds them into the cable rate. Deriving a line they do not
   * bill is as wrong as omitting one they do.
   */
  separateCompanions: string[];
  /** rounding seen between measured and billed quantity, as a fraction */
  roundingUp?: number;
}

const OPENING =
  /^\s*((?:supply|supplying|providing|provision|design|designing|manufacture|manufacturing|fabricating|installing|installation|testing|commissioning|laying|making|erection)[^.:]{0,120}?\bof\b)/i;

/**
 * Does this cell plausibly hold a unit?
 *
 * Units are short and wordless: "RM", "Nos", "Sets", "Sq.m", "Pair". Anything
 * with a sentence in it is a description that has slid a column.
 */
function isUnitLike(raw: string): boolean {
  const u = raw.trim();
  if (!u || u.length > 12) return false;
  if (/\s{2,}|[.!?]\s|\b(the|and|shall|of|for|with|as|is)\b/i.test(u)) return false;
  return /^[A-Za-z][A-Za-z0-9.\/\s%²]*$/.test(u);
}

const COMPANION_WORDS = [
  'termination',
  'gland',
  'lug',
  'jointing kit',
  'danger plate',
  'earth pit',
  'base channel',
  'chicken mesh',
];

/**
 * Read a client's conventions off a bill they issued.
 *
 * Takes rows already classified by `tender.ts`. Everything returned was
 * counted in the document — a profile states what the client does, never what
 * they ought to do.
 */
export function learnProfile(
  client: string,
  source: string,
  rows: readonly TenderRow[],
): BoqProfile {
  const sections: string[] = [];
  const subShapes = new Set<string>();
  const unitSpelling: Record<string, string> = {};
  const openings = new Map<string, number>();
  const preamble: string[] = [];
  const companions = new Set<string>();
  let itemShape = '';

  for (const r of rows) {
    const ref = r.ref.trim();
    const desc = r.description.trim();

    if (r.kind === 'preamble' && desc.length > 30) preamble.push(desc);

    if (r.kind === 'section' && desc) {
      // a section heading is a numbered parent carrying wording, no quantity
      if (!sections.includes(desc) && desc.length < 140) sections.push(desc);
    }

    if (/^\d+(\.\d+)*$/.test(ref)) itemShape = ref.includes('.') ? '1.2' : '1';
    else if (/^[a-z]\)$/i.test(ref)) subShapes.add('a)');
    else if (/^[ivxlc]+\)$/i.test(ref)) subShapes.add('i)');

    // their spelling wins: this is the whole point of a profile
    //
    // Guarded, because spreadsheet cells shift. Merged cells and stray commas
    // put whole sentences in the unit column, and a profile that learned
    // "Cable Trench and Transformers are excluded from the scope of work." as
    // a unit is worse than one that learned nothing. A unit is short and has
    // no prose in it.
    if (r.unit && isUnitLike(r.unit)) {
      const norm = normaliseUnit(r.unit);
      if (!unitSpelling[norm]) unitSpelling[norm] = r.unit.trim();
    }

    const m = OPENING.exec(desc);
    if (m) {
      const phrase = m[1].replace(/\s+/g, ' ').trim();
      if (phrase.length < 90) openings.set(phrase, (openings.get(phrase) ?? 0) + 1);
    }

    // does this client give companion items their own line?
    if (r.quantity !== undefined && r.unit) {
      const low = desc.toLowerCase();
      for (const w of COMPANION_WORDS) if (low.includes(w)) companions.add(w);
    }
  }

  const itemOpenings = [...openings.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([phrase]) => phrase);

  return {
    client: client.trim(),
    learnedFrom: [source],
    at: Date.now(),
    sections: sections.slice(0, 40),
    numbering: { items: itemShape || '1.2', subItems: [...subShapes] },
    unitSpelling,
    itemOpenings,
    preamble: preamble.slice(0, 40),
    separateCompanions: [...companions],
  };
}

/**
 * Merge a second bill into an existing profile.
 *
 * Conventions get more reliable with evidence, so learning is additive: a
 * second bill confirms or extends, and `learnedFrom` records every document
 * that contributed. A convention seen once and never again is visibly
 * thinner than one seen in four bills.
 */
export function mergeProfile(base: BoqProfile, next: BoqProfile): BoqProfile {
  const uniq = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
  return {
    ...base,
    learnedFrom: uniq(base.learnedFrom, next.learnedFrom),
    at: Date.now(),
    sections: uniq(base.sections, next.sections),
    numbering: {
      items: base.numbering.items || next.numbering.items,
      subItems: uniq(base.numbering.subItems, next.numbering.subItems),
    },
    // the earlier spelling stands unless it was never seen
    unitSpelling: { ...next.unitSpelling, ...base.unitSpelling },
    itemOpenings: uniq(base.itemOpenings, next.itemOpenings).slice(0, 8),
    preamble: base.preamble.length ? base.preamble : next.preamble,
    separateCompanions: uniq(base.separateCompanions, next.separateCompanions),
  };
}

/**
 * The profile rendered for a prompt.
 *
 * Given to the model when it words a sheet, so output reads like something
 * this client issued rather than like something generic.
 */
export function describeProfile(p: BoqProfile): string {
  const lines = [`HOUSE STYLE — ${p.client} (learned from ${p.learnedFrom.join(', ')})`];
  if (p.itemOpenings.length) {
    lines.push(`  Items open: ${p.itemOpenings.slice(0, 3).map((s) => `"${s}"`).join(' / ')}`);
  }
  const units = Object.entries(p.unitSpelling);
  if (units.length) {
    lines.push(`  Units are written: ${units.map(([n, s]) => `${n} → "${s}"`).join(', ')}`);
  }
  if (p.sections.length) {
    lines.push(`  Sections, in their order: ${p.sections.slice(0, 12).join(' · ')}`);
  }
  lines.push(`  Numbering: ${p.numbering.items} with ${p.numbering.subItems.join(' and ') || 'no'} sub-items`);
  if (p.separateCompanions.length) {
    lines.push(
      `  Billed as their own lines: ${p.separateCompanions.join(', ')} — do not fold these into the parent rate`,
    );
  }
  if (p.preamble.length) lines.push(`  Carries ${p.preamble.length} preamble clauses, reused verbatim`);
  return lines.join('\n');
}

// ------------------------------------------------------------
// storage — one profile per client, kept across projects
// ------------------------------------------------------------

const LS_KEY = 'bimcad.boq.profiles';

function readAll(): Record<string, BoqProfile> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, BoqProfile>;
  } catch {
    /* corrupt — a lost profile is re-learnable from the same bill */
  }
  return {};
}

function keyOf(client: string): string {
  return client.trim().toLowerCase();
}

export function listProfiles(): BoqProfile[] {
  return Object.values(readAll()).sort((a, b) => b.at - a.at);
}

export function profileFor(client: string): BoqProfile | null {
  return readAll()[keyOf(client)] ?? null;
}

/** Store a profile, merging into one already held for that client. */
export function saveProfile(profile: BoqProfile): BoqProfile {
  const all = readAll();
  const k = keyOf(profile.client);
  const merged = all[k] ? mergeProfile(all[k], profile) : profile;
  all[k] = merged;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* quota — best effort */
  }
  return merged;
}

export function forgetProfile(client: string): void {
  const all = readAll();
  delete all[keyOf(client)];
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* best effort */
  }
}

/** Classify raw sheet rows, then learn from them. The whole path in one call. */
export function learnFromSheet(
  client: string,
  source: string,
  raw: readonly { ref: string; description: string; quantity?: number; unit?: string }[],
): BoqProfile {
  const rows: TenderRow[] = raw.map((r, i) => ({
    row: i + 1,
    ref: r.ref,
    description: r.description,
    quantity: r.quantity,
    unit: r.unit,
    kind: classifyRow(r.ref, r.description, r.quantity, r.unit),
  }));
  return learnProfile(client, source, rows);
}
