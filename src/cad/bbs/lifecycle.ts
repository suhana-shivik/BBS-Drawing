// ============================================================
// Lifecycle traces — where a value was lost, not that it was lost.
//
// Run 002 could say "only T12 and T16 reached the schedule". It could not say
// whether the T8 links were never extracted, never assigned, assigned to the
// wrong member, dropped at shape resolution, rejected by a dimension band, or
// filtered out at build. Six candidate stages, no evidence, and the only way to
// find out was to read a 100 KB log by hand.
//
// The same for dimensions: the model returned pointers for C1, SC, F1 and the
// wall, and the finished schedule showed every dimension unresolved. Somewhere
// between reply and build the values vanished, and nothing recorded where.
//
// So each value carries a LEDGER of the stages it passed through, and the stage
// that dropped it writes down which one it was and why. A gap then names its own
// cause instead of inviting a search.
// ============================================================

export type DimStage =
  | 'model-output'
  | 'parsed'
  | 'absorbed'
  | 'resolved'
  | 'band-checked'
  | 'build-input'
  | 'published';

export interface DimensionTrace {
  memberId: string;
  axis: 'L' | 'W' | 'H';
  /** exactly what the model returned, before any interpretation */
  modelOutput?: unknown;
  /** the reference after parsing, if it survived */
  parsed?: unknown;
  /** the reference stored on the member draft */
  absorbed?: unknown;
  /** what the engine read it as, mm */
  resolvedValue?: number;
  /** the last stage it reached */
  reached: DimStage;
  /** where it stopped, when it stopped */
  rejectedAt?: DimStage;
  rejectionReason?: string;
}

export type CalloutStage =
  | 'extracted'
  | 'offered'
  | 'claimed'
  | 'shaped'
  | 'built'
  | 'published';

export interface CalloutLifecycle {
  calloutId: string;
  raw: string;
  diaMm?: number;
  extracted: boolean;
  /** members that were shown it as a candidate */
  candidateMemberIds: string[];
  /** the member that owns it, once ownership is settled */
  ownerMemberId?: string;
  state?: string;
  shapeCode?: string;
  /** rows in the finished schedule that came from it */
  buildRowIds: string[];
  reached: CalloutStage;
  droppedAt?: CalloutStage;
  reason?: string;
}

export class Ledgers {
  readonly dims = new Map<string, DimensionTrace>();
  readonly callouts = new Map<string, CalloutLifecycle>();

  dimKey(memberId: string, axis: 'L' | 'W' | 'H'): string {
    return `${memberId}.${axis}`;
  }

  /** start a dimension's trace at the moment the model answers */
  dimFromModel(memberId: string, axis: 'L' | 'W' | 'H', modelOutput: unknown): void {
    this.dims.set(this.dimKey(memberId, axis), {
      memberId,
      axis,
      modelOutput,
      reached: 'model-output',
    });
  }

  dimAdvance(memberId: string, axis: 'L' | 'W' | 'H', stage: DimStage, patch: Partial<DimensionTrace> = {}): void {
    const key = this.dimKey(memberId, axis);
    const t = this.dims.get(key);
    if (!t) return;
    Object.assign(t, patch, { reached: stage });
  }

  dimReject(memberId: string, axis: 'L' | 'W' | 'H', stage: DimStage, reason: string): void {
    const t = this.dims.get(this.dimKey(memberId, axis));
    if (!t) return;
    t.rejectedAt = stage;
    t.rejectionReason = reason;
  }

  calloutExtracted(id: string, raw: string, diaMm?: number): void {
    this.callouts.set(id, {
      calloutId: id,
      raw,
      diaMm,
      extracted: true,
      candidateMemberIds: [],
      buildRowIds: [],
      reached: 'extracted',
    });
  }

  calloutOffered(id: string, memberId: string): void {
    const c = this.callouts.get(id);
    if (!c) return;
    if (!c.candidateMemberIds.includes(memberId)) c.candidateMemberIds.push(memberId);
    c.reached = 'offered';
  }

  calloutAdvance(id: string, stage: CalloutStage, patch: Partial<CalloutLifecycle> = {}): void {
    const c = this.callouts.get(id);
    if (!c) return;
    Object.assign(c, patch, { reached: stage });
  }

  calloutDropped(id: string, stage: CalloutStage, reason: string): void {
    const c = this.callouts.get(id);
    if (!c) return;
    c.droppedAt = stage;
    c.reason = reason;
  }
}

// ------------------------------------------------------------
// reporting
// ------------------------------------------------------------

/**
 * Where the steel went, by diameter.
 *
 * The question this exists to answer is "the schedule has no T8 — why", and the
 * answer has to be a STAGE, not a shrug.
 */
export function steelByStage(l: Ledgers): string {
  const byDia = new Map<number, { total: number; reached: Map<string, number> }>();
  for (const c of l.callouts.values()) {
    if (c.diaMm === undefined) continue;
    const hit = byDia.get(c.diaMm) ?? { total: 0, reached: new Map() };
    hit.total++;
    const key = c.droppedAt ? `dropped at ${c.droppedAt}` : c.reached;
    hit.reached.set(key, (hit.reached.get(key) ?? 0) + 1);
    byDia.set(c.diaMm, hit);
  }
  const lines: string[] = [];
  for (const [dia, v] of [...byDia].sort((a, b) => a[0] - b[0])) {
    const detail = [...v.reached].map(([k, n]) => `${n} ${k}`).join(' · ');
    lines.push(`  T${String(dia).padEnd(3)} ${v.total} callout(s): ${detail}`);
  }
  return lines.join('\n') || '  (no callout carried a diameter)';
}

/** Dimensions that started and did not finish, with the stage that stopped them. */
export function lostDimensions(l: Ledgers): string[] {
  const out: string[] = [];
  for (const t of l.dims.values()) {
    if (t.reached === 'published' || t.reached === 'build-input') continue;
    out.push(
      `${t.memberId}.${t.axis}: the model answered, reached "${t.reached}"` +
        (t.rejectedAt ? `, rejected at "${t.rejectedAt}" — ${t.rejectionReason}` : ' and stopped there with no reason recorded'),
    );
  }
  return out;
}

/** The whole picture, for the run log. */
export function formatLifecycles(l: Ledgers): string {
  const lines = ['## Where every value went', '', '### Steel, by diameter and final stage', '```', steelByStage(l), '```', ''];
  const lost = lostDimensions(l);
  lines.push('### Dimensions that did not reach the schedule');
  lines.push('');
  if (!lost.length) lines.push('_every answered dimension reached build input_');
  else for (const s of lost) lines.push(`- ${s}`);
  lines.push('');

  lines.push('### Callout ledger');
  lines.push('');
  lines.push('| Callout | Text | φ | Offered to | Owner | Reached | Dropped at |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of l.callouts.values()) {
    lines.push(
      `| ${c.calloutId} | \`${c.raw}\` | ${c.diaMm ?? '—'} | ${c.candidateMemberIds.length} | ` +
        `${c.ownerMemberId ?? '—'} | ${c.reached} | ${c.droppedAt ?? '—'} |`,
    );
  }
  return lines.join('\n');
}
