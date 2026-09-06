// ============================================================
// What the drawing does not say — and what to ask about it
//
// WHY THIS EXISTS
//
// The engine is deliberately unable to invent a number: when a dimension is
// absent it writes UNAVAILABLE and stops. That is the right behaviour and it
// is why the tool can be trusted. But on its own it leaves a schedule with
// fifteen blank rows and no route forward, because the person reading it is
// never told WHAT to supply, WHY it is needed, or WHAT it would unblock.
//
// A pedestal plan is the clearest case. It carries everything about the
// cross-section — "1115x1275" is written beside the mark — and nothing at all
// about the height, because height comes from levels on a section. No amount
// of re-reading the plan will produce it. The only correct move is to ask.
//
// So this module turns each refusal into a question with:
//   · the question in the words a site engineer uses
//   · why the engine cannot proceed without it
//   · exactly which bar rows stay unscheduled until it is answered
//   · what the drawing DID say nearby, so the answer can be sanity-checked
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never answers its own question. A suggestion carries its basis and stays
// a suggestion until a person accepts it. Silently defaulting a pedestal
// height would produce a bill that looks complete and is wrong by three times,
// which is the exact failure this project exists to prevent.
// ============================================================
import { isLinearMember, runMmFromTakeoff } from './build';
import type { BbsBar, BbsMember, BbsResult, BbsSettings } from './types';

export type GapScope = 'project' | 'member';

export type GapKind =
  /** a named member axis the schedule needs and the sheet does not carry */
  | 'dimension'
  /** two numbers were read but which is plan and which is height is unstated */
  | 'ambiguous-dimension'
  /** how many of this member exist */
  | 'count'
  /** clear cover, when no note on the sheet states it */
  | 'cover'
  /** the bottom leg of a starter bar — NOT the development length */
  | 'anchorage'
  /** projection above, for the lap into whatever the member supports */
  | 'lap'
  /** the total run of a linear structure — the master quantity */
  | 'run';

export interface GapSuggestion {
  value: number;
  /** where the number came from — shown, never applied silently */
  basis: string;
}

export interface Gap {
  /** stable across re-reads, so an answer sticks to its question */
  id: string;
  scope: GapScope;
  /** member mark, or '' for a project-wide question */
  subject: string;
  kind: GapKind;
  /** the override field an answer writes to */
  field: 'lengthMm' | 'widthMm' | 'heightMm' | 'count' | 'coverMm' | 'anchorageMm' | 'lapMm' | 'runM';
  question: string;
  /** why the engine cannot proceed */
  because: string;
  /** bar marks that stay unscheduled until this is answered */
  blocks: string[];
  unit: 'mm' | 'nos' | 'm';
  /** what IS known about this member, so a typed answer can be checked */
  known: { label: string; value: number }[];
  suggestion?: GapSuggestion;
  /**
   * True when the engine cannot presently consume an answer. Such a gap is
   * still reported — knowing a figure is missing matters even before the
   * formula that uses it exists — but it is never presented as an input that
   * will change a number.
   */
  advisory?: boolean;
}

/**
 * Members whose bars run vertically, where the sheet in hand is a plan.
 *
 * For these the two dimensions on the plan are BOTH plan dimensions, and the
 * height lives on a section or a level schedule. Treating either plan
 * dimension as a height is the specific error that made a 2.27 m pedestal bar
 * come out at 1.175 m.
 */
const VERTICAL_TYPES = /pedestal|column|pier|stub|post/i;

const isVertical = (member: BbsMember): boolean => VERTICAL_TYPES.test(member.type);

const isLink = (bar: BbsBar): boolean =>
  bar.barType === 'TIE' || bar.barType === 'STIRRUP' || bar.barType === 'RING';

const has = (v: number | undefined): v is number => typeof v === 'number' && v > 0;

const barsFor = (result: BbsResult, mark: string): BbsBar[] =>
  result.interpretation.bars.filter((b) => b.memberMark === mark);

/** Rows the engine gave up on, for one member. */
function unscheduled(result: BbsResult, mark: string): string[] {
  return result.rows
    .filter((r) => r.memberMark === mark && r.lengthSource === 'UNAVAILABLE')
    .map((r) => r.barMark);
}

/**
 * Questions about one member's geometry.
 *
 * Ordered by what unblocks the most: a missing plan dimension stops every link
 * on that member, so it is asked before anything else.
 */
function memberGaps(member: BbsMember, result: BbsResult): Gap[] {
  const out: Gap[] = [];
  const bars = barsFor(result, member.mark);
  const blocked = unscheduled(result, member.mark);
  const links = bars.filter(isLink).map((b) => b.barMark ?? b.fromCallout);
  const mains = bars.filter((b) => !isLink(b)).map((b) => b.barMark ?? b.fromCallout);

  const known: { label: string; value: number }[] = [];
  if (has(member.lengthMm)) known.push({ label: 'L', value: member.lengthMm });
  if (has(member.widthMm)) known.push({ label: 'W', value: member.widthMm });
  if (has(member.heightMm)) known.push({ label: 'H', value: member.heightMm });

  const vertical = isVertical(member);

  // --- the mislabel case -------------------------------------------------
  // A vertical member with two dimensions read, one of them filed as height,
  // and no plan length. On a plan view both numbers are plan dimensions, so
  // the "height" is almost certainly nothing of the kind — but which is which
  // is not ours to decide, so it is asked rather than swapped.
  if (vertical && !has(member.lengthMm) && has(member.widthMm) && has(member.heightMm)) {
    out.push({
      id: `${member.mark}:plan`,
      scope: 'member',
      subject: member.mark,
      kind: 'ambiguous-dimension',
      field: 'lengthMm',
      question: `${member.mark} — plan length in mm`,
      because:
        `Two dimensions were read off the plan, ${member.widthMm} and ${member.heightMm}, ` +
        `and one was filed as height. A ${member.type} drawn in plan shows two PLAN ` +
        'dimensions; its height comes from levels on a section. Confirm the plan length ' +
        'here and give the real height below.',
      blocks: links.length ? links : blocked,
      unit: 'mm',
      known,
      suggestion: { value: member.heightMm, basis: 'the second dimension read off the plan' },
    });

    out.push({
      id: `${member.mark}:height`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'heightMm',
      question: `${member.mark} — height in mm, footing top to finished floor level`,
      because:
        'Every vertical bar is cut to this. It is not on a plan view: it is the ' +
        'difference between two levels, so it has to come from the section, the level ' +
        'schedule, or from you.',
      blocks: mains,
      unit: 'mm',
      known,
    });
    return out;
  }

  // --- ordinary missing axes ---------------------------------------------
  // Links need both plan dimensions to wrap; a MAT bar needs both too — one
  // axis to run along, the other to count against. Asking only for links left
  // F1's footing mats dead with no question anywhere on screen: rows blank,
  // nothing asked, nothing to type. A row the engine refuses must always have
  // a question that unblocks it, or the refusal is a dead end instead of a
  // request.
  const mats = bars
    .filter((b) => !isLink(b) && (b.distributionAxis === 'L' || b.distributionAxis === 'W'))
    .map((b) => b.barMark ?? b.fromCallout);
  const planBlocked = [...links, ...mats];
  // A LINEAR member runs: its "length" is the take-off run (the interview
  // asks that once, job-wide) and its width is its thickness. Asking "RCC
  // WALL — plan length?" beside a wall question the interview already asked,
  // and "how many?" about a thing that is not counted, were both on screen.
  const linear = isLinearMember(member);
  const needsPlan = planBlocked.length > 0;
  const planWhy =
    links.length && mats.length
      ? 'Links wrap the cross-section and the mat bars run across it — both plan dimensions are needed.'
      : links.length
        ? 'A link wraps the cross-section, so both plan dimensions are needed.'
        : 'A mat bar runs along one plan dimension and is counted along the other, so both are needed.';
  if (needsPlan && !linear && !has(member.lengthMm)) {
    out.push({
      id: `${member.mark}:L`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'lengthMm',
      question: `${member.mark} — plan length in mm`,
      because: planWhy,
      blocks: planBlocked,
      unit: 'mm',
      known,
    });
  }
  if (needsPlan && !has(member.widthMm)) {
    out.push({
      id: `${member.mark}:W`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'widthMm',
      question: `${member.mark} — plan width in mm`,
      because: planWhy,
      blocks: planBlocked,
      unit: 'mm',
      known,
    });
  }
  // a bent mat bar's end legs stand in the member's depth
  const bentMats = bars
    .filter(
      (b) =>
        !isLink(b) &&
        (b.distributionAxis === 'L' || b.distributionAxis === 'W') &&
        b.shapeCode !== '00',
    )
    .map((b) => b.barMark ?? b.fromCallout);
  if (!vertical && bentMats.length > 0 && !has(member.heightMm)) {
    out.push({
      id: `${member.mark}:D`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'heightMm',
      question: `${member.mark} — depth in mm`,
      because: 'The bent bars turn up at their ends, and the leg stands in the member depth.',
      blocks: bentMats,
      unit: 'mm',
      known,
    });
  }
  // a linear member with transverse bars (wall verticals) needs its height
  // for every one of their cutting lengths — same standing as a column's
  const linearNeedsHeight =
    isLinearMember(member) &&
    bars.some(
      (b) => !isLink(b) && b.spacingMm && b.spacingMm > 0 && b.distributionAxis !== 'H',
    );
  if (linearNeedsHeight && !has(member.heightMm)) {
    out.push({
      id: `${member.mark}:height`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'heightMm',
      question: `${member.mark} — height in mm (governing section, footing top upward)`,
      because:
        'Every transverse bar (the verticals in the face) is cut to this. Where the ' +
        'ground steps, give the governing height — per-stretch zoning lands with the ' +
        'stretch table.',
      blocks: bars
        .filter((b) => !isLink(b) && b.spacingMm && b.distributionAxis !== 'H')
        .map((b) => b.barMark ?? b.fromCallout),
      unit: 'mm',
      known,
    });
  }
  if (vertical && !has(member.heightMm)) {
    out.push({
      id: `${member.mark}:height`,
      scope: 'member',
      subject: member.mark,
      kind: 'dimension',
      field: 'heightMm',
      question: `${member.mark} — height in mm, footing top to finished floor level`,
      because:
        'Every vertical bar is cut to this, and it is the difference between two ' +
        'levels rather than anything a plan can show.',
      blocks: mains,
      unit: 'mm',
      known,
    });
  }

  // --- how many ----------------------------------------------------------
  // A count of 1 that nobody stated is the quietest error in a schedule: the
  // arithmetic is right and the order is short by a factor of twenty.
  //
  // ONLY that case is asked. A count read off plan tags is a FACT — the same
  // way a QS gets it — and asking "how many?" about five members whose tags
  // sit in plain sight on the layout was reported, rightly, as the panel
  // looking like it cannot count. Whether the layout is the whole job or one
  // typical stretch is a different question, and it belongs to the model's
  // interview, asked once for the sheet rather than once per member.
  if (member.count <= 1 && !linear) {
    out.push({
      id: `${member.mark}:count`,
      scope: 'member',
      subject: member.mark,
      kind: 'count',
      field: 'count',
      question: `${member.mark} — how many on this job`,
      because:
        'No tag was counted on the plan and no schedule states it, so one was assumed. ' +
        'Every quantity on this member is multiplied by it.',
      blocks: bars.map((b) => b.barMark ?? b.fromCallout),
      unit: 'nos',
      known: [{ label: 'assumed', value: member.count }],
    });
  }

  return out;
}

/**
 * Questions that belong to the job rather than to one member.
 *
 * The anchorage leg and the lap are asked once because they are office
 * conventions, not drawing facts — the reference schedule for this project
 * derives its bottom leg as `Ld − 300` and projects a flat 300 above, and
 * neither figure appears anywhere on the pedestal sheet.
 */
function projectGaps(result: BbsResult, settings: BbsSettings, coverStated: boolean): Gap[] {
  const out: Gap[] = [];
  const verticalMembers = result.members.filter(isVertical);

  if (!coverStated) {
    out.push({
      id: 'project:cover',
      scope: 'project',
      subject: '',
      kind: 'cover',
      field: 'coverMm',
      question: 'Clear cover in mm',
      because:
        'No note on this sheet states it, so a default is in use. Cover sets every link ' +
        'arm directly: each 5 mm changes a link by 10 mm on every face.',
      blocks: [],
      unit: 'mm',
      known: [{ label: 'in use', value: settings.coverMm }],
      suggestion: { value: settings.coverMm, basis: 'default for buried RCC, not read from this sheet' },
    });
  }

  if (verticalMembers.length) {
    out.push({
      id: 'project:anchorage',
      scope: 'project',
      subject: '',
      kind: 'anchorage',
      field: 'anchorageMm',
      question: 'Bottom L of a starter bar, in mm',
      because:
        'The leg that turns into the footing. This is NOT the development length — a ' +
        'schedule typically sets it as Ld less the projection above, and no drawing ' +
        'states it.',
      blocks: [],
      unit: 'mm',
      known: [],
      advisory: true,
    });

    out.push({
      id: 'project:lap',
      scope: 'project',
      subject: '',
      kind: 'lap',
      field: 'lapMm',
      question: 'Lap projecting above, in mm',
      because:
        'How far a starter bar stands above the pedestal for the column it supports. ' +
        'An office convention, absent from the sheet.',
      blocks: [],
      unit: 'mm',
      known: [],
      advisory: true,
    });
  }

  return out;
}

/**
 * Every question this schedule needs answered, most blocking first.
 *
 * `coverStated` says whether the sheet's own notes gave a cover; when they did
 * there is nothing to ask.
 */
export function findGaps(
  result: BbsResult,
  settings: BbsSettings,
  coverStated: boolean,
  declared: import('./types').DeclaredMember[] = [],
  answeredInterview: import('./interview').InterviewExchange[] = [],
  takeoff?: Record<string, unknown>,
): Gap[] {
  const gaps: Gap[] = [];

  // THE master quantity of a linear job. This question is normally the
  // model's to ask — but when the model does not, rows died naming "the run
  // question" while no such question existed anywhere on screen. A refusal
  // must always carry its unblocker, whichever brain forgot to ask.
  const linearMembers = result.members.filter(isLinearMember);
  if (linearMembers.length && runMmFromTakeoff(takeoff) === null) {
    const starving = result.rows
      .filter(
        (r) =>
          linearMembers.some((m) => m.mark === r.memberMark) &&
          // `null` is the unresolved count; the legacy 0 is kept in the test so
          // a cached result from before the change is still recognised as starving
          (r.cuttingLengthMm === null || r.barsPerMember === null || r.barsPerMember === 0),
      )
      .map((r) => r.barMark);
    gaps.push({
      id: 'project:run',
      scope: 'project',
      subject: '',
      kind: 'run',
      field: 'runM',
      question: 'Total run of the linear work (wall / tie beam), in metres',
      because:
        'The master quantity: every longitudinal bar is cut to it and every ' +
        'stirrup is counted along it. It lives on the site plan or in your ' +
        'head, never on a typical-detail sheet.',
      blocks: starving,
      unit: 'm',
      known: [],
    });
  }
  for (const member of result.members) gaps.push(...memberGaps(member, result));
  gaps.push(...projectGaps(result, settings, coverStated));

  // The safety net must not re-ask what the INTERVIEW already answered. When
  // the user has supplied levels or stretch tables, member heights on this
  // sheet DERIVE from those answers — asking three members for a height the
  // person just described as "FDN to +300 with a 900 step" reads as the
  // panel not listening to its own interview.
  const levelAnswered = answeredInterview.some(
    (ex) =>
      ex.answer &&
      (ex.question.kind === 'per_stretch' ||
        (ex.question.writes.scope === 'takeoff' &&
          /level|zone|stretch|height|depth/i.test(ex.question.writes.field))),
  );
  const heightAnsweredFor = new Set(
    answeredInterview
      .filter(
        (ex) =>
          ex.answer && ex.question.writes.scope === 'member' && ex.question.writes.field === 'heightMm',
      )
      .map((ex) => (ex.question.writes.scope === 'member' ? ex.question.writes.mark : '')),
  );
  if (levelAnswered || heightAnsweredFor.size) {
    const kept = gaps.filter(
      (g) =>
        !(
          g.field === 'heightMm' &&
          (levelAnswered || heightAnsweredFor.has(g.subject))
        ),
    );
    gaps.length = 0;
    gaps.push(...kept);
  }

  // The same gate the model's questions pass through: never ask what a
  // declaration on the sheet answers. "C1 — plan length?" beside a drawing
  // that says TYPICAL DETAIL OF C1-350x350 makes the whole panel look like it
  // cannot read — one dumb question poisons trust in every good one. (The
  // dims should have been grounded before this runs; this is the backstop.)
  const declaredPlan = new Set(
    declared.filter((d) => d.dimsMm.length >= 2).map((d) => d.name),
  );
  const filtered = gaps.filter(
    (g) =>
      !(
        g.scope === 'member' &&
        (g.field === 'lengthMm' || g.field === 'widthMm') &&
        declaredPlan.has(g.subject.toUpperCase())
      ),
  );
  gaps.length = 0;
  gaps.push(...filtered);

  // Most blocking first: a question holding up eleven rows is worth answering
  // before one holding up none. Advisory questions sink to the bottom.
  return gaps.sort((a, b) => {
    if (!!a.advisory !== !!b.advisory) return a.advisory ? 1 : -1;
    return b.blocks.length - a.blocks.length;
  });
}

/** How many bar rows are waiting on at least one unanswered question. */
export function blockedRowCount(gaps: Gap[]): number {
  const marks = new Set<string>();
  for (const gap of gaps) for (const m of gap.blocks) marks.add(m);
  return marks.size;
}
