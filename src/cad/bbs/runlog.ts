// ============================================================
// The run log — what the machine did, every time it runs.
//
// WHY THIS EXISTS
//
// A 200-second failure produced no evidence about what went wrong. Three
// configurations scored 0.499 t, 1.363 t and 0.965 t and nothing recorded which
// differed. A live run rejected 68 requests in a row and the only way to learn
// why was to instrument it afterwards, by hand, after the fact.
//
// So every run writes a record: what was asked, what came back verbatim, which
// module decided what, what it cost, and what the schedule was at the end. Runs
// ACCUMULATE — a log that is overwritten cannot answer "when did this start
// failing", which is the question that actually gets asked.
//
// THE MODULE TRAIL IS PART OF IT. A schedule is the output of a dozen modules
// and the useful question is usually "which stage produced this?", not "what is
// the total?". Each stage records what it contributed, so a wrong number can be
// traced to the file that produced it rather than guessed at.
//
// PURE. This builds text; it does not write files, because the browser has no
// filesystem and the same record has to serve the Activity view, a test, and a
// CLI. The caller decides where it goes.
// ============================================================

export interface ModuleUse {
  /** the source file, relative to src/ */
  module: string;
  /** what it did on this run, in one line */
  did: string;
  /** anything it measured, for the record */
  detail?: string;
}

export interface LoggedExchange {
  pass: string;
  memberMark?: string;
  taskId?: string;
  attempt?: number;
  prompt: string;
  raw?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  ms: number;
}

export interface LoggedEvent {
  state: string;
  what: string;
  why: string;
}

export interface RunRecord {
  /** monotonically increasing per log, supplied by the caller */
  runNumber: number;
  /** ISO-ish stamp, supplied — never read from a clock in here */
  at: string;
  drawing: string;
  model: string;
  /** what the user supplied that the drawing could not */
  userFacts: Record<string, { mm: number; saidAs?: string }>;
  modules: ModuleUse[];
  events: LoggedEvent[];
  exchanges: LoggedExchange[];
  outcome: {
    status: string;
    netWeightKg?: number;
    procurementWeightKg?: number;
    rows: number;
    members: { mark: string; count?: number; dims: Record<string, number | undefined>; coverMm?: number }[];
    diameters: { diaMm: number; totalWeightKg: number }[];
    passedGates: string[];
    failures: { gate: string; memberMark?: string; field?: string; message: string }[];
  };
  /** total wall-clock, ms */
  ms: number;
}

// null as well as undefined: an unresolved dimension arrives as null from the
// engine, and an undefined-only guard lets it through to `.toFixed`.
const n = (v: number | undefined | null, d = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';

function tokenLine(e: LoggedExchange): string {
  if (e.promptTokens === undefined) return '';
  const think = e.reasoningTokens ? ` (${e.reasoningTokens} reasoning)` : '';
  const cost = e.costUsd ? ` · $${e.costUsd.toFixed(5)}` : '';
  return `${e.promptTokens} → ${e.completionTokens ?? '?'}${think}${cost}`;
}

/**
 * One run, as a person reads it.
 *
 * Ordered by what a reader wants first: the outcome, then what failed, then the
 * traffic. Someone opening this file is almost always asking "what went wrong
 * this time", so the answer is at the top and the evidence follows.
 */
export function formatRun(r: RunRecord): string {
  const L: string[] = [];
  const errors = r.exchanges.filter((e) => e.error);
  const spend = r.exchanges.reduce((a, e) => a + (e.costUsd ?? 0), 0);
  const promptTok = r.exchanges.reduce((a, e) => a + (e.promptTokens ?? 0), 0);
  const outTok = r.exchanges.reduce((a, e) => a + (e.completionTokens ?? 0), 0);
  const thinkTok = r.exchanges.reduce((a, e) => a + (e.reasoningTokens ?? 0), 0);

  L.push(`# Run ${r.runNumber} — ${r.at}`);
  L.push('');
  L.push(`**Drawing:** ${r.drawing}`);
  L.push(`**Model:** ${r.model}`);
  L.push(
    `**Supplied by the user:** ${
      Object.entries(r.userFacts)
        .map(([k, v]) => `${k} = ${v.saidAs ?? `${v.mm} mm`}`)
        .join(', ') || 'nothing'
    }`,
  );
  L.push(`**Wall clock:** ${(r.ms / 1000).toFixed(1)} s`);
  L.push('');

  // ---- outcome first ----
  L.push('## Outcome');
  L.push('');
  L.push(`**${r.outcome.status.toUpperCase()}** · ${r.outcome.rows} row(s)`);
  if (typeof r.outcome.netWeightKg === 'number') {
    L.push(
      `Net ${(r.outcome.netWeightKg / 1000).toFixed(3)} t · ` +
        `procure ${((r.outcome.procurementWeightKg ?? 0) / 1000).toFixed(3)} t`,
    );
  }
  L.push('');
  L.push('| Member | Count | L | W | H | Cover |');
  L.push('|---|---|---|---|---|---|');
  for (const m of r.outcome.members) {
    L.push(
      `| ${m.mark} | ${m.count ?? '—'} | ${n(m.dims.L)} | ${n(m.dims.W)} | ${n(m.dims.H)} | ${n(m.coverMm)} |`,
    );
  }
  L.push('');
  if (r.outcome.diameters.length) {
    L.push(
      `**By diameter:** ${r.outcome.diameters
        .map((d) => `T${d.diaMm} ${d.totalWeightKg.toFixed(1)} kg`)
        .join(' · ')}`,
    );
    L.push('');
  }

  // ---- what the gates said ----
  L.push('## Verification');
  L.push('');
  L.push(`Passed: ${r.outcome.passedGates.join(', ') || 'none'}`);
  if (r.outcome.failures.length) {
    L.push('');
    L.push('Failed:');
    for (const f of r.outcome.failures) {
      L.push(`- **${f.gate}**${f.memberMark ? ` · ${f.memberMark}` : ''}${f.field ? `.${f.field}` : ''} — ${f.message}`);
    }
  }
  L.push('');

  // ---- the traffic, summarised ----
  L.push('## Model traffic');
  L.push('');
  L.push(
    `${r.exchanges.length} call(s), ${errors.length} failed · ` +
      `${promptTok} → ${outTok} tokens` +
      (thinkTok ? ` (${thinkTok} reasoning)` : '') +
      ` · $${spend.toFixed(4)}`,
  );
  L.push('');
  const byPass = new Map<string, { n: number; err: number; think: number }>();
  for (const e of r.exchanges) {
    const hit = byPass.get(e.pass) ?? { n: 0, err: 0, think: 0 };
    hit.n++;
    if (e.error) hit.err++;
    hit.think += e.reasoningTokens ?? 0;
    byPass.set(e.pass, hit);
  }
  L.push('| Pass | Calls | Failed | Reasoning tokens |');
  L.push('|---|---|---|---|');
  for (const [pass, v] of byPass) L.push(`| ${pass} | ${v.n} | ${v.err} | ${v.think} |`);
  L.push('');

  if (errors.length) {
    L.push('### Failures, by cause');
    L.push('');
    const causes = new Map<string, number>();
    for (const e of errors) causes.set(e.error!, (causes.get(e.error!) ?? 0) + 1);
    for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1])) {
      L.push(`- **${count}×** ${cause}`);
    }
    L.push('');
  }

  // ---- the modules ----
  L.push('## What each module contributed');
  L.push('');
  L.push('| Module | Did | Detail |');
  L.push('|---|---|---|');
  for (const m of r.modules) L.push(`| \`${m.module}\` | ${m.did} | ${m.detail ?? ''} |`);
  L.push('');

  // ---- every exchange, verbatim ----
  L.push('## Every exchange, verbatim');
  L.push('');
  for (const [i, e] of r.exchanges.entries()) {
    L.push(
      `### ${i + 1}. ${e.pass}${e.memberMark ? ` · ${e.memberMark}` : ''}` +
        `${e.taskId ? ` (${e.taskId}` : ''}${e.attempt ? `, attempt ${e.attempt})` : e.taskId ? ')' : ''}` +
        ` — ${e.ms} ms`,
    );
    const t = tokenLine(e);
    if (t) L.push(`\`${t}\``);
    L.push('');
    L.push('**Prompt**');
    L.push('```');
    L.push(e.prompt.length > 4000 ? `${e.prompt.slice(0, 4000)}\n… [${e.prompt.length} chars]` : e.prompt);
    L.push('```');
    L.push('');
    L.push('**Reply**');
    L.push('```');
    L.push(e.raw === undefined ? '(nothing came back)' : e.raw === '' ? '(empty string)' : e.raw);
    L.push('```');
    if (e.error) {
      L.push('');
      L.push(`> **Rejected:** ${e.error}`);
    }
    L.push('');
  }

  // ---- the state trail ----
  L.push('## State trail');
  L.push('');
  L.push('```');
  for (const ev of r.events) L.push(`${ev.state.padEnd(22)} ${ev.what}`);
  L.push('```');
  L.push('');

  return L.join('\n');
}

/** The one-line entry appended to the index, so runs are comparable at a glance. */
export function indexLine(r: RunRecord): string {
  const errors = r.exchanges.filter((e) => e.error).length;
  const spend = r.exchanges.reduce((a, e) => a + (e.costUsd ?? 0), 0);
  const net = r.outcome.netWeightKg;
  return (
    `${String(r.runNumber).padStart(4, '0')}  ${r.at}  ` +
    `${r.outcome.status.padEnd(8)} ` +
    `rows=${String(r.outcome.rows).padStart(3)} ` +
    `net=${typeof net !== 'number' ? '—'.padStart(7) : `${(net / 1000).toFixed(3)}t`.padStart(7)} ` +
    `calls=${String(r.exchanges.length).padStart(3)} ` +
    `fail=${String(errors).padStart(3)} ` +
    `$${spend.toFixed(4)} ` +
    `${(r.ms / 1000).toFixed(0)}s  ${r.model}`
  );
}

/**
 * The module trail for a run, assembled from what each stage measured.
 *
 * Written as data rather than scattered log calls so the list stays honest: a
 * module that contributed nothing says so, which is more useful than its
 * absence.
 */
export function moduleTrail(facts: {
  entities: number;
  evidenceNodes: number;
  evidenceDiagnostics: number;
  dimensions: number;
  bands: number;
  bandDiagnostics: number;
  marks: number;
  declared: number;
  callouts: number;
  calloutsParsed: number;
  tasks: number;
  members: number;
  placementsResolved: number;
  coversResolved: number;
  rows: number;
  repairs: number;
  questions: number;
}): ModuleUse[] {
  return [
    { module: 'cad/dxf/parse.ts', did: 'parsed the DXF', detail: `${facts.entities} entities` },
    {
      module: 'cad/bbs/extract.ts',
      did: 'read marks, declarations, callouts and notes',
      detail: `${facts.marks} marks · ${facts.declared} declared · ${facts.calloutsParsed}/${facts.callouts} callouts parsed`,
    },
    {
      module: 'cad/bbs/evidence.ts',
      did: 'indexed the sheet into addressable nodes',
      detail: `${facts.evidenceNodes} nodes · ${facts.dimensions} usable dimensions · ${facts.evidenceDiagnostics} unreadable, recorded`,
    },
    {
      module: 'cad/bbs/bands.ts',
      did: 'recovered layouts from geometry, no model call',
      detail: `${facts.bands} band(s) · ${facts.bandDiagnostics} occurrence(s) left out`,
    },
    {
      module: 'cad/bbs/orchestrator.ts',
      did: 'planned the task DAG from drawing facts',
      detail: `${facts.tasks} tasks over ${facts.members} candidate members`,
    },
    { module: 'cad/bbs/passes.ts', did: 'supplied the narrow pass schemas', detail: '6 passes' },
    { module: 'cad/bbs/passClient.ts', did: 'made the requests', detail: 'one per question' },
    {
      module: 'cad/bbs/sequence.ts + placement.ts',
      did: 'resolved how each member repeats',
      detail: `${facts.placementsResolved}/${facts.members} placements resolved`,
    },
    {
      module: 'cad/bbs/cover.ts',
      did: 'resolved cover per member',
      detail: `${facts.coversResolved}/${facts.members} covers resolved`,
    },
    { module: 'cad/bbs/refs.ts', did: 'dereferenced every dimension pointer', detail: 'scalar · difference · dimension-path' },
    { module: 'cad/bbs/build.ts', did: 'computed the schedule', detail: `${facts.rows} rows` },
    { module: 'cad/bbs/verify.ts', did: 'ran the gates', detail: 'schema · provenance · placement · coverage · completeness · arithmetic · referee' },
    { module: 'cad/bbs/repair.ts', did: 'targeted repairs', detail: `${facts.repairs} attempted` },
    { module: 'cad/bbs/askFrom.ts', did: 'turned exhausted repairs into questions', detail: `${facts.questions} raised` },
    { module: 'cad/bbs/chatResult.ts', did: 'built the immutable artifact', detail: 'what the UI renders' },
  ];
}
