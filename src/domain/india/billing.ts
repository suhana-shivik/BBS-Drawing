// ============================================================
// Turning a measurement into a BILL — Indian practice.
//
// KNOWLEDGE vs CODE
//
// The domain knowledge lives in `.claude/skills/indian-construction/SKILL.md`
// and is imported below via `?raw`, exactly as `src/cad/bbs/knowledge.ts`
// imports the BBS skill: one source of truth, editing the file changes what
// any model is told, and a rename is a BUILD FAILURE rather than a prompt
// that quietly ships without half its knowledge. (An earlier revision of this
// file paraphrased the skill on the belief that Vite would not bundle it;
// `knowledge.ts` proved on a sibling file that `?raw` bundles fine, so the
// paraphrase is gone.)
//
// What remains here is only what code COMPUTES with: typed lookup tables
// (device-family spec requirements, pole-word expansion) and the
// deterministic extractors that read a specification off drawing text. The
// tables' CONTENT is drawn from the skill's §6 (electrical naming, pole
// notation, cable notation) — SKILL.md is their knowledge source; this file
// is their executable form. Knowledge assigns meaning; this code computes.
//
// THE RULE THIS FILE SERVES
//
// A take-off measures WHAT IS DRAWN. It never adds an item because practice
// says one should exist. So companion-item knowledge appears here only as a
// QUESTION a reviewer may read, never as a line a bill may contain.
//
// THE OTHER RULE
//
// A bill line exists to be priced. "MCCB — 171 nos" cannot be: a 32 A and a
// 125 A breaker are different money. So the specification a vendor needs in
// order to quote is not decoration — it is what makes the line finished.
// ============================================================
import SKILL_MD from '../../../.claude/skills/indian-construction/SKILL.md?raw';

/**
 * The indian-construction skill exactly as written — the knowledge this
 * module's tables are the executable form of. Exported so prompts can carry
 * it verbatim and a test can prove it shipped.
 */
export const INDIAN_CONSTRUCTION_SKILL = SKILL_MD;

/**
 * Bill sections, in the order an Indian electrical bill runs.
 *
 * The order is itself convention: switchgear before cabling before earthing is
 * how the trade reads, and a bill in another order looks wrong to the person
 * checking it even when every figure is right.
 */
export const ELECTRICAL_SECTIONS = [
  'Switchgear',
  'Metering & protection',
  'Control & indication',
  'Cabling & containment',
  'Earthing & lightning protection',
  'Lighting',
  'Equipment',
] as const;

export const GENERAL_SECTIONS = [
  'Earthwork',
  'Concrete',
  'Reinforcement',
  'Masonry',
  'Finishes',
  'Doors & windows',
  'Waterproofing',
  'Miscellaneous',
] as const;

export type BillSection = string;

/** every section name a model may choose from, for the whole app */
export function allSections(): string[] {
  return [...ELECTRICAL_SECTIONS, ...GENERAL_SECTIONS, 'Unclassified'];
}

// ------------------------------------------------------------
// what a vendor needs in order to quote
// ------------------------------------------------------------

export interface SpecRequirement {
  /** the family this applies to, matched against the item description */
  match: RegExp;
  /** attribute keys that must be present for the line to be priceable */
  required: string[];
  /** the section this family belongs in */
  section: string;
  /** the IS standard usually cited on the bill line */
  standard?: string;
}

/**
 * Specification a bill line must carry, by device family.
 *
 * Knowledge source: `indian-construction/SKILL.md` §6 (device families, pole
 * and cable notation, the IS codes). This is its executable form — a typed
 * table `requirementFor` / `specForFamily` / `missingSpec` compute with.
 * Absent any required attribute, the line goes out to a vendor who cannot
 * price it and comes back as a query.
 */
export const SPEC_REQUIREMENTS: SpecRequirement[] = [
  {
    match: /\bMCCB\b|moulded\s*case/i,
    required: ['rating', 'poles', 'breaking'],
    section: 'Switchgear',
    standard: 'IS/IEC 60947-2',
  },
  {
    match: /\bMCB\b|miniature\s*circuit/i,
    required: ['rating', 'poles'],
    section: 'Switchgear',
    standard: 'IS/IEC 60898-1',
  },
  {
    match: /\bACB\b|air\s*circuit/i,
    required: ['rating', 'poles', 'breaking'],
    section: 'Switchgear',
    standard: 'IS/IEC 60947-2',
  },
  {
    match: /\bRCCB\b|\bRCBO\b|residual\s*current/i,
    required: ['rating', 'sensitivity'],
    section: 'Switchgear',
    standard: 'IS/IEC 61008',
  },
  {
    match: /\bATS\b|changeover|transfer\s*switch/i,
    required: ['rating', 'poles'],
    section: 'Switchgear',
  },
  {
    match: /isolator|switch\s*disconnect|\bSFU\b/i,
    required: ['rating', 'poles'],
    section: 'Switchgear',
  },
  {
    match: /\bCT\b|current\s*transformer/i,
    required: ['ratio'],
    section: 'Metering & protection',
    standard: 'IS 2705',
  },
  {
    match: /\bMFM\b|multi[\s-]*function\s*meter|energy\s*meter|\bVAF\b|frequency\s*meter|ammeter|voltmeter/i,
    required: [],
    section: 'Metering & protection',
  },
  {
    match: /relay|protection/i,
    required: [],
    section: 'Metering & protection',
  },
  {
    match: /indicating\s*lamp|\bLED\b\s*lamp|push\s*button|selector\s*switch/i,
    required: [],
    section: 'Control & indication',
  },
  {
    match: /cable|conductor|\bwire\b|conduit|tray|raceway|busduct|busbar|rising\s*main/i,
    required: ['cores', 'size', 'material'],
    section: 'Cabling & containment',
    standard: 'IS 1554 / IS 7098',
  },
  {
    match: /earth|ground|\bGI\s*strip\b|lightning/i,
    required: [],
    section: 'Earthing & lightning protection',
    standard: 'IS 3043',
  },
  {
    match: /light\s*fitting|luminaire|fixture|fan\b/i,
    required: ['wattage'],
    section: 'Lighting',
  },
  {
    match: /panel|\bDB\b|distribution\s*board|\bPCC\b|\bMCC\b|feeder\s*pillar/i,
    required: [],
    section: 'Equipment',
  },
];

export function requirementFor(description: string): SpecRequirement | null {
  for (const r of SPEC_REQUIREMENTS) if (r.match.test(description)) return r;
  return null;
}

// ------------------------------------------------------------
// reading a specification off the drawing's own text
// ------------------------------------------------------------

export interface ItemSpec {
  /** amps, e.g. "63A" */
  rating?: string;
  /** "4P", "TP", "DP", "SP" */
  poles?: string;
  /** breaking capacity, e.g. "25kA" */
  breaking?: string;
  /** CT ratio, e.g. "200/5" */
  ratio?: string;
  /** RCCB sensitivity, e.g. "30mA" */
  sensitivity?: string;
  /** cable cores */
  cores?: string;
  /** conductor size in sq.mm */
  size?: string;
  material?: string;
  wattage?: string;
}

// SKILL.md §6 pole notation ("SP single pole … TPN triple pole + neutral"),
// as the lookup table `readSpec` computes with.
const POLE_WORDS: Record<string, string> = {
  SP: '1-pole',
  DP: '2-pole',
  TP: '3-pole',
  TPN: '3-pole + neutral',
  FP: '4-pole',
  '1P': '1-pole',
  '2P': '2-pole',
  '3P': '3-pole',
  '4P': '4-pole',
};

/**
 * Extract the billable specification from text printed beside a symbol.
 *
 * Deterministic and evidence-bound: every field comes from a string that is on
 * the drawing. Nothing is inferred from what a device "usually" is — a breaker
 * with no stated rating stays unrated, and the line reports itself unpriceable
 * rather than acquiring a plausible number.
 */
export function readSpec(texts: readonly string[]): ItemSpec {
  const spec: ItemSpec = {};
  for (const raw of texts) {
    const t = raw.toUpperCase();

    // 63A / 125 A / 0.5A
    const amp = /(\d+(?:\.\d+)?)\s*A\b(?!H)/.exec(t);
    if (amp && !spec.rating) spec.rating = `${amp[1]}A`;

    // 4P / TP / TPN / DP
    const pole = /\b(TPN|SP|DP|TP|FP|[1-4]P)\b/.exec(t);
    if (pole && !spec.poles) spec.poles = POLE_WORDS[pole[1]] ?? pole[1];

    // 25kA breaking capacity
    const ka = /(\d+(?:\.\d+)?)\s*KA\b/.exec(t);
    if (ka && !spec.breaking) spec.breaking = `${ka[1]}kA`;

    // CT ratio 200/5
    const ratio = /\b(\d{2,5})\s*\/\s*(1|5)\b/.exec(t);
    if (ratio && !spec.ratio) spec.ratio = `${ratio[1]}/${ratio[2]}`;

    // 30mA / 100 mA earth leakage
    const ma = /(\d+)\s*MA\b/.exec(t);
    if (ma && !spec.sensitivity) spec.sensitivity = `${ma[1]}mA`;

    // 3.5x185 sq.mm — cores and size
    const cable = /(\d+(?:\.\d+)?)\s*C?\s*[X×]\s*(\d+(?:\.\d+)?)\s*SQ\.?\s*MM/.exec(t);
    if (cable) {
      if (!spec.cores) spec.cores = cable[1];
      if (!spec.size) spec.size = `${cable[2]} sq.mm`;
    }
    if (!spec.material) {
      if (/\bCU\b|COPPER/.test(t)) spec.material = 'copper';
      else if (/\bAL\b|ALUMINI?UM/.test(t)) spec.material = 'aluminium';
    }

    // 36W / 2x18 W
    const watt = /(\d+(?:\.\d+)?)\s*W\b/.exec(t);
    if (watt && !spec.wattage) spec.wattage = `${watt[1]}W`;
  }
  return spec;
}

/**
 * A stable key for "the same thing, billed the same way".
 *
 * Two instances of one block with different ratings are TWO bill lines; two
 * instances of different blocks with the same rating may be one. Grouping on
 * this signature is what makes a bill priceable, and it is computed from
 * drawing text rather than decided by anyone.
 */
export function specSignature(spec: ItemSpec): string {
  const bits = [
    spec.rating,
    spec.poles,
    spec.breaking,
    spec.ratio,
    spec.sensitivity,
    spec.cores && spec.size ? `${spec.cores}C ${spec.size}` : spec.size,
    spec.material,
    spec.wattage,
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * Keep only the attributes this family is actually billed on.
 *
 * Text near a symbol belongs to whatever is nearest, not necessarily to the
 * symbol — a cable callout sits beside the breaker it feeds, and one breaker's
 * breaking capacity sits beside its neighbour. Left unfiltered, a real SLD
 * split a single 2 A MCB into three groups on a stray "35kA" and attached
 * "3.5C 240 sq.mm aluminium" to a breaker.
 *
 * Filtering by family fixes both without judgement: an MCCB is billed on
 * rating, poles and breaking capacity, so nothing else may enter its
 * signature. Cable fields survive only on a cable line.
 */
export function specForFamily(description: string, spec: ItemSpec): ItemSpec {
  const req = requirementFor(description);
  // no known family: keep the strongest identifying attributes only, so an
  // unrecognised item does not shatter into one group per stray label
  const keep = req ? new Set(req.required) : new Set(['rating', 'poles']);
  const out: ItemSpec = {};
  for (const k of Object.keys(spec) as (keyof ItemSpec)[]) {
    if (keep.has(k) && spec[k] !== undefined) out[k] = spec[k];
  }
  return out;
}

/** which required attributes this line still lacks */
export function missingSpec(description: string, spec: ItemSpec): string[] {
  const req = requirementFor(description);
  if (!req) return [];
  return req.required.filter((k) => !(spec as Record<string, unknown>)[k]);
}

/**
 * Companion items Indian practice expects alongside a given family.
 *
 * NOT for adding lines — a take-off measures what is drawn. These exist to
 * phrase a QUESTION for the reviewer, and are worth far more once the whole
 * sheet set is visible and the question can actually be answered.
 */
export const COMPANION_QUESTIONS: { match: RegExp; asks: string }[] = [
  {
    match: /earth|ground/i,
    asks: 'earth pits, GI strip and test links are usually scheduled with earthing symbols',
  },
  {
    match: /\bMCCB\b|\bACB\b|\bMCB\b/i,
    asks: 'breakers are normally accompanied by cable, glands and lugs',
  },
  {
    match: /cable/i,
    asks: 'cable is normally accompanied by glands, lugs and termination',
  },
  {
    match: /panel|\bDB\b|distribution\s*board/i,
    asks: 'panels usually carry a base channel or foundation item',
  },
];

export function companionQuestion(description: string): string | null {
  for (const c of COMPANION_QUESTIONS) if (c.match.test(description)) return c.asks;
  return null;
}
