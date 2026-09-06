// ============================================================
// The live interview — the pure core of "ask in the chat, get asked back".
//
// STUDIO_DESIGN §7. Five modules, none of them touching React, storage or a
// model:
//
//   session.ts   the conversation state machine, and the promise the engine
//                awaits when it runs out of drawing
//   trace.ts     §7.1 — a value enters only as a transcript-traced user fact
//   facts.ts     an answer becomes a SUPPLIED ledger fact and an engine
//                projectFact; a decline becomes a NAMED GAP
//   intent.ts    §7.3 — what the user asked for, in words, deterministically
//   artifact.ts  §7.2 — the assistant carries a reference, never a table
//
// WHAT THIS CORE DELIBERATELY DOES NOT DO: call a model, render a schedule,
// touch the DOM, or write to disk. Everything here is a pure function or a
// value object, so the rules §7 sets can be tested without a network.
// ============================================================

export {
  InterviewSession,
  MAX_QUESTIONS_PER_RUN,
  askUserOf,
  orderQuestions,
  type AnswerOutcome,
  type AnsweredQuestion,
  type AskUser,
  type PendingQuestion,
  type SessionOptions,
  type SessionSnapshot,
  type SessionState,
} from './session';

export {
  DRAWING_REF_KINDS,
  discardReport,
  numberAppears,
  textAppears,
  traceFacts,
  userValueInDrawingRef,
  type AppliedFact,
  type CandidateFact,
  type DiscardedFact,
  type TraceOptions,
  type TraceResult,
  type TranscriptLine,
} from './trace';

export {
  appliedLine,
  axisOfQuestion,
  checkAnswerPatch,
  engineKeyForQuestion,
  escalationQuestion,
  factFromAnswer,
  inferWritesTo,
  factIdForQuestion,
  isDecline,
  namedGap,
  projectFactsFromAnswers,
  recordAnswers,
  toInterviewQuestion,
  typeAnswer,
  type RecordAnswersResult,
  type Supplier,
} from './facts';

export {
  COLUMN_LABELS,
  applyFormatChange,
  classify,
  columnFor,
  evidencedColumns,
  formatChangeIn,
  formatReply,
  vetFormatChange,
  type ClassifyContext,
  type DisplayUnit,
  type FormatChange,
  type FormatOutcome,
  type FormatVerdict,
  type FormatView,
  type GroupBy,
  type Intent,
} from './intent';

export {
  ChatArtifactStore,
  artifactMessageFor,
  assistantTurn,
  questionMessage,
  retypedTableIn,
  versionId,
  type ArtifactRef,
  type ArtifactType,
  type AssistantMessage,
  type ChatArtifact,
  type PublishVerdict,
} from './artifact';

// ============================================================
// integration seam: what the other two edges must implement
//
// This core is deliberately unwired. Two thin edges own the wiring, and each
// is one change in a file this module must not touch.
//
// ------------------------------------------------------------
// SEAM 1 — the engine's blocking callback   (owner: src/cad/bbs/orchestrate.ts)
// ------------------------------------------------------------
//
// Today the loop only RECORDS questions and keeps going:
//
//     for (const q of reply.askUser ?? []) escalations.push(q);      // never waits
//
// so a question raised on turn 4 cannot be answered until the run is over. The
// change is two parts.
//
//   (a) one optional field on OrchestrateOptions:
//
//         /** the live interview, when there is a person in the loop. */
//         askUser?: (question: AskableQuestion) => Promise<string | null>;
//
//       Resolving `null` means "cannot be answered" — declined, capped, or the
//       session ended — and the loop must carry on and report the gap, exactly
//       as it does today. It must never reject: a throw here loses a run over a
//       missing depth.
//
//   (b) at that same point, when `opts.askUser` is present, AWAIT the batch
//       instead of only pushing it:
//
//         const asked = (reply.askUser ?? []).map((q, i) => questionLike(q, i));
//         escalations.push(...(reply.askUser ?? []));      // the record stands
//         if (opts.askUser && asked.length) {
//           const answers = await Promise.all(asked.map((q) => opts.askUser!(q)));
//           // every non-null answer is a USER FACT, and enters as one:
//           //   userFacts[engineKeyForQuestion(q)] = { mm, saidAs }
//           // a null is a NAMED GAP: record it and leave the row unavailable.
//         }
//
//       Registering the whole batch before awaiting is what makes §7.4's
//       "one batch per pass, never drip-fed" true at the engine end; the
//       session orders them by rows unblocked at the UI end.
//
//   The question objects are askFrom.ts's `AskableQuestion` — `questionFrom` /
//   `questionsFrom` already mint them from verification failures with `why`,
//   `blocks`, `evidence`, `answerType` and `writesTo`. A reply-level
//   {question, whyNeeded} carries no target, so lift it with
//   `escalationQuestion(esc, {id, marks: registry.members.map(m => m.mark)})`:
//   it reads a `writesTo` out of the question's own words and returns NULL when
//   it cannot. A null STAYS AN ESCALATION and is never put to a person — a
//   question with no `writesTo` cannot be applied when it is answered, which is
//   how an interview ends with the schedule unchanged.
//
//   An answered value must reach the run as a USER FACT and nothing else —
//   `projectFacts[key] = {mm, saidAs}`, dereferenced by
//   {kind:'user-fact', factId}. It may never be written into an
//   `entity-number`, `table-number`, `difference` or `dimension-path` ref
//   (trace.userValueInDrawingRef refuses exactly that), because those say the
//   number is printed on the sheet.
//
// ------------------------------------------------------------
// SEAM 2 — the Ask tab                     (owner: src/components, src/studio)
// ------------------------------------------------------------
//
//   1. Construct one `InterviewSession` per run and pass `askUserOf(session)`
//      as the engine's `askUser`. Subscribe with `session.subscribe(...)` and
//      render from the snapshot.
//   2. ON UNMOUNT, CALL `session.abandon()`. Every pending question resolves
//      null and the run finishes; without it a closed tab leaves an awaited
//      promise nobody will settle.
//   3. Render each `snapshot().pending` question with an input matched to its
//      `answerType` — choice → buttons (`options`), confirm → yes/no,
//      number-mm / number-m → a numeric field STATING ITS UNIT, table → a
//      small editable grid, text → a line. Show `why`, `blocks` and
//      `evidence` beside it, and `suggestion` with its basis where there is
//      one, never pre-filled.
//   4. Send answers with `session.answer(id, raw)`. `{ok:false, error}` means
//      re-ask with that message — the question STAYS OPEN and no number is
//      coerced. "Skip" / "I don't know" routes to `session.skip(id, raw)`.
//   5. Free-typed messages go through `classify(message, {pendingQuestions})`.
//      A `format-change` intent runs `applyFormatChange` — which re-renders and
//      must NEVER trigger a rebuild — and a refused hide is reported with its
//      `declined` text naming the rows.
//   6. Render results ONLY through the artifact reference:
//      `store.resolve(message.artifact)`. Never print a figure into the
//      message text; `assistantTurn` refuses a message that does.
//   7. Answers become facts with `recordAnswers(ledger, session.answers(),
//      {suppliedBy})` and reach the next run through
//      `projectFactsFromAnswers(session.answers())`. Declines land as MISSING
//      facts — the schedule's named gaps.
//   8. Before applying anything a MODEL relays as a user fact, run
//      `traceFacts(candidates, session.transcript)` and apply only
//      `applied`; report `discardReport(discarded)` back to the model.
// ============================================================

// --- the interview log: what was ASKED, not just what was answered ---------
export {
  buildAuditLog,
  findingsFor,
  auditMarkdown,
  interviewLogsMarkdown,
  numbersIn,
  type AuditEntry,
  type AuditLog,
  type EstablishedBefore,
  type Finding,
  type FindingKind,
} from './audit';
export {
  appendInterviewLog,
  clearInterviewLogs,
  loadInterviewLogs,
  type StoredInterviewLog,
} from './logStore';
