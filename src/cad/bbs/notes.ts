// ============================================================
// The understanding note — what has been read, and how it hangs together.
//
// WHY THIS EXISTS
//
// Until now, "what the run understands" lived as internal state: a list of
// claims, a map of placements, a map of dimensions. Nothing rendered it, so
// nobody — the lead least of all — could see what was still missing until a
// build came back with gaps. Coverage was therefore incidental, and it showed:
// one run claimed thirty-four callouts and totalled 3.0 t, the next claimed ten
// and totalled 1.3 t, both passing the same gates. The tonnage was tracking how
// much of the drawing had been read, not whether the reading was right.
//
// So the reading becomes a DOCUMENT. Every callout appears in it exactly once,
// either owned by a member with a reason, excluded with a reason, or under a
// heading that says NOT YET ACCOUNTED FOR. Every member appears with how it is
// placed, what each of its dimensions was read from, and what steel it carries.
// A gap is not an absence any more; it is a line of text.
//
// AND IT IS RENDERED, NEVER WRITTEN.
//
// The note is generated from the same state the engine builds from, so it
// cannot flatter the run. A note the model composed itself would be prose that
// drifts from the schedule it describes, which is the failure this whole
// codebase is arranged against: a plausible account of work that was not done.
// Every line here is a fact about what has been RECORDED.
//
// WHAT IT DOES NOT DO
//
// It does not decide anything. It states no rule about reinforcement, judges no
// reading, and never says a member "should" be placed one way. It counts what
// is accounted for and names what is not.
// ============================================================
import type { CanonicalMember } from './members';
import type { MemberPlacement } from './placement';
import type { OwnershipClaim } from './ownership';

export interface NoteState {
  drawingName: string;
  /** the lead's own words about what this drawing is, if it has said */
  understanding?: string;
  /** project facts the client stated */
  facts: Readonly<Record<string, { mm: number; saidAs?: string }>>;
  members: readonly CanonicalMember[];
  /** every reinforcement callout the extractor read, with its text */
  callouts: readonly { id: string; text: string }[];
  claims: readonly OwnershipClaim[];
  excluded: readonly { calloutId: string; reason: string }[];
  memberExclusions: ReadonlyMap<string, { mark: string; why: string }>;
  placements: ReadonlyMap<string, MemberPlacement>;
  /** how each placement resolved, in the engine's own words */
  placementWorking?: ReadonlyMap<string, string>;
  dims: ReadonlyMap<string, Partial<Record<'L' | 'W' | 'H', number>>>;
  dimSources: ReadonlyMap<string, Partial<Record<'L' | 'W' | 'H', string>>>;
  shapes: ReadonlyMap<string, string>;
  /** which axes each member's own bars require, from the engine */
  requiredAxes?: ReadonlyMap<string, ('L' | 'W' | 'H')[]>;
  /**
   * Axes the SHEET'S OWN DECLARATION supplies — "C1-350x350" states a
   * cross-section with the authority of a schedule row, and the engine builds
   * from it. Counting only what the model pointed at reported gaps that were
   * not gaps, and would have sent the lead to re-resolve what the drawing
   * already says.
   */
  declaredDims?: ReadonlyMap<string, Partial<Record<'L' | 'W' | 'H', number>>>;
  unresolved: readonly string[];
  escalations: readonly { question: string; whyNeeded: string }[];
  /** what the investigations established, in their own words */
  findings?: readonly { taskId: string; statement: string; evidenceIds: string[] }[];
}

/**
 * Members whose measured axes do not look like a member.
 *
 * Geometry, counted — not a rule about reinforcement. A column recorded as 350
 * on all three axes is a cube, and the sheet does not draw cubes; the run that
 * produced it had pointed the height at the section width. That advisory
 * already existed in the build feedback and was ignored ten times over, so it
 * belongs where the reading itself is judged.
 *
 * It never blocks: a member genuinely square in plan keeps its two equal axes
 * and is not mentioned, and there is no vocabulary for asserting a real cube,
 * so making it fatal would only deadlock an honest reading.
 */
export function axisSuspicions(s: NoteState): string[] {
  const out: string[] = [];
  for (const m of s.members) {
    if (s.memberExclusions.has(m.id)) continue;
    const d = { ...(s.declaredDims?.get(m.id) ?? {}), ...(s.dims.get(m.id) ?? {}) };
    const axes = (['L', 'W', 'H'] as const).map((a) => d[a]).filter((v): v is number => typeof v === 'number' && v > 0);
    if (axes.length < 3) continue;
    const min = Math.min(...axes);
    const max = Math.max(...axes);
    if (max - min > min * 0.02) continue;
    const src = s.dimSources.get(m.id) ?? {};
    const from = Object.entries(src).filter(([, v]) => v).map(([ax, v]) => `${ax} from ${String(v).slice(0, 70)}`);
    out.push(
      `${m.mark} measures ${Math.round(max)} mm on all three axes — a cube. ` +
        (from.length ? `Read from: ${from.join('; ')}. ` : '') +
        'If it is not a cube, one of those axes is pointed at a dimension measuring something else.',
    );
  }
  return out;
}

export interface Completeness {
  complete: boolean;
  calloutsTotal: number;
  calloutsAccounted: number;
  /** callouts neither owned nor excluded — the schedule cannot see this steel */
  unaccountedCallouts: string[];
  /** members carrying steel with no placement — they would count zero */
  membersWithoutPlacement: string[];
  /** members whose own bars need an axis nothing has resolved */
  membersMissingAxes: { mark: string; axes: string[] }[];
  /** what still has to happen, in the order it blocks the schedule */
  missing: string[];
}

/**
 * Is the reading finished?
 *
 * Deliberately mechanical. "Complete" means every callout has a verdict, every
 * member carrying steel knows how it repeats, and every axis its bars need has
 * been resolved. It does NOT mean the reading is correct — nothing here can
 * know that — only that nothing has been left silently unread.
 */
export function assessCompleteness(s: NoteState): Completeness {
  const owned = new Set(s.claims.map((c) => c.calloutId));
  const dropped = new Set(s.excluded.map((e) => e.calloutId));
  const unaccounted = s.callouts.filter((c) => !owned.has(c.id) && !dropped.has(c.id)).map((c) => c.id);

  const carrying = new Map<string, string[]>();
  for (const c of s.claims) {
    carrying.set(c.memberId, [...(carrying.get(c.memberId) ?? []), c.calloutId]);
  }

  const noPlacement: string[] = [];
  const missingAxes: { mark: string; axes: string[] }[] = [];
  for (const m of s.members) {
    if (s.memberExclusions.has(m.id)) continue;
    if (!carrying.has(m.id)) continue;   // nothing owned yet: not a placement gap
    if (!s.placements.has(m.id)) noPlacement.push(m.mark);
    const need = s.requiredAxes?.get(m.id) ?? [];
    const have = { ...(s.declaredDims?.get(m.id) ?? {}), ...(s.dims.get(m.id) ?? {}) };
    const lacking = need.filter((ax) => !(typeof have[ax] === 'number' && (have[ax] as number) > 0));
    if (lacking.length) missingAxes.push({ mark: m.mark, axes: lacking });
  }

  const missing: string[] = [];
  if (unaccounted.length) {
    missing.push(
      `${unaccounted.length} callout(s) are neither owned nor excluded: ${unaccounted.join(', ')}. ` +
        'Steel nobody claimed is steel the schedule cannot see — own it, or exclude it and say why.',
    );
  }
  for (const mark of noPlacement) {
    missing.push(`${mark} owns steel but has no placement, so it would count ZERO however much it owns.`);
  }
  for (const x of missingAxes) {
    missing.push(`${x.mark}'s bars need ${x.axes.join(' and ')}, and nothing has resolved ${x.axes.length > 1 ? 'them' : 'it'}.`);
  }

  return {
    complete: missing.length === 0,
    calloutsTotal: s.callouts.length,
    calloutsAccounted: s.callouts.length - unaccounted.length,
    unaccountedCallouts: unaccounted,
    membersWithoutPlacement: noPlacement,
    membersMissingAxes: missingAxes,
    missing,
  };
}

/** the one-line version, for a prompt that has to stay short */
export function completenessLine(c: Completeness): string {
  return c.complete
    ? `THE NOTE IS COMPLETE: all ${c.calloutsTotal} callouts are accounted for, every member carrying steel is placed, and every axis its bars need is resolved.`
    : `THE NOTE IS NOT COMPLETE: ${c.calloutsAccounted} of ${c.calloutsTotal} callouts accounted for` +
        (c.membersWithoutPlacement.length ? `, ${c.membersWithoutPlacement.length} member(s) unplaced` : '') +
        (c.membersMissingAxes.length ? `, ${c.membersMissingAxes.length} member(s) missing an axis their bars need` : '') +
        '.';
}

// ------------------------------------------------------------
// the note itself
// ------------------------------------------------------------

const bullet = (s: string): string => `- ${s}`;

/**
 * The whole reading, as a document a person can check before anyone prices it.
 *
 * Ordered the way it has to be true: what the drawing is, what each member is
 * and how it repeats, where every callout went, and what is still open.
 */
export function renderUnderstandingNote(s: NoteState, builtAt?: string): string {
  const c = assessCompleteness(s);
  const byMember = new Map<string, OwnershipClaim[]>();
  for (const cl of s.claims) byMember.set(cl.memberId, [...(byMember.get(cl.memberId) ?? []), cl]);
  const textOf = new Map(s.callouts.map((x) => [x.id, x.text]));
  const excludedById = new Map(s.excluded.map((e) => [e.calloutId, e.reason]));

  const lines: string[] = [
    `# What this drawing says — ${s.drawingName}`,
    '',
    builtAt ? `_recorded ${builtAt}_` : '',
    '',
    'Everything below is what has been ESTABLISHED from the drawing, rendered from the record',
    'rather than written up afterwards. Where something is not established it says so.',
    '',
    '## The job',
    '',
    s.understanding ? `> ${s.understanding}` : '_the lead has not yet said what it makes of this drawing_',
    '',
    ...Object.entries(s.facts).map(([k, v]) =>
      bullet(`**${k}** — ${v.mm} mm${v.saidAs ? ` (${v.saidAs})` : ''}, stated by the client, not measured on the sheet`),
    ),
    '',
    '## Completeness',
    '',
    completenessLine(c),
    '',
    ...(c.missing.length ? c.missing.map(bullet) : ['Nothing is outstanding.']),
    '',
    '## The members',
    '',
  ];

  for (const m of s.members) {
    const excl = s.memberExclusions.get(m.id);
    const mine = byMember.get(m.id) ?? [];
    const place = s.placements.get(m.id) as { kind?: string } | undefined;
    const work = s.placementWorking?.get(m.mark) ?? s.placementWorking?.get(m.id);
    const d = s.dims.get(m.id) ?? {};
    const src = s.dimSources.get(m.id) ?? {};

    lines.push(`### ${m.mark}${m.declaredAs ? ` — declared "${m.declaredAs}"` : ''}`);
    lines.push('');
    if (excl) {
      lines.push(`**Not scheduled.** ${excl.why}`);
      lines.push('');
      continue;
    }
    lines.push(
      bullet(
        `its mark is drawn ${m.markEvidenceIds.length} time(s) on the sheet` +
          (m.markEvidenceIds.length ? ` (${m.markEvidenceIds.slice(0, 8).join(', ')}${m.markEvidenceIds.length > 8 ? ', …' : ''})` : ''),
      ),
    );
    lines.push(
      bullet(
        place
          ? `**how it repeats:** ${place.kind}${work ? ` — ${work}` : ''}`
          : '**how it repeats: NOT ESTABLISHED** — it would count zero however much steel it owns',
      ),
    );
    for (const ax of ['L', 'W', 'H'] as const) {
      const v = d[ax];
      lines.push(
        bullet(
          typeof v === 'number' && v > 0
            ? `**${ax}** = ${v} mm${src[ax] ? ` — read from ${src[ax]}` : ' — from the sheet’s own declaration'}`
            : `**${ax}** — not resolved`,
        ),
      );
    }
    lines.push(
      bullet(
        mine.length
          ? `**steel it owns (${mine.length}):**`
          : '**steel it owns:** none has been assigned to it yet',
      ),
    );
    for (const cl of mine) {
      lines.push(
        `    - \`${cl.calloutId}\` ${JSON.stringify(textOf.get(cl.calloutId) ?? '')}` +
          `${cl.barType ? ` as ${cl.barType}` : ''}${cl.distributionAxis ? ` spaced along ${cl.distributionAxis}` : ''}` +
          `${s.shapes.get(cl.calloutId) ? ` shape ${s.shapes.get(cl.calloutId)}` : ''}` +
          `${cl.basis ? ` — because ${cl.basis}` : ''}${cl.reason ? `. ${cl.reason}` : ''}`,
      );
    }
    lines.push('');
  }

  const suspect = axisSuspicions(s);
  if (suspect.length) {
    lines.push('## Geometry worth a second look', '');
    lines.push(...suspect.map(bullet));
    lines.push('');
  }

  lines.push('## Where every callout went', '');
  for (const call of s.callouts) {
    const claim = s.claims.find((x) => x.calloutId === call.id);
    const why = excludedById.get(call.id);
    if (claim) {
      const m = s.members.find((x) => x.id === claim.memberId);
      lines.push(bullet(`\`${call.id}\` ${JSON.stringify(call.text)} → **${m?.mark ?? claim.memberId}**`));
    } else if (why !== undefined) {
      lines.push(bullet(`\`${call.id}\` ${JSON.stringify(call.text)} → **excluded** — ${why}`));
    } else {
      lines.push(bullet(`\`${call.id}\` ${JSON.stringify(call.text)} → **NOT YET ACCOUNTED FOR**`));
    }
  }
  lines.push('');

  if (s.findings?.length) {
    lines.push('## What the investigations found', '');
    for (const f of s.findings.slice(0, 60)) {
      lines.push(bullet(`${f.statement}${f.evidenceIds.length ? ` _(${f.evidenceIds.slice(0, 6).join(', ')})_` : ''}`));
    }
    lines.push('');
  }

  if (s.unresolved.length || s.escalations.length) {
    lines.push('## Still open', '');
    for (const u of s.unresolved) lines.push(bullet(u));
    for (const e of s.escalations) lines.push(bullet(`**for the client:** ${e.question} — ${e.whyNeeded}`));
    lines.push('');
  }

  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
