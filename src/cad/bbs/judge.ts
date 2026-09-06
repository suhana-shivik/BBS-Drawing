// ============================================================
// The judge — a second reader, once, at the end.
//
// WHY A JUDGE AND NOT ANOTHER GATE
//
// The gates in verify.ts ask whether a schedule is CONSISTENT WITH ITSELF, and
// they are good at it: they caught a tie beam multiplied twelve times, a
// hundred and eighty tonnes hiding behind one unresolved dimension, a column
// standing 350 mm tall. What no gate can ask is whether the schedule is a
// faithful reading OF THE DRAWING, because a gate has no eyes and no judgement.
//
// Run 028 and Run 029 differed by an order of magnitude — 2.4 t against 16 t —
// on one decision: whether the tie beam runs the boundary once or exists twelve
// times over. Both readings were internally consistent. Only the drawing
// settles it, and settling it is a reading, not an arithmetic.
//
// So a second model is shown the drawing, the facts, and the finished
// calculation IN FULL, once, and asked what it makes of them. It is not a vote
// and it is not a tie-breaker: it produces an opinion with reasons, recorded
// beside the schedule for a person to weigh.
//
// WHAT THE JUDGE MAY NOT DO
//
// It may not state a quantity. Not a weight, not a bar count, not a cutting
// length — those are the engine's, computed from what was established, and a
// judge that types a total is doing the one thing this architecture exists to
// prevent. It disputes STRUCTURE: this member is placed wrongly, that height
// measures the wrong thing, these two callouts are the same steel. A dispute
// phrased in the lead engineer's own conclusion vocabulary can be acted on;
// one phrased as a number cannot be, and is refused.
//
// AND IT IS NEVER TOLD WHAT THE ANSWER SHOULD BE. No expected total, no
// reference figure, no steer of any kind. It is given the drawing and the
// working and asked to read them, exactly as the lead was.
// ============================================================
import {
  arrayOf, enumOf, num, object, optional, required, str, validate, explain,
  type Validator,
} from './schema';
import { CONCLUSION } from './orchestrate';
import type { BbsChatResult, BbsChatRow } from './chatResult';

// ------------------------------------------------------------
// what the judge is shown
// ------------------------------------------------------------

export interface JudgeDossier {
  /** the drawing as this system reads it — members, callouts, dimensions, bands */
  drawing: string;
  /** what the client stated, verbatim */
  facts: string;
  /** the finished schedule, in the form a checker reads */
  calculation: string;
  /** how each member was placed and dimensioned, with the working */
  reasoning: string;
  /** what the deterministic gates objected to, if anything */
  objections: string;
}

/**
 * The schedule in the form a bar bending schedule is actually printed.
 *
 * A checker reads a BBS as columns — mark, member, shape, diameter, number,
 * cutting length, total length, weight — and verifies the legs, not the total.
 * The rows already hold every figure; this arranges them the way the trade
 * expects to see them, and computes nothing.
 */
export function renderBbsTable(result: BbsChatResult): string {
  const rows = result.rows as readonly BbsChatRow[];
  if (!rows.length) return '(the schedule has no rows)';

  const n = (v: number | undefined, dp = 0): string =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '—';

  const head = [
    'BAR MARK   MEMBER      TYPE          SHP   DIA   No./MBR  MBRS   TOTAL No.   CUT LEN (mm)   TOTAL (m)   WEIGHT (kg)',
    '-'.repeat(118),
  ];
  const body = rows.map((r) => {
    const desc = r.description || '';
    return (
      `${r.barMark.padEnd(10)} ${r.memberMark.padEnd(11)} ${desc.slice(0, 13).padEnd(13)} ` +
      `${String((r as unknown as { shapeCode?: string }).shapeCode ?? '—').padEnd(5)} ` +
      `${`T${r.diameterMm}`.padEnd(5)} ${n(r.barsPerMember).padStart(7)}  ${n(r.memberCount).padStart(4)}  ` +
      `${n(r.totalBars).padStart(9)}   ${n(r.cuttingLengthMm).padStart(12)}   ${n(r.totalLengthM, 2).padStart(9)}   ` +
      `${n(r.totalWeightKg, 2).padStart(11)}` +
      (r.status === 'unavailable' ? `   [UNAVAILABLE: ${r.note ?? 'a required dimension is unresolved'}]` : '')
    );
  });

  const dia = result.diameterSummary.map(
    (s) =>
      `  T${String(s.diaMm).padEnd(3)} ${String(s.barCount).padStart(6)} bars  ` +
      `${s.totalLengthM.toFixed(1).padStart(10)} m  ${s.totalWeightKg.toFixed(1).padStart(10)} kg` +
      `  (with wastage ${s.totalWeightWithWastageKg.toFixed(1)} kg)`,
  );

  return [
    ...head,
    ...body,
    '-'.repeat(118),
    '',
    'BY DIAMETER',
    ...dia,
    '',
    `NET (no wastage): ${(result.netWeightKg ?? 0).toFixed(1)} kg` +
      `    FOR PROCUREMENT: ${(result.procurementWeightKg ?? 0).toFixed(1)} kg`,
  ].join('\n');
}

/** how every member was placed and measured, and what each figure was read from */
export function renderReasoning(result: BbsChatResult): string {
  return result.members
    .map((m) => {
      const dims = `L ${m.dims.L ?? '—'}  W ${m.dims.W ?? '—'}  H ${m.dims.H ?? '—'}`;
      return [
        `${m.mark}  ×${m.count ?? '—'}   ${dims}   ${Math.round(m.weightKg)} kg over ${m.rowIds.length} row(s)`,
        m.placementWorking ? `    counted: ${m.placementWorking}` : '    counted: (no placement resolved)',
        m.coverMm ? `    cover: ${m.coverMm} mm (${m.coverSource ?? 'unstated'})` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

// ------------------------------------------------------------
// what the judge may say
// ------------------------------------------------------------

/** the things a dispute can be about — the same seams the lead establishes */
export const DISPUTE_SUBJECTS = [
  'placement', 'dimension', 'ownership', 'duplicate', 'exclusion', 'shape', 'other',
] as const;

export interface JudgeReply {
  reading: string;
  verdict: 'sound' | 'disputed' | 'cannot-tell';
  disputes?: {
    subject: string;
    memberMark?: string;
    what: string;
    why: string;
    correction?: string;
    confidence?: number;
  }[];
  confirmed?: string[];
  answer: string;
  confidence?: number;
}

export const JUDGE_REPLY: Validator<JudgeReply> = object(
  {
    reading: required(str({ min: 1 })),
    verdict: required(enumOf(['sound', 'disputed', 'cannot-tell'])),
    disputes: optional(
      arrayOf(
        object(
          {
            subject: required(enumOf(DISPUTE_SUBJECTS)),
            memberMark: optional(str()),
            what: required(str({ min: 1 })),
            why: required(str({ min: 1 })),
            correction: optional(str()),
            confidence: optional(num({ min: 0, max: 1 })),
          },
          { name: 'a dispute' },
        ),
      ),
    ),
    confirmed: optional(arrayOf(str())),
    answer: required(str({ min: 1 })),
    confidence: optional(num({ min: 0, max: 1 })),
  },
  { name: "the checking engineer's verdict" },
);

export const JUDGE_SYSTEM = `You are a second engineer, checking a bar bending schedule someone else produced from a drawing you can both see.

You are given four things: the drawing as the extractor read it, the facts the client stated, the finished schedule with its working, and whatever the automatic checks objected to. You give ONE answer. There is no second turn and nothing to investigate — read what is in front of you and say what you make of it.

## WHAT YOU ARE CHECKING

Not the arithmetic. The engine's multiplication is verified by other means and is not in doubt. What no automatic check can test is whether the schedule READS THE DRAWING CORRECTLY, and that is your whole job:

  Is each member placed as the drawing shows it occurring — once along the job, repeated at nodes, one per something else?
  Does each dimension measure what it is being used for — is a "height" the height, or a cross-section that happens to sit nearby?
  Is each callout owned by the member it labels, and owned ONCE — the same bars drawn in a plan and a section are one set of bars, not two?
  Is anything on the drawing missing from the schedule, or in it that should not be?

## HOW TO SAY IT

Answer with one json object and nothing else — no sentence before it, no note after it:

{"reading":"one or two sentences on what this drawing IS, in your own words",
 "verdict":"sound | disputed | cannot-tell",
 "disputes":[
   {"subject":"placement","memberMark":"TB","what":"…what the schedule did…","why":"…what the drawing shows instead, and how you can tell…",
    "correction":"{\\"kind\\":\\"placement\\",\\"memberId\\":\\"MEM-02\\",\\"placement\\":{\\"kind\\":\\"continuous\\",\\"runFactId\\":\\"run\\"}}","confidence":0.9}],
 "confirmed":["…the parts you checked and believe are right…"],
 "answer":"your overall answer: what this schedule gets right, what it gets wrong, and what a person should do about it",
 "confidence":0.8}

  subject   ${DISPUTE_SUBJECTS.join(' · ')}
  correction  optional, and only if you can phrase it as a conclusion the lead engineer could adopt verbatim

## THE TWO RULES

YOU MAY NOT STATE A QUANTITY. Not a weight, not a bar count, not a cutting length, and not a figure you think the total ought to come to. Every number in a schedule is computed from what was established, and a figure you supply is a figure nobody read off the drawing. Dispute the READING — "the tie beam runs the boundary once, it does not exist twelve times" — and let the arithmetic follow. A dispute that is really a number is worth nothing here.

SAY "cannot-tell" WHEN THAT IS THE TRUTH. You are being asked whether the schedule reads the drawing; if what you have been shown does not settle a question, say so and say what would. An honest "I cannot tell from this" is worth more than a confident guess, and confidently agreeing with a schedule you did not really check is the worst answer available.`;

// ------------------------------------------------------------
// the single call
// ------------------------------------------------------------

export interface JudgeOutcome {
  ok: boolean;
  reply?: JudgeReply;
  /** why nothing usable came back */
  problem?: string;
  /** exactly what was sent, so the verdict can be read against it */
  prompt: string;
  /** corrections that could not be adopted, and why — the dispute still stands */
  unusableCorrections?: { subject: string; memberMark?: string; correction: string; why: string }[];
}

/**
 * A correction is only a correction if the lead could adopt it verbatim.
 *
 * Run 035's judge offered {"kind":"repeated","count":13} — not a placement kind
 * this engine has, and carrying a TYPED COUNT, which is the single thing the
 * whole architecture refuses. It was a free-text field, so nothing looked.
 *
 * Checking it against the lead's own contract does NOT discard the dispute: the
 * reasoning behind a badly-phrased correction may still be sound, and throwing
 * away a real objection because its remedy was malformed would be the same
 * mistake this codebase has now made in four other places. The dispute stands,
 * the correction is reported unusable, and a person decides.
 */
export function checkCorrection(text: string): { ok: boolean; why?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'it is not json, so it cannot be adopted as a conclusion' };
  }
  const checked = validate(parsed, CONCLUSION);
  if (!checked.ok) {
    return {
      ok: false,
      why: checked.problems
        .slice(0, 3)
        .map((p) => `${p.path || 'the correction'} — expected ${p.expected}; received ${p.received}`)
        .join('; '),
    };
  }
  // a count nobody read off the drawing is invention wherever it appears
  if (/"count"\s*:\s*\d/.test(text)) {
    return {
      ok: false,
      why: 'it types a count. A count is derived from a placement and evidence, never stated',
    };
  }
  return { ok: true };
}

export function buildJudgePrompt(d: JudgeDossier): string {
  return [
    '--- THE DRAWING, AS IT WAS READ ---',
    d.drawing,
    '',
    '--- WHAT THE CLIENT STATED ---',
    d.facts,
    '',
    '--- HOW EACH MEMBER WAS PLACED AND MEASURED ---',
    d.reasoning,
    '',
    '--- THE SCHEDULE THAT WAS PRODUCED ---',
    d.calculation,
    '',
    '--- WHAT THE AUTOMATIC CHECKS OBJECTED TO ---',
    d.objections || '(the automatic checks raised nothing)',
    '',
    'Read it and give your one answer.',
  ].join('\n');
}

/**
 * Ask the judge, once.
 *
 * `ask` is the same seam the orchestrator uses, so the caller decides which
 * model answers and how it is logged. A malformed reply is reported, never
 * repaired: this file will not guess what a verdict meant.
 */
export async function runJudge(
  dossier: JudgeDossier,
  ask: (args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    label: string;
  }) => Promise<Record<string, unknown> | null>,
  images: { dataUrl: string; caption: string }[] = [],
): Promise<JudgeOutcome> {
  const prompt = buildJudgePrompt(dossier);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await ask({ system: JUDGE_SYSTEM, prompt, images, label: 'judge' });
  } catch (err) {
    return { ok: false, problem: `the judge could not be reached — ${(err as Error).message}`, prompt };
  }
  if (!raw) return { ok: false, problem: 'the judge returned nothing readable', prompt };

  const checked = validate(raw, JUDGE_REPLY);
  if (!checked.ok) return { ok: false, problem: explain(checked.problems), prompt };

  const unusable: NonNullable<JudgeOutcome['unusableCorrections']> = [];
  for (const d of checked.value.disputes ?? []) {
    if (!d.correction) continue;
    const verdict = checkCorrection(d.correction);
    if (!verdict.ok) {
      unusable.push({ subject: d.subject, memberMark: d.memberMark, correction: d.correction, why: verdict.why! });
    }
  }
  return { ok: true, reply: checked.value, prompt, unusableCorrections: unusable.length ? unusable : undefined };
}

/** the verdict, rendered for the run report */
export function renderVerdict(out: JudgeOutcome): string {
  if (!out.ok) return `**the judge gave no usable verdict** — ${out.problem}`;
  const r = out.reply!;
  return [
    `**verdict:** ${r.verdict}${r.confidence !== undefined ? ` (confidence ${r.confidence})` : ''}`,
    '',
    `> ${r.reading}`,
    '',
    ...(r.disputes?.length
      ? [
          `**disputes (${r.disputes.length}):**`,
          ...r.disputes.map(
            (d) =>
              `- **${d.subject}${d.memberMark ? ` · ${d.memberMark}` : ''}** — ${d.what}\n` +
              `    why: ${d.why}` +
              (d.correction ? `\n    correction offered: \`${d.correction}\`` : ''),
          ),
        ]
      : ['**disputes:** none']),
    '',
    ...(r.confirmed?.length ? ['**confirmed:**', ...r.confirmed.map((c) => `- ${c}`), ''] : []),
    ...(out.unusableCorrections?.length
      ? [
          `**corrections that could NOT be adopted (${out.unusableCorrections.length}) — the disputes still stand:**`,
          ...out.unusableCorrections.map(
            (u) => `- ${u.subject}${u.memberMark ? ` · ${u.memberMark}` : ''}: ${u.correction}` + `
    ${u.why}`,
          ),
          '',
        ]
      : []),
    '**answer:**',
    '',
    r.answer,
  ].join('\n');
}
