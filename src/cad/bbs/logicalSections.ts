// ============================================================
// LOGICAL SECTIONS — the engineering boundary, which is not the visual one.
//
// A region is a cluster of ink separated from its neighbours by whitespace.
// That is a fact about the SHEET. It is not a fact about the STRUCTURE.
//
// A drafter draws one column detail as four separated clusters — the section
// through the column, the dimension chain beside it, the bar callouts leadered
// off to the right, a note underneath — and every one of those is a region.
// Read as four sections, that detail loses three quarters of itself: the
// dimension that fixes its depth lands in a different "section" from the
// callout that spaces its links, and a fact that needed both is orphaned in
// neither.
//
// So this module adds the level the sheet does not draw:
//
//   DRAWING → LOGICAL SECTION → VISUAL REGIONS → ENTITIES → DATAFACTS
//
// A logical section OWNS its regions. It carries every region id, so a crop, a
// re-read, a highlight or a targeted OCR still addresses the exact cluster it
// needs — regions remain the implementation unit, and are not removed. What
// changes is which of the two the engineering answer is drawn from.
//
// GROUPING IS EVIDENCE-LED, AND THE DEFAULT IS "TOGETHER".
//
// Two regions are one section when something semantic says so: the same member
// mark, the same title, a leader crossing between them, a continuation label.
// They are two sections only when there is evidence they describe DIFFERENT
// engineering — different marks, or different titles. A region with no mark and
// no title of its own is not evidence of a new detail; it attaches to its
// neighbour and says it did so on proximity alone, which is a weaker claim and
// is labelled POSSIBLE_CONTINUATION rather than asserted.
//
// Nothing here calls a model. Same sheet in, same sections out.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';
import type { Bounds } from './render';

/** What this module can group: anything with an id, bounds and the evidence it holds. */
export interface GroupableRegion {
  id: string;
  bounds: Bounds;
  evidenceIds: readonly string[];
  label?: string;
  kind?: string;
  /**
   * A cluster of ink the splitter could not place — GAP-01 and its kind.
   *
   * A gap is NOT an engineering detail by default. It is content that has to
   * belong somewhere, and the question asked of it is "which detail is this
   * part of?", never "what new detail is this?".
   */
  isGap?: boolean;
  /** for a gap: the regions it touches, which is where it most likely belongs */
  joins?: readonly string[];
}

export type SectionRelation = 'CONFIRMED' | 'POSSIBLE_CONTINUATION';

export interface LogicalSection {
  /** stable across runs of the same sheet */
  id: string;
  /** the detail's own title, when one of its regions carries one */
  title?: string;
  /** what the sheet calls this kind of thing — the dominant region kind */
  kind: string;
  /** THE REGIONS IT OWNS. Always at least one; often several. */
  regionIds: string[];
  /** every entity in every one of those regions */
  evidenceIds: string[];
  /** the member marks this section describes */
  marks: string[];
  /** the union of its regions' bounds — for a crop that shows the whole detail */
  bounds: Bounds;
  /** one line per signal that put a region in here, in the order they fired */
  basis: string[];
  /**
   * CONFIRMED when a semantic signal grouped every region; POSSIBLE_CONTINUATION
   * when at least one region joined on proximity alone and should be re-read
   * before anything rests on the grouping.
   */
  relation: SectionRelation;
  confidence: number;
}

export interface SectionResult {
  sections: LogicalSection[];
  /** how each region was placed, for a reader who disagrees with the grouping */
  diagnostics: string[];
}

// ------------------------------------------------------------
// reading a region
// ------------------------------------------------------------

/**
 * A region naming this many distinct marks is an INDEX, not a detail: a layout
 * plan, a schedule table, a key. It must not swallow the details it indexes —
 * "TYPICAL FOOTING PLAN" names F1…F9 and is not the same engineering object as
 * the F1 section.
 */
const HUB_MARKS = 4;

const CONTINUATION = /\b(cont(?:in(?:ued|uation))?\.?|contd\.?|sheet\s+\d+\s+of\s+\d+|\d+\s*of\s*\d+)\b/i;

/** Strip what a title varies by so two spellings of one detail match. */
export function normaliseTitle(text: string): string {
  return text
    .toUpperCase()
    .replace(CONTINUATION, ' ')
    .replace(/\b(TYP(?:ICAL)?|DETAIL|SECTION|VIEW|ELEVATION|PLAN|AT|OF|THE|FOR)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * A LABEL THAT IS CONTENT, NOT A NAME.
 *
 * "20-16 vertical bars", "10-150 c/c", "CLEAR COVER 40" — these are what the
 * detail SAYS, not what it is called. A cluster carrying one of them has no
 * identity of its own: it is reinforcement, or a note, belonging to whatever
 * detail it was drawn for. Treating such a label as a title is how a
 * reinforcement callout becomes its own "engineering section" and the bars go
 * missing from the member they belong to.
 */
const CONTENT_LABEL = [
  /\d+\s*[-–]\s*\d+/,                         // 20-16, 10-150
  /@|c\/c|CTS\b/i,                            // spacing
  /\b[TØ#]\s*\d{1,2}\b/i,                     // T16, Ø12, #4
  /\b(COVER|LAP|LAPS|ANCHOR\w*|DEVELOPMENT|GRADE|CONCRETE|STEEL|WASTAGE|BEND|HOOK)\b/i,
  /^\s*[\d.,\s×xX]+\s*(MM|CM|M)?\s*$/i,       // a bare dimension
];

/**
 * Member marks in a caption, by the grammar Indian structural drawings use:
 * one to three letters and a number — F1, P1, C12, PB03, TB-2.
 *
 * Deliberately excludes the tokens that share that shape and are NOT marks: a
 * concrete grade (M25), a steel grade (Fe500), a bar diameter (T16), a code
 * reference (IS456). A caller who knows this job's real marks should pass
 * `marksInLabel` instead — this is the fallback for a sheet nobody has read
 * yet, and it says so.
 */
const MARK_TOKEN = /\b([A-Z]{1,3}-?\d{1,3}[A-Z]?)\b/g;
const NOT_A_MARK = /^(M\d{2,3}|T\d{1,2}|FE\d{3}|IS\d{3,4}|D\d{1,2}|NO\d+)$/;

export function marksInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(MARK_TOKEN)) {
    const token = m[1].replace(/-/g, '');
    if (NOT_A_MARK.test(token)) continue;
    out.add(token);
  }
  return [...out];
}

export function isContentLabel(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CONTENT_LABEL.some((re) => re.test(t));
}

/** "A-A", "B–B", "1-1", "SEC A", "DETAIL 3" — which VIEW this is, not what it is OF. */
const VIEW_WORDS = /\b(TYP(?:ICAL)?|DETAIL|DETAILS|SECTION|SEC|VIEW|ELEVATION|ELEV|PLAN|LAYOUT|SCHEDULE|AT|OF|THE|FOR|AND)\b/g;
const VIEW_MARKER = /\b([A-Z0-9]{1,2})\s*[-–—]\s*\1\b/g;

/**
 * WHAT A TITLE IS ABOUT, with the view it happens to be stripped away.
 *
 *   "PLAN - PEDESTAL P1"        → "PEDESTAL P1"
 *   "SECTION A-A - PEDESTAL P1" → "PEDESTAL P1"
 *
 * A plan and a section of the same pedestal are two views of ONE engineering
 * detail. They share no words but the ones that matter, so comparing titles
 * whole would keep them apart; comparing their subject puts them together.
 */
export function subjectOf(text: string): string {
  const subject = text
    .toUpperCase()
    .replace(CONTINUATION, ' ')
    .replace(VIEW_MARKER, ' ')
    .replace(VIEW_WORDS, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  // A title that was ONLY a view name ("SECTION A-A") has no subject of its
  // own; it says how this is drawn, not what it is drawn of.
  return subject;
}

export interface GroupOptions {
  /**
   * Marks a CALLER has established for an entity, beyond what the entity
   * itself carries.
   *
   * A bar callout drawn on its own says "10@150c/c" and names nobody; what
   * ties it to F3 is the schedule row it is printed in, or an ownership claim
   * this run has accepted. Those live outside this module, so they are passed
   * in — and they are the difference between eight orphaned clusters of
   * callouts and eight details that each belong to a footing.
   */
  marksFor?: (evidenceId: string) => readonly string[] | undefined;
  /**
   * Marks a caller can read out of a region's own caption. The splitter labels
   * a region "PLAN - PEDESTAL P1"; only the caller knows which of its words is
   * a member mark on this job, so it says.
   */
  marksInLabel?: (label: string) => readonly string[] | undefined;
}

/** The member marks a region names, from its mark tags, declarations and callouts. */
export function marksIn(
  region: GroupableRegion,
  graph?: EvidenceGraph,
  opts: GroupOptions = {},
): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) out.add(value.trim().toUpperCase());
  };
  for (const id of region.evidenceIds) {
    for (const mark of opts.marksFor?.(id) ?? []) add(mark);
    const node = graph?.byId.get(id);
    if (!node) continue;
    add(node.metadata?.mark ?? node.metadata?.memberMark);
    if (node.kind === 'declaration') add(node.metadata?.name);
  }
  // A splitter's own caption names the member — "PLAN - PEDESTAL P1" — and on
  // that path there is no evidence graph to read metadata from.
  for (const mark of opts.marksInLabel?.(region.label ?? '') ?? []) add(mark);
  return [...out];
}

/** The region's own caption: its label, or the declaration inside it. */
export function titleOf(region: GroupableRegion, graph?: EvidenceGraph): string | undefined {
  if (region.label?.trim()) return region.label.trim();
  for (const id of region.evidenceIds) {
    const node = graph?.byId.get(id);
    if (node?.kind === 'declaration' && node.rawText?.trim()) return node.rawText.trim();
  }
  return undefined;
}

interface Read {
  region: GroupableRegion;
  marks: Set<string>;
  title?: string;
  key?: string;
  /** what the title is ABOUT, the view stripped off — "PEDESTAL P1" */
  subject?: string;
  isHub: boolean;
  isContinuation: boolean;
  /** this cluster says who it is: a mark, or a subject of its own */
  hasIdentity: boolean;
}

function readRegion(region: GroupableRegion, graph: EvidenceGraph | undefined, opts: GroupOptions): Read {
  const marks = new Set(marksIn(region, graph, opts));
  const title = titleOf(region, graph);
  const content = Boolean(title && isContentLabel(title));
  const subject = title && !content ? subjectOf(title) || undefined : undefined;
  return {
    region,
    marks,
    title,
    key: title && !content ? normaliseTitle(title) || undefined : undefined,
    subject,
    isHub: marks.size >= HUB_MARKS,
    isContinuation: title ? CONTINUATION.test(title) : false,
    // A GAP never has an identity of its own — that is what makes it a gap.
    // Nor does a cluster whose caption is CONTENT: "10-150 c/c" is what a
    // detail says, not what it is called. A title that is only a view name
    // ("SECTION A-A") does still name this cluster, even though it says
    // nothing about what the view is OF.
    hasIdentity:
      !region.isGap &&
      (marks.size > 0 ||
        (!(title && isContentLabel(title)) && (Boolean(subject) || Boolean(title ? normaliseTitle(title) : '')))),
  };
}

// ------------------------------------------------------------
// the signals
// ------------------------------------------------------------

interface Join {
  a: number;
  b: number;
  why: string;
  score: number;
  /** a semantic signal, as opposed to proximity */
  semantic: boolean;
}

/**
 * WHAT EACH SIGNAL IS WORTH.
 *
 * Two clusters are one detail when the evidence says so, and the evidence is
 * not all of one strength. A shared member mark is near-proof. A leader
 * physically drawn from one to the other is near-proof. Sitting close together
 * is not evidence at all between two clusters that each say who they are —
 * that is how two unrelated details 300 mm apart become one.
 *
 * At or above SEMANTIC the join is asserted; below it the join is still made,
 * because orphaning content is worse, but the section is marked
 * POSSIBLE_CONTINUATION and says what it rests on.
 */
export const SIGNAL_SCORE = {
  /** both clusters name the same member */
  sameMark: 100,
  /** both titles are about the same thing — "PLAN - P1" and "SECTION A-A - P1" */
  sameSubject: 100,
  /** the same title, one of them a continuation */
  continuation: 95,
  /** a leader is drawn from one cluster to the other */
  leader: 90,
  /** a gap cluster touching a region that has an identity */
  gapTouches: 70,
  /** an unidentified cluster next to one that has an identity */
  proximity: 30,
} as const;

/** at or above this a join is asserted; below it, it is a POSSIBLE_CONTINUATION */
export const SEMANTIC = 60;

/** Which region a leader's two ends fall in — a leader crossing regions joins them. */
function leaderJoins(reads: readonly Read[], graph?: EvidenceGraph): Join[] {
  const regionOfNode = new Map<string, number>();
  reads.forEach((r, i) => {
    for (const id of r.region.evidenceIds) regionOfNode.set(id, i);
  });

  const out: Join[] = [];
  const seen = new Set<string>();
  for (const edge of graph?.edges ?? []) {
    if (edge.rel !== 'carries' && edge.rel !== 'points-at') continue;
    const a = regionOfNode.get(edge.from);
    const b = regionOfNode.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      a,
      b,
      why: `a leader runs from ${reads[a].region.id} to ${reads[b].region.id} — the annotation and what it points at are one detail`,
      score: SIGNAL_SCORE.leader,
      semantic: true,
    });
  }
  return out;
}

function centre(b: Bounds): { x: number; y: number } {
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}

function gapBetween(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2));
  const dy = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
  return Math.hypot(dx, dy);
}

// ------------------------------------------------------------
// grouping
// ------------------------------------------------------------

/**
 * Group visual regions into the engineering sections they belong to.
 *
 * Deterministic and pure. The regions are kept whole — every one of them ends
 * up in exactly one section, and its id travels with the section.
 */
export function groupRegions(
  regions: readonly GroupableRegion[],
  graph?: EvidenceGraph,
  opts: GroupOptions = {},
): SectionResult {
  const diagnostics: string[] = [];
  if (!regions.length) return { sections: [], diagnostics: ['no regions to group'] };

  const reads = regions.map((r) => readRegion(r, graph, opts));
  const indexById = new Map(reads.map((r, i) => [r.region.id, i]));

  // --- union-find over regions ---
  const parent = reads.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const basis = new Map<number, string[]>();
  const weak = new Set<number>();
  const union = (join: Join): void => {
    const ra = find(join.a);
    const rb = find(join.b);
    if (ra === rb) return;
    parent[rb] = ra;
    const note = `${join.why} [${join.score}]`;
    basis.set(ra, [...(basis.get(ra) ?? []), ...(basis.get(rb) ?? []), note]);
    if (join.score < SEMANTIC) weak.add(ra);
    else if (weak.has(rb)) weak.add(ra);
  };

  /**
   * TWO CLUSTERS THAT EACH SAY WHO THEY ARE, AND SAY DIFFERENT THINGS, ARE
   * DIFFERENT DETAILS — however close together they are drawn. This is the
   * guard that keeps two unrelated details 300 mm apart from becoming one.
   */
  const conflict = (a: Read, b: Read): boolean => {
    if (!a.hasIdentity || !b.hasIdentity) return false;
    const sharedMark = [...a.marks].some((m) => b.marks.has(m));
    if (a.marks.size && b.marks.size && !sharedMark) return true;
    if (sharedMark) return false;
    // What each is ABOUT decides next; only when neither says what it is about
    // does the title as written have to stand for it.
    if (a.subject && b.subject) return a.subject !== b.subject;
    if (a.key && b.key) return a.key !== b.key;
    return false;
  };

  // 1. THE SAME MEMBER MARK. The strongest signal there is: two clusters that
  //    name C1 are describing C1. Hubs are excluded — an index of nine marks
  //    is not the same object as the detail of one of them.
  for (let i = 0; i < reads.length; i++) {
    for (let j = i + 1; j < reads.length; j++) {
      if (reads[i].isHub || reads[j].isHub) continue;
      const shared = [...reads[i].marks].filter((m) => reads[j].marks.has(m));
      if (!shared.length) continue;
      union({
        a: i,
        b: j,
        why: `${reads[i].region.id} and ${reads[j].region.id} both describe ${shared.join(', ')}`,
        score: SIGNAL_SCORE.sameMark,
        semantic: true,
      });
    }
  }

  // 2. THE SAME SUBJECT. A plan and a section of one pedestal share no words
  //    but the ones that matter: "PLAN - PEDESTAL P1" and "SECTION A-A -
  //    PEDESTAL P1" are two VIEWS of one detail, and comparing titles whole
  //    would keep them apart forever.
  for (let i = 0; i < reads.length; i++) {
    for (let j = i + 1; j < reads.length; j++) {
      if (reads[i].isHub || reads[j].isHub) continue;
      const a = reads[i];
      const b = reads[j];
      if (!a.subject || !b.subject || a.subject !== b.subject) continue;
      const continuation = a.isContinuation || b.isContinuation;
      union({
        a: i,
        b: j,
        why: continuation
          ? `${b.region.id} continues ${a.region.id} — "${b.title}"`
          : `${a.region.id} "${a.title}" and ${b.region.id} "${b.title}" are two views of ${a.subject}`,
        score: continuation ? SIGNAL_SCORE.continuation : SIGNAL_SCORE.sameSubject,
        semantic: true,
      });
    }
  }

  // 2b. THE SAME TITLE AS WRITTEN. A cluster titled only for its view —
  //     "SECTION A-A" — has no subject to compare, but two clusters carrying
  //     that same title, one of them a continuation, are still one section.
  for (let i = 0; i < reads.length; i++) {
    for (let j = i + 1; j < reads.length; j++) {
      const a = reads[i];
      const b = reads[j];
      if (a.isHub || b.isHub) continue;
      if (!a.key || !b.key || a.key !== b.key) continue;
      if (find(i) === find(j)) continue;
      const continuation = a.isContinuation || b.isContinuation;
      union({
        a: i,
        b: j,
        why: continuation
          ? `${b.region.id} is a continuation of ${a.region.id} — "${b.title}"`
          : `${a.region.id} and ${b.region.id} carry the same title "${a.title}"`,
        score: continuation ? SIGNAL_SCORE.continuation : SIGNAL_SCORE.sameSubject,
        semantic: true,
      });
    }
  }

  // 3. LEADERS AND ARROWS. A callout leadered from one cluster onto geometry
  //    in another is the drafter saying they belong together.
  for (const join of leaderJoins(reads, graph)) {
    if (conflict(reads[join.a], reads[join.b])) continue;
    union(join);
  }

  // 4. A GAP IS NOT A DETAIL. An unplaced cluster names the regions it touches;
  //    it belongs to one of them, and the question is which — never "what new
  //    detail is this?".
  for (let i = 0; i < reads.length; i++) {
    const read = reads[i];
    if (!read.region.isGap) continue;
    const touched = (read.region.joins ?? [])
      .map((id) => indexById.get(id))
      .filter((n): n is number => n !== undefined);
    if (!touched.length) continue;
    // when everything it touches is already one detail, it is part of that
    // detail; when they are several, it goes to the nearest of them and says so
    const roots = new Set(touched.map(find));
    const target =
      roots.size === 1
        ? touched[0]
        : touched.reduce((best, n) =>
            gapBetween(read.region.bounds, reads[n].region.bounds) <
            gapBetween(read.region.bounds, reads[best].region.bounds)
              ? n
              : best,
          );
    union({
      a: target,
      b: i,
      why:
        `${read.region.id} was not placed by the splitter; it touches ` +
        `${(read.region.joins ?? []).join(', ')} and is read as part of ${reads[target].region.id}` +
        (roots.size === 1 ? '' : ' — the nearest of several it touches'),
      score: roots.size === 1 ? SIGNAL_SCORE.gapTouches : SIGNAL_SCORE.proximity,
      semantic: roots.size === 1,
    });
  }

  // 5. A REGION WITH NOTHING OF ITS OWN. No mark, no subject: a dimension
  //    chain, a bare note, a gap that touched nothing. It is not evidence of a
  //    new detail — the nearest identified section is a better home than a
  //    section of its own. Recorded as proximity, so the grouping says how
  //    much it is worth.
  const alreadyPlaced = (i: number): boolean =>
    reads.some((_, j) => j !== i && find(j) === find(i));

  for (let i = 0; i < reads.length; i++) {
    if (reads[i].hasIdentity) continue;
    // ALREADY IN A DETAIL. A gap the splitter placed, or a cluster a leader
    // pulled in, is not looking for a home — and attaching it a second time
    // to a DIFFERENT detail would merge two details that share nothing.
    if (alreadyPlaced(i)) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < reads.length; j++) {
      if (j === i || find(j) === find(i)) continue;
      if (!reads[j].hasIdentity) continue;
      const gap = gapBetween(reads[i].region.bounds, reads[j].region.bounds);
      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    }
    if (best >= 0) {
      union({
        a: best,
        b: i,
        why:
          `${reads[i].region.id} names no member and carries no title; it sits ${Math.round(bestGap)} mm from ` +
          `${reads[best].region.id} and is read as part of it — proximity only, so confirm before relying on it`,
        score: SIGNAL_SCORE.proximity,
        semantic: false,
      });
    } else {
      diagnostics.push(`${reads[i].region.id} names nothing and has no labelled neighbour — left as its own section`);
    }
  }

  // --- assemble ---
  const groups = new Map<number, number[]>();
  reads.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  const sections: LogicalSection[] = [];
  const ordered = [...groups.entries()].sort((a, b) => {
    const ca = centre(reads[a[1][0]].region.bounds);
    const cb = centre(reads[b[1][0]].region.bounds);
    return cb.y - ca.y || ca.x - cb.x;
  });

  for (const [root, members] of ordered) {
    const parts = members.map((i) => reads[i]);
    const marks = new Set<string>();
    const evidenceIds: string[] = [];
    let bounds: Bounds | null = null;
    for (const p of parts) {
      for (const m of p.marks) marks.add(m);
      evidenceIds.push(...p.region.evidenceIds);
      bounds = bounds
        ? {
            x1: Math.min(bounds.x1, p.region.bounds.x1),
            y1: Math.min(bounds.y1, p.region.bounds.y1),
            x2: Math.max(bounds.x2, p.region.bounds.x2),
            y2: Math.max(bounds.y2, p.region.bounds.y2),
          }
        : { ...p.region.bounds };
    }
    const titled = parts.find((p) => p.title && !p.isContinuation) ?? parts.find((p) => p.title);
    const kinds = parts.map((p) => p.region.kind).filter((k): k is string => Boolean(k));
    const dominant =
      kinds.sort(
        (a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length,
      )[0] ?? 'unknown';

    const why = basis.get(root) ?? [];
    const uncertain = weak.has(root);
    sections.push({
      id: `SECTION-${String(sections.length + 1).padStart(2, '0')}`,
      ...(titled?.title ? { title: titled.title } : {}),
      kind: dominant,
      regionIds: parts.map((p) => p.region.id),
      evidenceIds: [...new Set(evidenceIds)],
      marks: [...marks].sort(),
      bounds: bounds!,
      basis: why.length ? [...new Set(why)] : [`${parts[0].region.id} stands alone — nothing else on the sheet describes it`],
      relation: uncertain ? 'POSSIBLE_CONTINUATION' : 'CONFIRMED',
      confidence: uncertain ? 0.6 : parts.length > 1 ? 0.9 : 0.8,
    });
  }

  for (const s of sections) {
    diagnostics.push(
      `${s.id}${s.title ? ` "${s.title}"` : ''} — ${s.regionIds.length} region(s): ${s.regionIds.join(', ')}` +
        `${s.marks.length ? ` · ${s.marks.join(', ')}` : ''}${s.relation === 'POSSIBLE_CONTINUATION' ? ' · POSSIBLE_CONTINUATION' : ''}`,
    );
  }
  return { sections, diagnostics };
}

// ------------------------------------------------------------
// looking things up
// ------------------------------------------------------------

/** The section an entity belongs to — the engineering answer to "where is this?". */
export function sectionOf(
  sections: readonly LogicalSection[],
  evidenceId: string,
): LogicalSection | undefined {
  return sections.find((s) => s.evidenceIds.includes(evidenceId));
}

/** The section that owns a region. */
export function sectionOfRegion(
  sections: readonly LogicalSection[],
  regionId: string,
): LogicalSection | undefined {
  return sections.find((s) => s.regionIds.includes(regionId));
}

/** Every section describing a member mark. */
export function sectionsForMark(
  sections: readonly LogicalSection[],
  mark: string,
): LogicalSection[] {
  const wanted = mark.trim().toUpperCase();
  return sections.filter((s) => s.marks.includes(wanted));
}

/**
 * The provenance a DataFact read from this evidence must carry: the logical
 * section it belongs to AND every region that section is drawn across, so a
 * highlight or a re-read can still address the exact cluster.
 */
export function provenanceFor(
  sections: readonly LogicalSection[],
  evidenceId: string,
): { sectionId?: string; regionIds: string[] } {
  const section = sectionOf(sections, evidenceId);
  if (!section) return { regionIds: [] };
  return { sectionId: section.id, regionIds: [...section.regionIds] };
}

/** What the model is shown: sections first, with the regions they are drawn across. */
export function renderSections(sections: readonly LogicalSection[]): string {
  if (!sections.length) return '(no sections)';
  return sections
    .map((s) => {
      const head =
        `${s.id}${s.title ? ` "${s.title}"` : ''} [${s.kind}] — drawn across ${s.regionIds.length} ` +
        `region(s): ${s.regionIds.join(', ')}`;
      const marks = s.marks.length ? `\n    describes: ${s.marks.join(', ')}` : '';
      const note =
        s.relation === 'POSSIBLE_CONTINUATION'
          ? '\n    POSSIBLE_CONTINUATION — one part joined on proximity alone; re-read before relying on it'
          : '';
      return `  ${head}${marks}${note}\n    ${s.basis.join('\n    ')}`;
    })
    .join('\n');
}
