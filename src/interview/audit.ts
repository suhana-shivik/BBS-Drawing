// WHY DID THE INTERVIEW GO THE WAY IT DID?
//
// The ledger keeps every ANSWER. It keeps nothing about the asking: not what
// the sheet already said on the subject, not what the engine's reason for
// asking was, not whether the answer agreed with the drawing. So the three
// questions worth asking about an interview are the three it cannot answer:
//
//   1. WAS IT ALREADY THERE?  A question about a figure printed on the sheet,
//      or already on file, is a question that should never have been put. Each
//      one costs the reader trust as well as time.
//
//   2. DID THE ANSWER CONTRADICT THE DRAWING?  "C1 300x300x2000" is printed in
//      the schedule and the answer given was 300. One of them is wrong, and
//      whichever it is, nothing downstream should be built on it quietly.
//
//   3. WHY DID IT STILL FAIL?  A run that asked, was answered, and produced
//      nothing has a gap between the answer and the arithmetic — and that gap
//      is invisible unless the two are recorded side by side.
//
// EVERYTHING HERE IS DERIVED, NOT CAPTURED SEPARATELY. `AskableQuestion`
// already carries `evidence` — "what the sheet says near this, verbatim, so
// the user can check us" — plus `why`, `blocks` and any `suggestion` with its
// basis. The session keeps the questions and the raw answers. The ledger knows
// what was on file. So this reads those three and reports; there is no second
// record to drift from the first, and no new capture path to go wrong.
//
// It NEVER changes anything. A log that edits is not a log.

import { blockedFacts, resolveFact, type Ledger } from '../facts/ledger';
import type { Fact } from '../facts/types';
import { factIdForQuestion } from './facts';
import type { AnsweredQuestion, PendingQuestion, SessionSnapshot } from './session';
import type { TranscriptLine } from './trace';

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

/** What the drawing and the file already said, at the moment of asking. */
export interface EstablishedBefore {
  /** the ledger id this question writes to */
  factId: string;
  /** the fact already on file, if any — the "we asked for what we had" case */
  onFile: { value: string; unit?: string; state: string; saidAs?: string; suppliedBy?: string } | null;
  /** what the sheet says near this, verbatim, as the engine collected it */
  fromDrawing: string[];
}

export interface AuditEntry {
  at: number;
  questionId: string;
  /** 1 — what the drawing and the record already said */
  established: EstablishedBefore;
  /** 2 — the query the engine raised */
  query: { text: string; why: string; blocks: string[]; answerType: string; options?: string[] };
  /** 3 — what the user said. `null` while the question is still open. */
  answer: { raw: string; skipped: boolean; value?: string; at: number } | null;
  /**
   * 4 — the engine's reasoning, as far as it is recorded.
   *
   * `why` is its stated reason for needing the fact and `suggestion.basis` is
   * its stated reason for the value it proposed. Both are the engine's own
   * words. Where a run records no reasoning this is short, and saying so is
   * better than inventing a narrative for it.
   */
  reasoning: string[];
}

export type FindingKind =
  /** the sheet or the ledger already carried it */
  | 'ASKED-FOR-WHAT-WE-HAD'
  /** the answer disagrees with what the drawing says */
  | 'ANSWER-CONTRADICTS-DRAWING'
  /** answered, and the fact it was meant to settle is still not settled */
  | 'ANSWERED-BUT-STILL-BLOCKED'
  /** nobody answered it */
  | 'LEFT-UNANSWERED';

export interface Finding {
  kind: FindingKind;
  questionId: string;
  factId: string;
  detail: string;
}

export interface AuditLog {
  startedAt: number;
  entries: AuditEntry[];
  findings: Finding[];
  transcript: TranscriptLine[];
}

// ---------------------------------------------------------------------------
// reading a number out of prose
// ---------------------------------------------------------------------------

/**
 * Every number in a line of drawing text, in millimetres as written.
 *
 * Deliberately dumb: it does not try to understand "300x300x2000", it takes
 * 300, 300 and 2000 and lets the comparison decide. A cleverer parser here
 * would be a second interpretation of the drawing competing with the engine's,
 * and the point of this file is to compare, not to re-read.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const token of text.split(/\s+/)) {
    // A TOKEN THAT STARTS WITH LETTERS IS A MARK, NOT A MEASUREMENT.
    //
    // "C1", "M25", "Fe500" name things; their digits are part of the name.
    // Reading the 1 out of C1 made every answer look like it disagreed with a
    // sheet that says "C1 300x300x2000" — the noise would have buried the
    // contradictions this is for. "300x300x2000" starts with a digit and is
    // three measurements, which is why the test is on the TOKEN rather than on
    // whether a letter happens to precede a digit.
    if (/^[A-Za-z]+[\d.]/.test(token)) continue;
    for (const m of token.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

const asNumber = (raw: string): number | null => {
  const ns = numbersIn(raw);
  return ns.length === 1 ? ns[0] : null;
};

// ---------------------------------------------------------------------------
// building the log
// ---------------------------------------------------------------------------

function entryFor(
  question: AnsweredQuestion['question'],
  askedAt: number,
  answered: AnsweredQuestion | null,
  before: Ledger,
): AuditEntry {
  const factId = factIdForQuestion(question);
  const had = resolveFact(before, factId);
  const reasoning = [question.why];
  if (question.suggestion) {
    reasoning.push(
      `suggested ${question.suggestion.value} — ${question.suggestion.basis}`,
    );
  }
  return {
    at: askedAt,
    questionId: question.id,
    established: {
      factId,
      onFile: had ? factSummary(had) : null,
      fromDrawing: [...(question.evidence ?? [])],
    },
    query: {
      text: question.question,
      why: question.why,
      blocks: [...question.blocks],
      answerType: question.answerType,
      ...(question.options ? { options: [...question.options] } : {}),
    },
    answer: answered
      ? {
          raw: answered.raw,
          skipped: answered.skipped,
          ...(answered.patch?.mm !== undefined ? { value: String(answered.patch.mm) } : {}),
          at: answered.at,
        }
      : null,
    reasoning,
  };
}

const factSummary = (f: Fact): NonNullable<EstablishedBefore['onFile']> => ({
  value: String(f.value),
  ...(f.unit ? { unit: f.unit } : {}),
  state: f.state,
  ...(f.saidAs ? { saidAs: f.saidAs } : {}),
  ...(f.suppliedBy ? { suppliedBy: f.suppliedBy } : {}),
});

/**
 * The three questions, answered from the entries.
 *
 * `after` is the ledger AS IT STANDS NOW — what the run left behind. It is
 * what makes finding 3 possible: a question answered whose fact is still
 * blocked is a gap between the answer and the arithmetic.
 */
export function findingsFor(entries: readonly AuditEntry[], after: Ledger): Finding[] {
  const stillBlocked = new Set(blockedFacts(after).map((b) => b.fact.id));
  const out: Finding[] = [];

  for (const e of entries) {
    const { factId } = e.established;

    // 1 — asked for what we had
    if (e.established.onFile && e.established.onFile.state !== 'MISSING') {
      out.push({
        kind: 'ASKED-FOR-WHAT-WE-HAD',
        questionId: e.questionId,
        factId,
        detail: `already on file as ${e.established.onFile.value}${
          e.established.onFile.unit ? ` ${e.established.onFile.unit}` : ''
        } (${e.established.onFile.state}${
          e.established.onFile.suppliedBy ? `, from ${e.established.onFile.suppliedBy}` : ''
        }) when the question was asked`,
      });
    }

    if (!e.answer || e.answer.skipped) {
      if (!e.answer) {
        out.push({
          kind: 'LEFT-UNANSWERED',
          questionId: e.questionId,
          factId,
          detail: `blocked ${e.query.blocks.join(', ') || 'nothing named'}`,
        });
      }
      continue;
    }

    // 2 — the answer against what the sheet says
    const said = asNumber(e.answer.value ?? e.answer.raw);
    if (said !== null && e.established.fromDrawing.length) {
      for (const line of e.established.fromDrawing) {
        const onSheet = numbersIn(line);
        // Only when the sheet gives numbers AND none of them is the answer.
        // A line with no numbers cannot contradict one, and a line that
        // CONTAINS the answer plainly agrees with it.
        if (onSheet.length && !onSheet.includes(said)) {
          out.push({
            kind: 'ANSWER-CONTRADICTS-DRAWING',
            questionId: e.questionId,
            factId,
            detail: `answered ${said}; the sheet says "${line.trim()}"`,
          });
          break;
        }
      }
    }

    // 3 — answered, and still not settled
    if (stillBlocked.has(factId)) {
      out.push({
        kind: 'ANSWERED-BUT-STILL-BLOCKED',
        questionId: e.questionId,
        factId,
        detail: `answered "${e.answer.raw}" and ${factId} is still unresolved — the answer did not reach the arithmetic`,
      });
    }
  }
  return out;
}

/**
 * One session's log.
 *
 * `before` is the ledger as it stood when the run started — that is what makes
 * "we asked for what we had" answerable. `after` is where it ended.
 */
export function buildAuditLog(
  snapshot: SessionSnapshot,
  before: Ledger,
  after: Ledger = before,
  startedAt = Date.now(),
): AuditLog {
  const entries: AuditEntry[] = [
    ...snapshot.answered.map((a) => entryFor(a.question, a.at, a, before)),
    // Still open when the run ended — they are part of the record too, and
    // they are the ones a reader most wants to see.
    ...snapshot.pending.map((p: PendingQuestion) => entryFor(p.question, p.askedAt, null, before)),
  ].sort((a, b) => a.at - b.at);

  return { startedAt, entries, findings: findingsFor(entries, after), transcript: snapshot.transcript };
}

// ---------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------

const HEADINGS: Record<FindingKind, string> = {
  'ASKED-FOR-WHAT-WE-HAD': 'Asked for something already on file',
  'ANSWER-CONTRADICTS-DRAWING': 'The answer disagrees with the drawing',
  'ANSWERED-BUT-STILL-BLOCKED': 'Answered, and still not settled',
  'LEFT-UNANSWERED': 'Never answered',
};

/** The log as Markdown, in the four sections it is meant to be read in. */
export function auditMarkdown(log: AuditLog, drawingName = 'this drawing', at = new Date()): string {
  const started = new Date(log.startedAt);
  const lines: string[] = [
    `# Interview log — ${drawingName}`,
    '',
    `- **Run started:** ${started.toLocaleString('en-IN')}`,
    `- **Questions asked:** ${log.entries.length}`,
    `- **Answered:** ${log.entries.filter((e) => e.answer && !e.answer.skipped).length}`,
    `- **Declined:** ${log.entries.filter((e) => e.answer?.skipped).length}`,
    `- **Exported:** ${at.toLocaleString('en-IN')}`,
    '',
    '---',
    '',
    '# Findings',
    '',
  ];

  if (!log.findings.length) {
    lines.push('Nothing to report: every question was new, every answer agreed with the sheet, and every one of them settled what it was asked for.');
  } else {
    for (const kind of Object.keys(HEADINGS) as FindingKind[]) {
      const of = log.findings.filter((f) => f.kind === kind);
      if (!of.length) continue;
      lines.push(`## ${HEADINGS[kind]} — ${of.length}`, '');
      for (const f of of) lines.push(`- **${f.questionId}** (\`${f.factId}\`) — ${f.detail}`);
      lines.push('');
    }
  }

  lines.push('---', '', '# Questions', '');
  for (const [i, e] of log.entries.entries()) {
    lines.push(
      `## ${i + 1}. ${e.questionId}`,
      '',
      '### 1 — What the drawing and the record already said',
      '',
      e.established.onFile
        ? `- On file: **${e.established.onFile.value}${e.established.onFile.unit ? ` ${e.established.onFile.unit}` : ''}** (${e.established.onFile.state}${e.established.onFile.suppliedBy ? `, from ${e.established.onFile.suppliedBy}` : ''})`
        : `- On file: _nothing — \`${e.established.factId}\` was not established_`,
      ...(e.established.fromDrawing.length
        ? ['- On the sheet, verbatim:', ...e.established.fromDrawing.map((t) => `  - "${t.trim()}"`)]
        : ['- On the sheet: _the engine collected no text for this_']),
      '',
      '### 2 — What was asked',
      '',
      `> ${e.query.text}`,
      '',
      `- Because: ${e.query.why}`,
      `- Blocks: ${e.query.blocks.join(', ') || '_nothing named_'}`,
      `- Expects: ${e.query.answerType}${e.query.options ? ` — one of ${e.query.options.join(' / ')}` : ''}`,
      '',
      '### 3 — What was answered',
      '',
      e.answer
        ? e.answer.skipped
          ? `- **Declined** ("${e.answer.raw}") — recorded as a named gap, not a guess`
          : `- **"${e.answer.raw}"**${e.answer.value ? ` → ${e.answer.value}` : ''}`
        : '- _Never answered_',
      '',
      '### 4 — The engine\'s reasoning',
      '',
      ...(e.reasoning.filter(Boolean).length
        ? e.reasoning.filter(Boolean).map((r) => `- ${r}`)
        : ['- _none recorded for this question_']),
      '',
    );
  }

  if (log.transcript.length) {
    lines.push('---', '', '# Conversation', '');
    for (const t of log.transcript) lines.push(`**${t.role}:** ${t.text}`, '');
  }
  return lines.join('\n');
}

/**
 * Every recorded run of a project, as ONE file.
 *
 * The findings come first and are gathered ACROSS runs, because the patterns
 * worth seeing are the ones that repeat: a question asked for a figure already
 * on file once is an oversight, and the same question asked in four runs
 * running is a bug in what the engine reads.
 */
export function interviewLogsMarkdown(
  logs: readonly (AuditLog & { drawingName: string; artifactId?: string; stoppedBecause?: string })[],
  projectName: string,
  at = new Date(),
): string {
  const all = logs.flatMap((l) => l.findings.map((f) => ({ ...f, run: l.startedAt, drawing: l.drawingName })));
  const lines: string[] = [
    `# Interview log — ${projectName}`,
    '',
    `- **Runs recorded:** ${logs.length}`,
    `- **Questions asked, in total:** ${logs.reduce((n, l) => n + l.entries.length, 0)}`,
    `- **Findings:** ${all.length}`,
    `- **Exported:** ${at.toLocaleString('en-IN')}`,
    '',
    '---',
    '',
    '# Across every run',
    '',
  ];
  if (!all.length) {
    lines.push('Nothing to report across any run on file.');
  } else {
    for (const kind of Object.keys(HEADINGS) as FindingKind[]) {
      const of = all.filter((f) => f.kind === kind);
      if (!of.length) continue;
      lines.push(`## ${HEADINGS[kind]} — ${of.length}`, '');
      // Grouped by fact, so a question asked four times reads as ONE problem
      // with a count rather than four separate lines to be scanned past.
      const byFact = new Map<string, typeof of>();
      for (const f of of) byFact.set(f.factId, [...(byFact.get(f.factId) ?? []), f]);
      for (const [factId, group] of [...byFact].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(
          `- \`${factId}\` — **${group.length} time${group.length === 1 ? '' : 's'}**` +
            ` (${[...new Set(group.map((g) => g.drawing))].join(', ')})`,
          `  - ${group[0].detail}`,
        );
      }
      lines.push('');
    }
  }

  for (const [i, log] of logs.entries()) {
    lines.push(
      '---',
      '',
      `# Run ${logs.length - i} · ${log.drawingName} · ${new Date(log.startedAt).toLocaleString('en-IN')}`,
      '',
      log.artifactId
        ? `Published \`${log.artifactId}\`.`
        : log.stoppedBecause
          ? `Did not publish — ${log.stoppedBecause}`
          : 'Did not publish.',
      '',
      auditMarkdown(log, log.drawingName, at)
        // the per-run file has its own title and its own export stamp; inside
        // a combined file both are noise, so the run's body starts at Findings
        .split('\n# Findings\n')
        .slice(1)
        .join('\n# Findings\n'),
    );
  }
  return lines.join('\n');
}
