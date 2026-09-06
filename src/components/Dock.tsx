// The detail dock (right column): Details · Ask on the left, the strip's own
// business — Library, Specification, Log — on the right. Ask stays just the
// conversation and its two calculation shortcuts; everything a drafting tool
// or a BBS run needs to reach (arming a catalogue item, the fact ledger, the
// engine's run log) is one click to the right of it, not buried inside the
// thread.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioData,
  type StudioAskSeam,
  type StudioBbsSeam,
  type StudioChatAttachment,
  type StudioChatSeam,
  type StudioData,
} from '../studio/data';
import {
  attachmentFromFile,
  attachmentSize,
  MAX_CHAT_ATTACHMENTS,
  MAX_ATTACHMENTS_BYTES,
} from '../studio/chatAttachments';
import { classify, InterviewSession, type SessionSnapshot } from '../interview';
import type { BbsChatResult } from '../cad/bbs/chatResult';
import type { ScheduleRow } from '../studio/schedule';
import { deriveColumns, scheduleTotalKg, steelSummary } from '../studio/schedule';
import {
  downloadScheduleCsv,
  downloadScheduleXlsx,
  exportColumns,
  workbookGroup,
} from '../studio/exportSchedule';
import { useStudio, useStudioStore, type DockTab, type ScheduleGroup } from '../studio/store';
import { askRunState, patchAskRun, setAskThread, useAskRun } from '../studio/askRun';
import { BbsSheet } from './BbsSheet';
import { toast } from './Toasts';
import { FileProperties } from './FileProperties';
import { Icon } from './icons';
import { LibraryPanel } from './Library';
import { ResizeHandle } from './RegisterPanel';
import { SectionDetailBlock, SectionsBlock, SpecificationTab } from './SectionPanels';
import './Dock.css';

const TABS: { id: DockTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'ask', label: 'Ask' },
];

// The strip's own business, after Ask: arming a tool, the fact ledger scoped
// to this drawing, and the engine's run log. Same row, same tab styling —
// five tabs reading left to right, not two tabs and a separate cluster
// stranded by a gap on the other side of the strip.
const SIDE_TABS: { id: DockTab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'memory', label: 'Specification' },
  { id: 'log', label: 'Log' },
];

export function Dock() {
  const data = useStudioData();
  const store = useStudioStore();
  const { ui, sheets, select, format } = useStudio((s) => ({
    ui: s.ui,
    sheets: s.sheets,
    select: s.select,
    format: s.format,
  }));
  const sheet = sheets.active ? data.sheets[sheets.active] : null;
  const totalKg = scheduleTotalKg(data.scheduleRows);
  const openRows = data.scheduleRows.filter((r) => r.weightKg === null).length;
  const allBlocked = data.scheduleRows.length > 0 && openRows === data.scheduleRows.length;
  // Browsing files, the dock is a properties pane and nothing else: Ask,
  // Specification and Log are all about an OPEN drawing, and there is none —
  // opening one leaves the browser and brings them back with it (§4.3). The
  // dock tab the user last had stays remembered; `bodyTab` just overrides
  // which panel is on screen while the browser has the stage.
  const browsing = ui.stageMode === 'files';
  const tabs = browsing ? TABS.filter((t) => t.id === 'details') : TABS;
  const bodyTab: DockTab | 'files' = browsing
    ? 'files'
    : ui.dockTab;
  // A BBS run or a take-off is still Ask, showing a result — the primary tab
  // stays lit. Library/Specification/Log are their own destinations.
  const insideAsk = bodyTab === 'bbs' || bodyTab === 'qty';
  const visibleTab = insideAsk ? 'ask' : bodyTab;

  return (
    <aside className="dock" aria-label={browsing ? 'Item properties' : 'Drawing detail and assistant'}>
      <ResizeHandle side="left" />
      <div className="dock-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="dtab"
            aria-selected={browsing ? true : visibleTab === t.id}
            onClick={() => store.setDockTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {!browsing &&
          SIDE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="dtab"
              aria-selected={bodyTab === t.id}
              onClick={() => store.setDockTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        {browsing && (
          <button
            type="button"
            className="dock-close"
            title="Close the properties pane"
            aria-label="Close the properties pane"
            onClick={() => store.toggleDock()}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      <div className="dock-body">
        {bodyTab === 'files' && <FileProperties />}
        {bodyTab === 'details' && <DetailsPanel />}

        {bodyTab === 'library' && (
          <section className="dock-panel" role="tabpanel" data-testid="library-panel">
            <LibraryPanel />
          </section>
        )}

        {bodyTab === 'memory' && (
          <section className="dock-panel" role="tabpanel" data-testid="memory-panel">
            <SpecificationTab />
          </section>
        )}

        {bodyTab === 'log' && (
          <section className="dock-panel" role="tabpanel" data-testid="log-panel">
            {/* THE INTERVIEW LOG — what was ASKED, which the ledger has never
                held. It survives the run and every reload, so it is offered
                here whether or not a run is in progress, and it says how many
                runs are in it so the file's size is not a surprise. */}
            {data.bbs?.downloadInterviewLog && (
              <div className="run-log interview-log" data-testid="interview-log">
                <div className="doc-head">
                  <h2 className="doc-title">Interview log</h2>
                  <span className="doc-sub">
                    {data.bbs.interviewLogCount} run
                    {data.bbs.interviewLogCount === 1 ? '' : 's'} on file — what the drawing
                    already said, what was asked, what you answered, and why
                  </span>
                  <button
                    type="button"
                    className="btn"
                    data-testid="download-interview-log"
                    title="Download every recorded interview as one Markdown file"
                    onClick={() => data.bbs!.downloadInterviewLog!()}
                  >
                    <Icon name="download" size={13} />
                    <span>Download .md</span>
                  </button>
                </div>
              </div>
            )}
            {data.bbs && (data.bbs.progress.length || data.bbs.stats || data.bbs.error) ? (
              <div className="run-log">
                <div className="doc-head">
                  <h2 className="doc-title">Run log</h2>
                  <span className="doc-sub">
                    {data.bbs.running ? 'engine running…' : data.bbs.stats ?? 'last run'}
                  </span>
                </div>
                {data.bbs.error && <div className="run-error">{data.bbs.error}</div>}
                <ol className="run-lines">
                  {data.bbs.progress.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="dock-void">
                <span className="vt">Run log</span>
                <span className="vs">
                  Passes, tokens, time and cost are recorded here per engine run — start one
                  from the Ask conversation.
                </span>
              </div>
            )}
          </section>
        )}

        {visibleTab === 'ask' && bodyTab !== 'bbs' && bodyTab !== 'qty' && (
          <section className="dock-panel ask-dock" role="tabpanel" data-testid="ask-panel">
            {data.ask || data.chat ? (
              <AskPanel seam={data.ask} chat={data.chat} />
            ) : (
              <div className="dock-void">
                <span className="vt">Ask about this drawing</span>
                <span className="vs">
                  The conversation drives the same engine as the buttons — and it is the only
                  way your own knowledge enters it. It connects here once the assistant lands.
                </span>
              </div>
            )}
          </section>
        )}

        {bodyTab === 'bbs' && (
          <section className="dock-panel" role="tabpanel" data-testid="bbs-panel">
            <div className="doc-head">
              <h2 className="doc-title">Bar bending schedule</h2>
              <span className="doc-sub">
                {data.scheduleVersion} · IS 2502 bend deductions · Fe500D
                {ui.artifactId ? ' · filed version' : ''}
              </span>
              <div className="chips">
                <span className="chip-s ok">{data.scheduleRows.length} rows</span>
                {/* Pinned to an old version out of Outputs → BBS: say so, and
                    keep the way back on screen beside it. */}
                {ui.artifactId && (
                  <button
                    type="button"
                    className="chip-s link"
                    data-testid="bbs-unpin"
                    title="Show the current schedule instead"
                    onClick={() => store.openArtifact(null)}
                  >
                    show current
                  </button>
                )}
                {/* A fully blocked schedule weighs nothing YET — it does not
                    weigh zero. "0 t" of steel on a wall that plainly carries
                    steel is the number this header may not print (§6.4). */}
                {allBlocked ? (
                  <span className="chip-s warn" data-testid="bbs-tonnage">
                    blocked · {openRows} row{openRows === 1 ? '' : 's'} open
                  </span>
                ) : (
                  <span className="chip-s" data-testid="bbs-tonnage">
                    {(totalKg / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} t
                    {openRows ? ` · ${openRows} open` : ''}
                  </span>
                )}
                <span className="group-switch">
                  group by
                  {(['member', 'dia', 'shape'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={format.group === g ? 'on' : ''}
                      onClick={() => store.setScheduleGroup(g)}
                    >
                      {g === 'dia' ? 'Ø' : g}
                    </button>
                  ))}
                </span>
                <ScheduleDownloads data={data} group={format.group} />
              </div>
            </div>
            {data.bbs && <BbsRunPanel seam={data.bbs} />}
            {/* rows come through StudioData: the engine's BbsChatResult rows
                adapted to ScheduleRow[] in realData.ts. The ledger comes with
                them so a blocked row can name its hole and be answered where
                it stands (§6.4). */}
            <BbsSheet
              rows={data.scheduleRows}
              group={format.group}
              selectedRowIds={select.rows}
              ledger={data.facts?.ledger}
              onAnswerFact={
                data.facts ? (id, value) => void data.facts!.answer(id, value) : undefined
              }
              onRowSelect={(row) =>
                store.setSelection({
                  rows: [row.id],
                  handles: row.handles,
                  memberId: row.mark,
                  source: 'schedule',
                })
              }
            />
          </section>
        )}

        {bodyTab === 'qty' && (
          <section className="dock-panel" role="tabpanel" data-testid="qty-panel">
            {/* integration seam: the take-off panel (§8) is wired by the
                quantities agent — every line opens into its measurement. */}
            <div className="dock-void">
              <span className="vt">Take-off</span>
              <span className="vs">
                Quantities land here once the measurement engine is wired — every line will
                open into the elements measured, the dimensions used and the formula.
              </span>
            </div>
          </section>
        )}

      </div>

      <div className="dock-foot">
        {sheet ? (
          <>
            <span className={`state ${sheet.grounded ? 'ok' : 'idle'}`} />
            <span>{sheet.grounded ? 'Grounded' : 'Not grounded'}</span>
            {sheet.panels.length ? <span>· {sheet.panels.length} panels</span> : null}
          </>
        ) : (
          <span>No sheet open</span>
        )}
      </div>
    </aside>
  );
}

/**
 * The run controls above the schedule: one explicit "Build schedule" action —
 * the engine NEVER runs on page load — plus honest progress and cost. When a
 * run cannot start, the reason is stated in full (missing key, PDF sheet…).
 */
function BbsRunPanel({ seam }: { seam: StudioBbsSeam }) {
  const tail = seam.progress.slice(-4);
  const answered = seam.answersSince.length;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const answer = (id: string, raw: string) => {
    const outcome = seam.answerQuestion?.(id, raw);
    if (outcome && !outcome.ok) {
      setAnswerErrors((prev) => ({ ...prev, [id]: outcome.error }));
      return;
    }
    setAnswerErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // The typed questions, and whether every one of them has something in it.
  // A choice question is not counted: its buttons already answer it.
  const typedPending = (seam.pendingQuestions ?? []).filter(
    ({ question }) => !question.options?.length,
  );
  const allTypedFilled =
    typedPending.length > 0 && typedPending.every(({ question }) => (drafts[question.id] ?? '').trim());

  /**
   * Post every typed answer in one go.
   *
   * The ids are read from the CURRENT pending list rather than from the draft
   * map, so a question the session has already settled cannot be answered
   * twice — and the drafts of settled questions are dropped rather than left
   * to reappear against a later question that happens to share an id.
   */
  const submitAll = () => {
    const ids = typedPending.map(({ question }) => question.id);
    for (const id of ids) answer(id, drafts[id] ?? '');
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  return (
    <div className="bbs-run" data-testid="bbs-run">
      {/* §LIFECYCLE — STALE / REBUILDING / VALIDATED banner */}
      {seam.lifecycleStatus === 'STALE' && !seam.running && (
        <div className="bbs-lifecycle-banner bbs-lifecycle-stale" data-testid="bbs-lifecycle-stale" role="alert">
          <span className="bbs-lifecycle-chip">STALE</span>
          {' '}This schedule used {seam.staleFacts?.length ?? 0} fact{(seam.staleFacts?.length ?? 0) === 1 ? '' : 's'} that {(seam.staleFacts?.length ?? 0) === 1 ? 'has' : 'have'} since changed
          {seam.staleFacts?.length ? ` (${seam.staleFacts.slice(0, 3).join(', ')}${(seam.staleFacts.length > 3) ? ` +${seam.staleFacts.length - 3} more` : ''})` : ''}.
          {' '}Recalculating from the latest facts — the schedule below is NOT current until the rebuild lands.
        </div>
      )}
      {seam.lifecycleStatus === 'REBUILDING' && (
        <div className="bbs-lifecycle-banner bbs-lifecycle-rebuilding" data-testid="bbs-lifecycle-rebuilding" role="status">
          <span className="bbs-lifecycle-chip">REBUILDING</span> Recalculating schedule with updated facts…
        </div>
      )}
      {seam.lifecycleStatus === 'VALIDATED' && !seam.running && (
        <div className="bbs-lifecycle-banner bbs-lifecycle-validated" data-testid="bbs-lifecycle-validated" role="status">
          <span className="bbs-lifecycle-chip">VALIDATED</span> All facts match the build — this schedule is current.
        </div>
      )}
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          disabled={seam.running || seam.blocked !== null}
          onClick={() => seam.run()}
        >
          {seam.running
            ? 'Building…'
            : seam.lifecycleStatus === 'STALE'
              ? 'Rebuild (STALE)'
              : answered > 0
                ? 'Rebuild schedule'
                : 'Build schedule'}
        </button>
        {seam.stats && <span className="run-stats">{seam.stats}</span>}
      </div>
      {/* §6.3 — the loop closes: answers arrived, and the schedule on screen
          was computed without them. Nothing re-runs on its own; a rebuild
          spends model calls, and the price of the last one is restated so the
          decision is made with the number in view. */}
      {!seam.running && answered > 0 && (
        <div className="run-restale" data-testid="bbs-answers-since">
          {answered} answer{answered === 1 ? '' : 's'} {answered === 1 ? 'has' : 'have'} arrived
          since this schedule was built — {seam.answersSince.join(', ')}. This schedule was computed
          without {answered === 1 ? 'it' : 'them'}; rebuild to use {answered === 1 ? 'it' : 'them'}.
          {seam.lastCostLine ? ` A rebuild spends model calls — ${seam.lastCostLine}.` : ' A rebuild spends model calls.'}
        </div>
      )}
      {!seam.running && seam.questionsFiled > 0 && answered === 0 && (
        <div className="run-note" data-testid="bbs-questions-filed">
          {seam.questionsFiled} open question{seam.questionsFiled === 1 ? '' : 's'} from this run
          {seam.questionsFiled === 1 ? ' is' : ' are'} in the Specification — answer{' '}
          {seam.questionsFiled === 1 ? 'it' : 'them'} there or on the blocked row, then rebuild.
        </div>
      )}
      {seam.blocked && !seam.running && <div className="run-blocked">{seam.blocked}</div>}
      {seam.error && <div className="run-error">{seam.error}</div>}
      {!!seam.pendingQuestions?.length && (
        <div className="bbs-interview" data-testid="bbs-live-questions" aria-live="polite">
          <div className="run-note">
            The drawing cannot settle {seam.pendingQuestions.length === 1 ? 'this fact' : 'these facts'}. Answer here and this same run will continue.
          </div>
          {seam.pendingQuestions.map(({ question }) => (
            <div className="bbs-question" key={question.id} data-testid={`bbs-live-question-${question.id}`}>
              <label htmlFor={`bbs-live-answer-${question.id}`}>{question.question}</label>
              <small>{question.why}</small>
              {!!question.blocks.length && <small>Blocks: {question.blocks.join(', ')}</small>}
              {question.options?.length ? (
                <div className="btn-row">
                  {question.options.map((option) => (
                    <button key={option} type="button" className="btn" onClick={() => answer(question.id, option)}>
                      {option}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="bbs-question-answer">
                  <input
                    id={`bbs-live-answer-${question.id}`}
                    aria-label={question.question}
                    inputMode={question.answerType === 'number-count' ? 'numeric' : question.answerType.startsWith('number') ? 'decimal' : 'text'}
                    placeholder={question.answerType === 'number-m' ? 'metres' : question.answerType === 'number-mm' ? 'millimetres' : question.answerType === 'number-count' ? 'how many' : 'answer'}
                    value={drafts[question.id] ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [question.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      // Enter submits the WHOLE set, not just this box — one
                      // question answered out of three restarted the run with
                      // the other two still open.
                      if (e.key === 'Enter' && allTypedFilled) submitAll();
                    }}
                  />
                  <button type="button" className="btn" onClick={() => seam.skipQuestion?.(question.id, "I don't know")}>
                    I don&apos;t know
                  </button>
                </div>
              )}
              {answerErrors[question.id] && <div className="run-error">{answerErrors[question.id]}</div>}
            </div>
          ))}
          {/* ONE HIT FOR ALL OF THEM.
              A "Continue" per card made a three-question run three round
              trips, and each one re-rendered the list underneath the cursor.
              Typed answers are gathered and posted together; a choice question
              still resolves on its button, because clicking an option IS the
              answer and holding it back would be the odd behaviour. */}
          {typedPending.length > 0 && (
            <div className="bbs-question-submit">
              <button
                type="button"
                className="btn primary"
                data-testid="bbs-live-submit-all"
                disabled={!allTypedFilled}
                onClick={submitAll}
              >
                {typedPending.length === 1
                  ? 'Submit answer and continue'
                  : `Submit all ${typedPending.length} answers and continue`}
              </button>
              {!allTypedFilled && (
                <span className="hint-line">
                  fill every box, or press “I don’t know” on the ones you cannot answer
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {seam.running && tail.length > 0 && (
        <ol className="run-lines tail" aria-live="polite">
          {tail.map((line, i) => (
            <li key={`${seam.progress.length}-${i}`}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

type AskMessage =
  | { id: string; role: 'you' | 'assistant'; text: string; attachments?: readonly StudioChatAttachment[] }
  | { id: string; role: 'artifact'; result: BbsChatResult; rows: ScheduleRow[]; ms: number };

/** 0:07 · 1:42 · 12:05 — a stopwatch, so a long run is legible as it runs. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const EMPTY_SESSION: SessionSnapshot = {
  state: 'idle', pending: [], answered: [], transcript: [], questionsAsked: 0, questionsRemaining: 0,
};

/** One conversation for drawing questions, BBS runs and their missing facts. */
/**
 * The schedule, taken away — STUDIO_DESIGN §6.2: "Export mirrors the screen.
 * CSV and XLSX carry exactly the visible columns in the visible order."
 *
 * `src/studio/exportSchedule.ts` had written the workbook and the CSV all
 * along and NOTHING called either: a schedule you could read, file and version
 * — and never take away. These two buttons are the whole of what was missing.
 *
 * The columns handed over are `deriveColumns(rows)`, the exact set the table
 * below derived for itself, and the grouping is the one the switch beside this
 * is showing. A filed version exports as the document it was: `data` already
 * resolves to the PINNED artifact when one is open, so downloading while
 * reading v1 writes v1, under v1's own filename.
 */
function ScheduleDownloads({ data, group }: { data: StudioData; group: ScheduleGroup }) {
  const rows = data.scheduleRows;
  const columns = useMemo(() => deriveColumns(rows), [rows]);
  const result = data.scheduleResult;

  // Rows adapted from fixtures with no engine result behind them cannot be
  // written honestly — say that rather than offering a button that writes an
  // empty workbook.
  if (!result || !rows.length) {
    return (
      <span
        className="chip-s"
        data-testid="bbs-download-none"
        title="Run Calculate BBS to produce a schedule that can be downloaded."
      >
        nothing to download
      </span>
    );
  }

  const input = {
    result,
    columns: exportColumns(columns),
    groupBy: workbookGroup(group),
    ...(data.scheduleProvenance ? { provenance: data.scheduleProvenance } : {}),
    ...(data.scheduleVersionNo ? { version: data.scheduleVersionNo } : {}),
  };

  return (
    <span className="dl-group">
      <button
        type="button"
        className="chip-s dl"
        data-testid="bbs-download-xlsx"
        title="Download this schedule as an Excel workbook"
        onClick={() => toast(`Downloaded ${downloadScheduleXlsx(input)}`, 'ok')}
      >
        <Icon name="download" size={12} /> Excel
      </button>
      <button
        type="button"
        className="chip-s dl"
        data-testid="bbs-download-csv"
        title="Download the same grid as CSV"
        onClick={() => toast(`Downloaded ${downloadScheduleCsv(input)}`, 'ok')}
      >
        CSV
      </button>
    </span>
  );
}

/**
 * The schedule in the thread, taken away — the same grid, the same columns and
 * the same filename `ScheduleDownloads` writes from the BBS tab, but built
 * from THIS message's own result so an older answer in the thread exports as
 * the document it was, not as whatever the tab is showing now.
 */
function ArtifactDownloads({
  result,
  rows,
  data,
  group,
}: {
  result: BbsChatResult;
  rows: ScheduleRow[];
  data: StudioData;
  group: ScheduleGroup;
}) {
  const columns = useMemo(() => deriveColumns(rows), [rows]);
  if (!rows.length) return null;
  const input = {
    result,
    columns: exportColumns(columns),
    groupBy: workbookGroup(group),
    ...(data.scheduleProvenance ? { provenance: data.scheduleProvenance } : {}),
  };
  return (
    <span className="dl-group">
      <button
        type="button"
        className="chip-s dl"
        data-testid="bbs-chat-download-xlsx"
        title="Download this schedule as an Excel workbook"
        onClick={() => toast(`Downloaded ${downloadScheduleXlsx(input)}`, 'ok')}
      >
        <Icon name="download" size={12} /> Excel
      </button>
      <button
        type="button"
        className="chip-s dl"
        data-testid="bbs-chat-download-csv"
        title="Download the same grid as CSV"
        onClick={() => toast(`Downloaded ${downloadScheduleCsv(input)}`, 'ok')}
      >
        CSV
      </button>
    </span>
  );
}

function AskPanel({ seam, chat }: { seam?: StudioAskSeam; chat?: StudioChatSeam }) {
  const store = useStudioStore();
  const data = useStudioData();
  const selection = useStudio((s) => s.select);
  const format = useStudio((s) => s.format);
  // THE RUN LIVES OUTSIDE THIS COMPONENT.
  //
  // This panel unmounts the moment you open Details, Library, Specification or
  // Log — and it used to take the conversation, the interview session and the
  // in-flight request with it, abandoning a run that was minutes and several
  // questions deep because somebody clicked a tab to look at the drawing it
  // was asking about. A run is work in flight, not view state, so `askRun`
  // holds it and this panel is a window onto it.
  useAskRun();
  const run = askRunState<AskMessage>();
  const thread = run.thread;
  const busy = run.busy;
  const session = run.session;
  const snapshot = run.snapshot;
  const setThread = (next: AskMessage[] | ((prev: AskMessage[]) => AskMessage[])) =>
    setAskThread(typeof next === 'function' ? next(askRunState<AskMessage>().thread) : next);
  const setBusy = (v: boolean) => patchAskRun({ busy: v });
  const setSession = (v: InterviewSession | null) => patchAskRun({ session: v });
  const setSnapshot = (v: SessionSnapshot) => patchAskRun({ snapshot: v });
  const [draft, setDraft] = useState('');
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [questionError, setQuestionError] = useState<string | null>(null);
  // Evidence for a specific pending question — a photo of the nameplate, say.
  // It rides along in the transcript once that answer is submitted; §7.4
  // still requires the typed value, because nothing here reads a photo into a
  // measurement (interview/facts.ts — "typed, always").
  const [questionAttachments, setQuestionAttachments] = useState<Record<string, StudioChatAttachment[]>>({});
  const [questionAttachError, setQuestionAttachError] = useState<Record<string, string>>({});
  const [attachingQuestion, setAttachingQuestion] = useState<string | null>(null);
  const [fileTargetQuestion, setFileTargetQuestion] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<StudioChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [slowResponse, setSlowResponse] = useState(false);
  // A BBS run takes minutes. It says how many, ticking, while it runs —
  // "building…" with no clock is indistinguishable from a hang.
  const runStartedAt = run.startedAt;
  const setRunStartedAt = (v: number | null) => patchAskRun({ startedAt: v });
  const [tick, setTick] = useState(() => Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  // Both live in the store now, so a remount cannot orphan an in-flight
  // request or lose the session a pending question belongs to.
  const sessionRef = { get current() { return askRunState<AskMessage>().session; },
    set current(v: InterviewSession | null) { patchAskRun({ session: v }); } };
  const requestRef = { get current() { return askRunState<AskMessage>().controller; },
    set current(v: AbortController | null) { patchAskRun({ controller: v }); } };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionFileInputRef = useRef<HTMLInputElement>(null);

  // NO UNMOUNT KILL. Navigating away from this panel is not a decision about
  // the run — the run is ended by starting another one, or by the project
  // closing, and both of those are acts somebody performed on purpose.

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread, busy, snapshot.pending.length]);
  useEffect(() => {
    if (runStartedAt === null) return;
    setTick(Date.now());
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runStartedAt]);

  const addText = (role: 'you' | 'assistant', text: string, files?: readonly StudioChatAttachment[]) => {
    setThread((items) => [...items, { id: `${Date.now()}-${items.length}`, role, text, ...(files?.length ? { attachments: files } : {}) }]);
  };

  const addFiles = async (files: FileList | readonly File[]) => {
    const selected = [...files];
    if (!selected.length) return;
    if (attachments.length + selected.length > MAX_CHAT_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_CHAT_ATTACHMENTS} files in one message.`);
      return;
    }
    if (attachments.reduce((sum, item) => sum + item.size, 0) + selected.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_BYTES) {
      setAttachmentError('Attachments in one message can total up to 30 MB.');
      return;
    }
    setAttaching(true);
    setAttachmentError(null);
    try {
      const added: StudioChatAttachment[] = [];
      for (const file of selected) added.push(await attachmentFromFile(file));
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Evidence for one pending question — same caps as the composer's own. */
  const addFilesForQuestion = async (questionId: string, files: FileList | readonly File[]) => {
    const selected = [...files];
    if (!selected.length) return;
    const current = questionAttachments[questionId] ?? [];
    if (current.length + selected.length > MAX_CHAT_ATTACHMENTS) {
      setQuestionAttachError((e) => ({ ...e, [questionId]: `Attach up to ${MAX_CHAT_ATTACHMENTS} files per answer.` }));
      return;
    }
    const bytesSoFar = current.reduce((sum, item) => sum + item.size, 0);
    const bytesIncoming = selected.reduce((sum, file) => sum + file.size, 0);
    if (bytesSoFar + bytesIncoming > MAX_ATTACHMENTS_BYTES) {
      setQuestionAttachError((e) => ({ ...e, [questionId]: 'Attachments for one answer can total up to 30 MB.' }));
      return;
    }
    setAttachingQuestion(questionId);
    setQuestionAttachError((e) => { const next = { ...e }; delete next[questionId]; return next; });
    try {
      const added: StudioChatAttachment[] = [];
      for (const file of selected) added.push(await attachmentFromFile(file));
      setQuestionAttachments((cur) => ({ ...cur, [questionId]: [...(cur[questionId] ?? []), ...added] }));
    } catch (err) {
      setQuestionAttachError((e) => ({ ...e, [questionId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setAttachingQuestion(null);
      if (questionFileInputRef.current) questionFileInputRef.current.value = '';
    }
  };

  const answerQuestion = (questionId: string, raw: string, files?: readonly StudioChatAttachment[]) => {
    if (!session || !raw.trim()) return;
    const outcome = session.answer(questionId, raw);
    if (!outcome.ok) { setQuestionError(outcome.error); return; }
    setQuestionError(null);
    setQuestionDrafts((current) => ({ ...current, [questionId]: '' }));
    if (files?.length) {
      setQuestionAttachments((current) => { const next = { ...current }; delete next[questionId]; return next; });
    }
    addText('you', raw.trim(), files);
  };

  const skipQuestion = (questionId: string) => {
    if (!session) return;
    session.skip(questionId, "I don't know");
    addText('you', "I don't know");
  };

  /**
   * One hit for every question on screen — not one "Continue" per question.
   * Choice questions (buttons, not a typed field) already resolve on click;
   * this only sweeps the free-text ones that still have a filled-in draft.
   */
  const submitAllAnswers = () => {
    for (const { question } of snapshot.pending) {
      if (question.options?.length) continue;
      const raw = questionDrafts[question.id] ?? '';
      if (!raw.trim()) continue;
      answerQuestion(question.id, raw, questionAttachments[question.id]);
    }
  };

  const buildBbs = async (request: string, memberMark?: string, files: readonly StudioChatAttachment[] = []) => {
    if (!chat) { addText('assistant', 'BBS chat is not connected in this workspace yet.'); return; }
    if (chat.blocked) { addText('assistant', chat.blocked); return; }
    sessionRef.current?.abandon('a new BBS request was started');
    const nextSession = new InterviewSession();
    nextSession.say('user', request);
    sessionRef.current = nextSession;
    setSession(nextSession);
    setSnapshot(nextSession.snapshot());
    const unsubscribe = nextSession.subscribe(setSnapshot);
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setBusy(true);
    try {
      const outcome = await chat.start({ session: nextSession, ...(memberMark ? { memberMark } : {}), ...(files.length ? { attachments: files } : {}) });
      const applied = await chat.recordAnswers(nextSession.answers());
      await chat.logInterview(nextSession, { artifactId: outcome.result.id });
      nextSession.publish(outcome.result.id);
      setThread((items) => [
        ...items,
        ...(applied.length ? [{ id: `${Date.now()}-facts`, role: 'assistant' as const, text: applied.join('\n') }] : []),
        {
          id: `${Date.now()}-bbs`,
          role: 'artifact' as const,
          result: outcome.result,
          rows: chat.adaptRows(outcome.result),
          ms: Date.now() - startedAt,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged BEFORE the failure is reported, so the questions it asked and
      // the answers it got survive whatever went wrong after them.
      await chat.logInterview(nextSession, { stoppedBecause: message });
      nextSession.fail(message);
      addText('assistant', `I couldn't complete the BBS: ${message}`);
    } finally {
      unsubscribe();
      setBusy(false);
      setRunStartedAt(null);
      setSession(null);
      sessionRef.current = null;
      setSnapshot(EMPTY_SESSION);
    }
  };

  const send = async () => {
    // Two or more questions are answered above, together, with one Submit —
    // the bottom bar stays for the conversation and does not quietly answer
    // just the first of them.
    if (snapshot.pending.length > 1) return;
    const question = draft.trim() || (attachments.length ? 'Review the attached evidence.' : '');
    if (!question || attaching || (busy && snapshot.pending.length === 0)) return;
    const sentAttachments = attachments;
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    if (snapshot.pending.length && session) { answerQuestion(snapshot.pending[0].question.id, question); return; }
    addText('you', question, sentAttachments);
    const intent = classify(question);
    if (intent.kind === 'build-schedule') { await buildBbs(question, intent.memberMark, sentAttachments); return; }
    if (/\b(qty|quantity|quantities|take[ -]?off)\b/i.test(question)) {
      addText('assistant', 'Quantity take-off now lives in this conversation, but its deterministic measurement engine is not connected yet. I will not invent quantities. BBS calculation is available here now.');
      return;
    }
    if (!seam) { addText('assistant', 'Drawing Q&A is not connected in this workspace yet.'); return; }
    if (seam.blocked) { addText('assistant', seam.blocked); return; }
    const controller = new AbortController();
    requestRef.current = controller;
    setSlowResponse(false);
    const slowTimer = setTimeout(() => setSlowResponse(true), 25_000);
    setBusy(true);
    try { addText('assistant', await seam.ask(question, sentAttachments, controller.signal)); }
    catch (err) { addText('assistant', `That failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally {
      clearTimeout(slowTimer);
      requestRef.current = null;
      setSlowResponse(false);
      setBusy(false);
    }
  };

  // "Submit all N answers" enables once every typed field is filled — a
  // decline ("I don't know") is a separate, immediate action per question,
  // not one this batch waits on.
  const freeTextPending = snapshot.pending.filter(({ question }) => !question.options?.length);
  const allFreeTextFilled =
    freeTextPending.length > 0 &&
    freeTextPending.every(({ question }) => (questionDrafts[question.id] ?? '').trim().length > 0);
  const multiPending = snapshot.pending.length > 1;

  return (
    <div className="ask-panel" data-testid="ask-thread">
      <div className="ask-thread">
        {thread.length === 0 && (
          <div className="ask-welcome">
            <span className="vt">Ask about this drawing</span>
            <span className="vs">Ask a question, request a BBS, or start a quantity take-off. If a calculation needs a fact the drawing does not provide, I will ask you here.</span>
            <div className="ask-suggestions" aria-label="Suggested requests">
              <button
                type="button"
                className="ask-chip"
                onClick={() => setDraft('Calculate the BBS for this drawing')}
              >
                <Icon name="schedule" size={13} />
                Calculate BBS
              </button>
              <button
                type="button"
                className="ask-chip"
                onClick={() => setDraft('Calculate quantities for this drawing')}
              >
                <Icon name="measure" size={13} />
                Calculate quantities
              </button>
            </div>
          </div>
        )}
        {thread.map((m, i) => m.role === 'artifact' ? (
          <div key={m.id} className="ask-artifact" data-testid="bbs-chat-artifact">
            <div className="ask-artifact-head"><div><span className="artifact-kicker">BBS result</span><strong>Bar bending schedule</strong></div><span className={`artifact-status ${m.result.status}`}>{m.result.status}</span></div>
            <div className="artifact-summary">
              <span>{m.rows.length} rows</span>
              <span>{m.result.netWeightKg == null ? 'weight pending' : `${m.result.netWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg`}</span>
              {m.result.gaps.length > 0 && <span>{m.result.gaps.length} open facts</span>}
              {/* What it took, said once, where the result is read (§6.1). */}
              <span data-testid="bbs-chat-elapsed">built in {clock(m.ms)}</span>
              {i === thread.length - 1 && data.bbs?.lastCostLine ? <span>{data.bbs.lastCostLine}</span> : null}
            </div>
            {/* Filed the moment it was built — and takeable from right here,
                as the same workbook the BBS folder lists (§6.2). */}
            <div className="artifact-filed">
              <span>Filed in Outputs → BBS</span>
              <ArtifactDownloads result={m.result} rows={m.rows} data={data} group={format.group} />
            </div>
            <BbsSheet rows={m.rows} group="member" selectedRowIds={selection.rows} ledger={data.facts?.ledger} onAnswerFact={data.facts ? (id, value) => void data.facts!.answer(id, value) : undefined} onRowSelect={(row) => store.setSelection({ rows: [row.id], handles: row.handles, memberId: row.mark, source: 'schedule' })} />
          </div>
        ) : (
          <div key={m.id} className={`ask-msg ${m.role}`}>
            <span className="who">{m.role === 'you' ? 'You' : 'Assistant'}</span>
            <span className="text">{m.text}</span>
            {!!m.attachments?.length && (
              <div className="sent-attachments">
                {m.attachments.map((attachment) => (
                  <div className="sent-attachment" key={attachment.id}>
                    {attachment.kind === 'image' ? <img src={attachment.dataUrl} alt={attachment.name} /> : <Icon name="file" size={14} />}
                    <span><strong>{attachment.name}</strong><small>{attachment.kind === 'spreadsheet' ? 'Spreadsheet' : attachment.mimeType || 'File'} · {attachmentSize(attachment.size)}</small></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {snapshot.pending.length > 0 && (
          <div className="ask-questions" data-testid="chat-questions">
            <span className="who">
              {snapshot.pending.length === 1 ? 'Assistant needs one fact' : `Assistant needs ${snapshot.pending.length} facts`}
            </span>
            {snapshot.pending.map(({ question }) => {
              const files = questionAttachments[question.id] ?? [];
              return (
                <div className="ask-question" key={question.id} data-testid={`chat-question-${question.id}`}>
                  <strong>{question.question}</strong>
                  <span className="question-why">{question.why}</span>
                  {question.options?.length ? (
                    <div className="ask-question-options">
                      {question.options.map((option) => (
                        <button type="button" key={option} onClick={() => answerQuestion(question.id, option)}>
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div className="ask-question-answer">
                        <input
                          aria-label={question.question}
                          inputMode={question.answerType === 'number-count' ? 'numeric' : question.answerType.startsWith('number') ? 'decimal' : 'text'}
                          placeholder={question.answerType === 'number-m' ? 'Enter metres' : question.answerType === 'number-mm' ? 'Enter millimetres' : question.answerType === 'number-count' ? 'How many?' : 'Type your answer'}
                          value={questionDrafts[question.id] ?? ''}
                          onChange={(event) => setQuestionDrafts((current) => ({ ...current, [question.id]: event.target.value }))}
                          onKeyDown={(event) => { if (event.key === 'Enter' && allFreeTextFilled) submitAllAnswers(); }}
                        />
                        <button
                          type="button"
                          className="attach-button"
                          disabled={attachingQuestion === question.id}
                          onClick={() => { setFileTargetQuestion(question.id); questionFileInputRef.current?.click(); }}
                          aria-label="Attach a photo to this answer"
                          title="Attach a photo as evidence — the typed answer above is still what gets recorded"
                        >
                          <Icon name="paperclip" size={14} />
                        </button>
                      </div>
                      {!!files.length && (
                        <div className="pending-attachments" aria-label="Evidence for this answer">
                          {files.map((attachment) => (
                            <div className="pending-attachment" key={attachment.id}>
                              {attachment.kind === 'image' ? <img src={attachment.dataUrl} alt="" /> : <Icon name="file" size={14} />}
                              <span title={attachment.name}>{attachment.name}</span>
                              <small>{attachmentSize(attachment.size)}</small>
                              <button
                                type="button"
                                aria-label={`Remove ${attachment.name}`}
                                onClick={() => setQuestionAttachments((current) => ({ ...current, [question.id]: (current[question.id] ?? []).filter((item) => item.id !== attachment.id) }))}
                              >
                                <Icon name="close" size={11} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {questionAttachError[question.id] && <div className="attachment-error" role="alert">{questionAttachError[question.id]}</div>}
                    </>
                  )}
                  <button type="button" className="ask-skip" onClick={() => skipQuestion(question.id)}>I don&apos;t know</button>
                </div>
              );
            })}
            {questionError && <span className="run-error">{questionError}</span>}
            {freeTextPending.length > 0 && (
              <button type="button" className="btn primary ask-submit-all" disabled={!allFreeTextFilled} onClick={submitAllAnswers}>
                {freeTextPending.length === 1 ? 'Submit answer' : `Submit all ${freeTextPending.length} answers`}
              </button>
            )}
            <input
              ref={questionFileInputRef}
              className="attachment-picker"
              type="file"
              multiple
              aria-label="Choose a photo for this answer"
              onChange={(event) => { if (fileTargetQuestion) void addFilesForQuestion(fileTargetQuestion, event.target.files ?? []); }}
            />
          </div>
        )}
        {/* A run in flight, with its clock. The engine's own progress lines
            stream underneath: what pass it is on, and what each call cost. */}
        {busy && chat?.running && !snapshot.pending.length ? (
          <div className="ask-run" data-testid="ask-run" role="status" aria-live="polite">
            <div className="read-loader">
              <span className="spinner" aria-hidden="true" />
              <span className="rl-text">
                <b>Building the bar bending schedule…</b>
                <span className="rl-sub">
                  {runStartedAt === null ? 'starting' : `${clock(tick - runStartedAt)} elapsed`}
                  {data.bbs?.progress.length ? ` · ${data.bbs.progress.length} steps so far` : ''}
                  {' · a full run usually takes a few minutes'}
                </span>
              </span>
            </div>
            {data.bbs && data.bbs.progress.length > 0 && (
              <ol className="run-lines tail">
                {data.bbs.progress.slice(-4).map((line, i) => (
                  <li key={`${data.bbs!.progress.length}-${i}`}>{line}</li>
                ))}
              </ol>
            )}
          </div>
        ) : busy ? (
          <div className="ask-msg assistant"><span className="who">Assistant</span><span className="text">{snapshot.pending.length ? 'waiting for your answer…' : slowResponse ? 'the model is taking longer than usual…' : 'reading the drawing…'}</span></div>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="ask-composer">
        {!!attachments.length && (
          <div className="pending-attachments" aria-label="Files ready to send">
            {attachments.map((attachment) => (
              <div className="pending-attachment" key={attachment.id}>
                {attachment.kind === 'image' ? <img src={attachment.dataUrl} alt="" /> : <Icon name="file" size={14} />}
                <span title={attachment.name}>{attachment.name}</span>
                <small>{attachmentSize(attachment.size)}</small>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><Icon name="close" size={11} /></button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error" role="alert">{attachmentError}</div>}
        <div className="ask-input">
          <input ref={fileInputRef} className="attachment-picker" type="file" multiple aria-label="Choose attachments" onChange={(event) => void addFiles(event.target.files ?? [])} />
          <button type="button" className="attach-button" disabled={attaching || busy} onClick={() => fileInputRef.current?.click()} aria-label="Attach files" title="Attach images, Excel, PDF or other files"><Icon name="paperclip" size={15} /></button>
          <input type="text" placeholder={multiPending ? 'Answer the questions above, then press Submit…' : snapshot.pending.length ? 'Answer the question above…' : attachments.length ? 'Add a message about these files…' : 'Ask about the drawing or calculate BBS…'} aria-label="Ask about this drawing" value={draft} disabled={multiPending || (busy && snapshot.pending.length === 0)} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
          {busy && requestRef.current && !chat?.running ? (
            <button type="button" className="stop-response" onClick={() => requestRef.current?.abort('stopped by user')} aria-label="Stop response" title="Stop waiting"><Icon name="close" size={12} /></button>
          ) : (
            <button type="button" className="btn primary" disabled={multiPending || attaching || (busy && snapshot.pending.length === 0) || (!draft.trim() && !attachments.length)} onClick={() => void send()} aria-label="Send"><Icon name="chevronRight" size={13} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailsPanel() {
  const data = useStudioData();
  const store = useStudioStore();
  const sheets = useStudio((s) => s.sheets);
  const sheet = sheets.active ? data.sheets[sheets.active] : null;

  if (!sheet) {
    return (
      <section className="dock-panel" role="tabpanel" data-testid="details-panel">
        <div className="dock-void">
          <span className="vt">Nothing open</span>
          <span className="vs">Open a drawing from the register to see what is on file against it.</span>
        </div>
      </section>
    );
  }

  const summary = steelSummary(data.scheduleRows);
  const maxKg = Math.max(...summary.map((s) => s.weightKg), 1);
  const totalKg = scheduleTotalKg(data.scheduleRows);
  const openRows = data.scheduleRows.filter((r) => r.weightKg === null).length;
  const allBlocked = data.scheduleRows.length > 0 && openRows === data.scheduleRows.length;

  return (
    <section className="dock-panel" role="tabpanel" data-testid="details-panel">
      <div className="doc-head">
        <h2 className="doc-title">{sheet.title}</h2>
        <span className="doc-sub">
          {sheet.number} · Rev {sheet.rev} · {sheet.discipline}
        </span>
        <div className="chips">
          {sheet.grounded ? (
            <span className="chip-s ok">
              <span className="state ok" /> Grounded
            </span>
          ) : (
            <span className="chip-s">Not grounded</span>
          )}
          {sheet.panels.length ? <span className="chip-s info">{sheet.panels.length} panels indexed</span> : null}
          {sheet.issues ? <span className="chip-s warn">{sheet.issues} issues</span> : null}
        </div>
      </div>

      <div className="section">
        <h3>
          File <span className="rule" />
        </h3>
        <dl className="kv">
          {sheet.fileName && (
            <>
              <dt>Source</dt>
              <dd>{sheet.fileName}</dd>
            </>
          )}
          <dt>Entities</dt>
          <dd>{sheet.entities.toLocaleString('en-US')}</dd>
          <dt>Units</dt>
          <dd>mm</dd>
          <dt>Revision</dt>
          <dd>{sheet.rev || '—'}</dd>
        </dl>
        {sheet.extractLine && (
          <div className="extract-line" data-testid="extract-line">
            {sheet.extractLine}
          </div>
        )}
        {sheet.sourceNote && <div className="source-note">{sheet.sourceNote}</div>}
      </div>

      {/* R3 §3.3 — a section sheet gets its full detail; a drawing gets its
          split status + coverage (§3.1/§3.4). */}
      {sheet.section ? (
        <SectionDetailBlock detail={sheet.section} />
      ) : sheet.documentId ? (
        <SectionsBlock sheet={sheet} />
      ) : null}

      {sheet.grounded && (
        <div className="section steel">
          <h3>
            Steel summary <span className="rule" />
          </h3>
          <div className="card">
            {/* Nothing weighable is not zero steel — it is a schedule waiting
                on answers, and it says so (§6.4). */}
            {allBlocked ? (
              <div className="stat-row" data-testid="details-tonnage">
                <span className="stat-unit">
                  blocked — {openRows} row{openRows === 1 ? '' : 's'} open, no weight yet
                </span>
              </div>
            ) : (
              <div className="stat-row" data-testid="details-tonnage">
                <span className="stat-big">
                  {(totalKg / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </span>
                <span className="stat-unit">t{openRows ? ` · ${openRows} open` : ''}</span>
              </div>
            )}
            <div className="bars">
              {summary.map((s) => (
                <div key={s.diaMm} className="bar-row">
                  <span className="dia">{s.diaMm} mm</span>
                  <span className="track">
                    <span className="fill" style={{ width: `${((s.weightKg / maxKg) * 100).toFixed(1)}%` }} />
                  </span>
                  <span className="val">{s.weightKg.toFixed(1)} kg</span>
                </div>
              ))}
            </div>
            <div className="btn-row">
              <button type="button" className="btn primary" onClick={() => store.setDockTab('bbs')}>
                Open bar bending schedule
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
