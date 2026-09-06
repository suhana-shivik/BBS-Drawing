
import React from 'react';
import {
  activeDrawingNumber,
  useStudioData,
  type SectionDetailData,
  type SheetSectionsInfo,
  type StudioSheet,
} from '../studio/data';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import {
  AboutDrawingBlock,
  DownloadSpecificationButton,
  SpecificationRows,
} from './SpecificationView';

type Box = { xMin: number; yMin: number; xMax: number; yMax: number };

/**
 * The one millimetre box that contains all of them — what to frame when
 * several areas are chosen at once.
 *
 * These are the sections' OWN stored bounds, untouched: nothing here widens,
 * clamps or invents a number, it only takes the extremes of what is already
 * there. So if the camera lands somewhere empty, the bounds are wrong, and
 * that is worth seeing rather than papering over.
 */
function unionBounds(sections: ReadonlyArray<{ bounds: Box }>): Box | null {
  if (!sections.length) return null;
  return sections.reduce<Box>(
    (a, s) => ({
      xMin: Math.min(a.xMin, s.bounds.xMin),
      yMin: Math.min(a.yMin, s.bounds.yMin),
      xMax: Math.max(a.xMax, s.bounds.xMax),
      yMax: Math.max(a.yMax, s.bounds.yMax),
    }),
    { ...sections[0].bounds },
  );
}

export function SectionsBlock({ sheet }: { sheet: StudioSheet }) {
  const data = useStudioData();
  const store = useStudioStore();
  const pinned = useStudio((s) => s.view.pinnedSections);
  // How many highlights the sheet ACTUALLY carries — gaps are marks too, so
  // only the read ones are compared against the section count.
  const drawn = Math.min(sheet.marksDrawn ?? 0, data.sectionsByDoc?.[sheet.documentId!]?.sections.length ?? 0);
  const docId = sheet.documentId!;
  const info: SheetSectionsInfo | undefined = data.sectionsByDoc?.[docId];
  const split = data.split;
  // Still orange, and no longer orange. `action` is what decides — a piece can
  // be read and still unresolved (too little content to stand as its own
  // area), and that one keeps its warning.
  const gapsAll = info?.gaps ?? [];
  const unread = gapsAll.filter((g) => !g.second || g.second.action === 'unresolved');
  const resolved = gapsAll.filter((g) => g.second && g.second.action !== 'unresolved');

  const status = info?.status ?? null;
  const dot =
    status === 'queued' || status === 'splitting'
      ? 'busy'
      : status === 'failed' || status === 'stale' || info?.unexplainedGap
        ? 'warn'
        : status === 'split'
          ? 'ok'
          : 'idle';

  // While the model has the sheet there is nothing to read and nothing to
  // press — so the block says what is happening, once, and shows a spinner
  // instead of a dead "Splitting…" button.
  const reading = status === 'queued' || status === 'splitting';

  return (
    <div className="section" data-testid="sections-block">
      <h3>
        Sections <span className="rule" />
      </h3>
      {reading ? (
        <div className="read-loader" data-testid="reading-loader" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span className="rl-text">
            <b>Reading drawing…</b>
            <span className="rl-sub">
              {status === 'queued'
                ? 'queued — this drawing is next'
                : 'the model is going through the sheet and filing what it finds'}
            </span>
          </span>
        </div>
      ) : (
        <div className="split-status" data-testid="split-status">
          <span className={`state ${dot}`} />
          <span>{info?.statusLine ?? 'not read yet — reading a drawing files it into sections'}</span>
        </div>
      )}
      {info?.costLine && <div className="split-cost">{info.costLine}</div>}
      {info?.error && <div className="run-error">{info.error}</div>}
      {info && info.progressTail.length > 0 && (
        <ol className="run-lines tail" aria-live="polite">
          {info.progressTail.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}

      {info?.coverageLine && (
        <dl className="kv" data-testid="coverage-block">
          <dt>Sections</dt>
          <dd>{info.count ?? '—'}</dd>
          <dt>Coverage</dt>
          <dd>{info.coverageLine}</dd>
          {info.residual.length > 0 && (
            <>
              <dt>Residual</dt>
              <dd>
                {info.residual.map((r) => (
                  <div key={r.layer} className={r.explained ? '' : 'warned'}>
                    {r.layer} · {r.count} entit{r.count === 1 ? 'y' : 'ies'} —{' '}
                    {r.explained ? 'explained, not lost' : 'UNEXPLAINED'}
                    {r.sampleText.length ? ` · e.g. "${r.sampleText[0]}"` : ''}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
      {info?.unexplainedGap && (
        <div className="run-error" data-testid="coverage-gap">
          Part of this drawing is in no section and the read never accounted for it — an
          unexplained gap, not a silent success.
        </div>
      )}

      {info && info.sections.length > 0 && (
        <div className="section-list" data-testid="section-list">
          {/* What the sheet is showing right now, and the way back to all of
              them. With every section outlined at once the drawing answers
              "what has been read"; with one chosen it answers "where is
              THIS". Both are wanted, so both are one click apart. */}
          <div className="section-showing" data-testid="section-showing">
            {pinned?.length === 0 ? (
              // DESELECTED — the plain drawing, nothing over it. Distinct from
              // the resting state below, which outlines everything: "I have
              // chosen nothing" and "I have not chosen" are different answers,
              // and the button has to be able to get back from this one.
              <>
                <span data-testid="marks-cleared">No areas outlined</span>
                <button
                  type="button"
                  className="btn-link"
                  data-testid="show-all-sections"
                  title="Outline every read area again"
                  onClick={() => store.showAllSections()}
                >
                  Show all {info.sections.length} read areas
                </button>
              </>
            ) : pinned?.length ? (
              <>
                <span>
                  {pinned.length === 1 ? (
                    <>
                      Showing <b>{pinned[0]}</b> only
                    </>
                  ) : (
                    <>
                      Showing <b>{pinned.length}</b> of {info.sections.length} read areas
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="btn-link"
                  data-testid="show-all-sections"
                  title="Outline every read area again"
                  onClick={() => store.showAllSections()}
                >
                  Show all {info.sections.length} read areas
                </button>
                <button
                  type="button"
                  className="btn-link"
                  data-testid="clear-sections"
                  title="Take the colour off — show the drawing on its own"
                  onClick={() => store.clearSections()}
                >
                  Deselect all
                </button>
              </>
            ) : drawn === 0 && info.sections.length > 0 ? (
              // READ, BUT NOT DRAWABLE. The sheet was built and not one section
              // produced a box on it. Saying so is the whole point: a highlight
              // that was dropped looks exactly like one that was never asked
              // for, and that ambiguity has cost more time here than any bug.
              <>
                <span className="warned" data-testid="marks-undrawable">
                  {info.sections.length} sections read, but none could be outlined on this sheet —
                  their bounds do not land on the drawing.
                </span>
                {/* Here too, so the control never moves. It has nothing to
                    take off in this state — that is what the warning beside it
                    says — but a button that appears and disappears depending
                    on which explanation the panel is giving is worse than one
                    that is occasionally a no-op. */}
                <button
                  type="button"
                  className="btn-link"
                  data-testid="clear-sections"
                  title="Take the colour off — show the drawing on its own"
                  onClick={() => store.clearSections()}
                >
                  Deselect all
                </button>
              </>
            ) : (
              <>
                <span>
                  {drawn === info.sections.length
                    ? `All ${info.sections.length} read areas outlined`
                    : `${drawn} of ${info.sections.length} read areas outlined`}{' '}
                  — tick several to compare them, or click one to single it out
                </span>
                {/* ALWAYS OFFERED, ticked or not. Resting is not "nothing
                    chosen" from the reader's side — it is every area outlined,
                    and taking the colour off to read the geometry underneath
                    is exactly as useful then as it is mid-selection. Hiding
                    the button here meant the only route to the plain drawing
                    was to tick a box first and then untick everything. */}
                <button
                  type="button"
                  className="btn-link"
                  data-testid="clear-sections"
                  title="Take the colour off — show the drawing on its own"
                  onClick={() => store.clearSections()}
                >
                  Deselect all
                </button>
              </>
            )}
          </div>
          {/* STEP 8, as an explicit act, and on its OWN line: checking the
              sections is about the sections, not about whether their marks
              landed on the sheet, so it must not disappear into whichever
              explanation the line above is giving. The deterministic half
              needs no key and no calls — only what it cannot settle is
              escalated, which on a clean drawing is nothing. */}
          {split && sheet.documentId && (
            <div className="section-check-line">
              {/* TWO QUESTIONS, TWO PRICES, said out loud on the buttons.
                  The first is arithmetic and is free — handles, counts,
                  coordinates, dimension endpoints. The second asks whether the
                  section holds what it CLAIMS to hold, which code cannot
                  answer, and costs one call per section. Neither is the right
                  default for the other's job, so neither is hidden. */}
              <button
                type="button"
                className="btn-link"
                data-testid="validate-sections"
                title="Compare every section against the area it was cut from — no model calls"
                onClick={() => split.validate(sheet.documentId!)}
              >
                {info.sections.some((x) => x.verdict) ? 'Check again' : 'Check sections'}
              </button>
              <button
                type="button"
                className="btn-link"
                data-testid="validate-sections-deep"
                title={`Ask the model about each section's content — ${info.sections.length} calls, one per section`}
                onClick={() => split.validate(sheet.documentId!, true)}
              >
                Full AI check
              </button>
            </div>
          )}
          {info.sections.map((s) => (
            <div
              key={s.sectionId}
              className={`section-row${pinned?.includes(s.sectionId) ? ' pinned' : ''}`}
              // The row and the outline on the sheet are the same section:
              // hovering here lights it there, and CLICKING keeps it lit while
              // you look — so "REGION-03, 545 entities" becomes a place on the
              // drawing instead of a number.
              onMouseEnter={() => store.setHoverSection(s.sectionId)}
              onMouseLeave={() => store.setHoverSection(null)}
            >
              {/* TICK SEVERAL, COMPARE THEM. The row button singles ONE out;
                  this adds to the set and leaves the rest lit. Two different
                  questions — "where is this?" and "are these the same table
                  read twice?" — so two controls rather than one that guesses.

                  It is a real checkbox: the tick state is the selection, and a
                  screen reader, the keyboard and the browser's own find-in-page
                  all already know what one of these means. */}
              <input
                type="checkbox"
                className="section-check"
                checked={pinned?.includes(s.sectionId) ?? false}
                aria-label={`Select ${s.sectionId} ${s.label}`}
                title="Add this area to the selection"
                onChange={() => {
                  store.toggleSection(s.sectionId);
                  // FRAME WHAT IS NOW CHOSEN, all of it. Selecting a second
                  // area is asking to see it beside the first, so the camera
                  // fits their union rather than jumping to whichever was
                  // ticked last. Unticking the last one leaves the framing
                  // alone — there is nothing to frame, and snapping back to
                  // fit would throw away a view you are still reading.
                  const next = !pinned
                    ? [s.sectionId]
                    : pinned.includes(s.sectionId)
                      ? pinned.filter((id) => id !== s.sectionId)
                      : [...pinned, s.sectionId];
                  const box = unionBounds(info.sections.filter((x) => next.includes(x.sectionId)));
                  if (box) store.focusOn(sheet.id, box);
                }}
              />
              <button
                type="button"
                className="section-pick"
                aria-pressed={pinned?.length === 1 && pinned[0] === s.sectionId}
                title={
                  pinned?.length === 1 && pinned[0] === s.sectionId
                    ? 'Showing this one — click to show every read area again'
                    : 'Single this one out on the drawing'
                }
                onFocus={() => store.setHoverSection(s.sectionId)}
                onBlur={() => store.setHoverSection(null)}
                onClick={() => {
                  const picking = !(pinned?.length === 1 && pinned[0] === s.sectionId);
                  store.pinSection(s.sectionId);
                  // AND TAKE THE CAMERA THERE. Outlining a section only helps
                  // if you can find the outline: on a sheet zoomed to fit, a
                  // schedule table is a box a few dozen pixels across among a
                  // dozen others. Framing its bounds puts the answer in the
                  // middle of the canvas at a size you can read.
                  //
                  // It uses the section's OWN millimetre bounds — the same
                  // numbers the highlight is drawn from — so if the camera
                  // lands on empty space, the bounds are wrong, and that is
                  // worth seeing rather than hiding.
                  if (picking) store.focusOn(sheet.id, s.bounds);
                }}
              >
                <span className="sid">{s.sectionId}</span>
                <span className="slabel">{s.label}</span>
                <span className="skind">[{s.kind}]</span>
                <span className="scount">{s.entityCount.toLocaleString('en-IN')} entities</span>
                {/* WHY THIS BOX IS BIGGER THAN THE SPLITTER CUT IT. A region
                    whose bounds grew around an attached leftover says so on
                    its own row, rather than leaving the reader to wonder. */}
                {/* WHAT THE CHECK MADE OF IT. Absent means unchecked, which is
                    a different statement from PASS — a section nobody has
                    verified must not read as a verified one. */}
                {s.verdict && (
                  <span
                    className={`section-verdict ${s.verdict.status.toLowerCase()}`}
                    data-testid={`section-verdict-${s.sectionId}`}
                    title={
                      s.verdict.reasons.length
                        ? s.verdict.reasons.join('\n')
                        : 'matches the area of the drawing it was cut from'
                    }
                  >
                    {s.verdict.status}
                  </span>
                )}
                {s.attached && s.attached.length > 0 && (
                  <span className="section-attached" data-testid={`section-attached-${s.sectionId}`}>
                    {s.source} · attached {s.attached.join(', ')}
                  </span>
                )}
              </button>
              {/* Opening the section as its own sheet is a different act from
                  finding it on this one, so it gets its own control rather
                  than being what a click happens to do. */}
              <button
                type="button"
                className="section-open"
                aria-label={`Open ${s.sectionId} as a sheet`}
                title={`Open ${s.sectionId} as its own sheet`}
                onClick={() => store.openSheet(s.sheetId)}
              >
                <Icon name="expand" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* What the read did NOT reach, as places rather than as a percentage.
          Pure geometry off the stored package — no model call, no key: once a
          drawing is split, looking at what it missed costs nothing. */}
      {info && info.gaps.length > 0 && (
        <div className="gap-list" data-testid="gap-list">
          <div className="gap-head">
            {/* COUNTS ONLY WHAT IS STILL UNREAD. A piece the second pass folded
                into a region is history, not a review item — leaving it in this
                number said the drawing had four unread parts when it had none,
                and the orange boxes on the canvas agreed with the wrong one. */}
            <span>
              {unread.length
                ? `${unread.length} unread part${unread.length === 1 ? '' : 's'} — not in any section`
                : `every unread part accounted for — ${resolved.length} folded into a region`}
            </span>
            {/* THE SECOND PASS, as an explicit act. It spends model calls, so
                nothing here fires on its own — and it reads only these pieces,
                never re-cutting a section that was already read correctly. */}
            {split && !split.blocked && sheet.documentId && (
              <button
                type="button"
                className="btn-link"
                data-testid="read-residuals"
                title="Read each unread part and say what it is — the sections are not re-cut"
                onClick={() => split.readResiduals(sheet.documentId!)}
              >
                {info.gaps.some((g) => g.second) ? 'Read them again' : 'Read these parts'}
              </button>
            )}
          </div>
          {[...unread, ...resolved].map((g) => (
            <div
              key={g.id}
              // A resolved piece keeps its card so you can see where it went,
              // but it is NOT drawn as a warning any more — it is not one.
              className={`gap-row${g.second && g.second.action !== 'unresolved' ? ' resolved' : ''}`}
              data-testid={`gap-${g.id}`}
              onMouseEnter={() => store.setHoverSection(g.id)}
              onMouseLeave={() => store.setHoverSection(null)}
            >
              <div className="gap-line">
                <span className="gid">{g.id}</span>
                <span className="gcount">
                  {(g.second?.uniqueEntities ?? g.entityCount).toLocaleString('en-IN')} entities
                </span>
                {/* THE RELATIONSHIP, and where it came from.
                    Once the second pass has run its verdict replaces the
                    first-pass guess, because they are not the same claim:
                    "nearest REGION-09, 363 mm away" is a distance, and a
                    distance is not a relationship. CONNECTED is geometry
                    alone; NEAR_CONNECTED needed the reading as well. */}
                {g.second ? (
                  <span
                    className={`gjoin link-${g.second.link.toLowerCase().replace('_', '-')}`}
                    data-testid={`gap-link-${g.id}`}
                  >
                    {g.second.link === 'INDEPENDENT'
                      ? 'INDEPENDENT'
                      : `${g.second.link} → ${g.second.connectedRegions.join(', ')}`}
                  </span>
                ) : (
                  <span className={`gjoin${g.touches.length ? '' : ' alone'}`}>
                    {g.touches.length
                      ? `joins ${g.touches.join(', ')}`
                      : g.nearest
                        ? `independent · nearest ${g.nearest.sectionId}, ${Math.round(g.nearest.distanceMm).toLocaleString('en-IN')} mm away`
                        : 'independent'}
                  </span>
                )}
              </div>
              <div className="gap-why">
                {g.layers.map((l) => `${l.layer} (${l.count})`).join(' · ')}
              </div>
              {/* WHAT THE SECOND PASS MADE OF IT. `unread` and `failed` are
                  said out loud rather than left blank: a piece nobody read
                  looks exactly like a piece that was read and found to be
                  nothing, and that ambiguity is the whole reason this stage
                  exists. */}
              {g.second && (
                <div className={`gap-second ${g.second.status}`} data-testid={`gap-second-${g.id}`}>
                  <b>
                    SECOND PASS →{' '}
                    {g.second.status === 'read' ? 'READ' : g.second.status === 'unread' ? 'NOT READ' : 'FAILED'}
                  </b>
                  {g.second.summary && (
                    <span>
                      {' '}
                      — {g.second.kind ? `${g.second.kind}: ` : ''}
                      {g.second.summary}
                      {g.second.relation ? ` (${g.second.relation})` : ''}
                    </span>
                  )}
                  {!g.second.summary && g.second.note && <span> — {g.second.note}</span>}
                  {/* WHERE IT WENT. The action, not the reading — "read" and
                      "resolved" are different claims and only the second one
                      takes the orange off. */}
                  {g.second.action === 'attach' && g.second.resolvedTo && (
                    <div className="gap-resolved" data-testid={`gap-action-${g.id}`}>
                      ATTACHED → {g.second.resolvedTo}
                      {g.second.why ? ` · ${g.second.why}` : ''}
                    </div>
                  )}
                  {g.second.action === 'create-region' && g.second.resolvedTo && (
                    <div className="gap-resolved" data-testid={`gap-action-${g.id}`}>
                      NEW REGION → {g.second.resolvedTo}
                    </div>
                  )}
                  {/* READ AND EXPLAINED, and needing no region — a sliver of
                      a grid line. This is a resolution, not a warning: an
                      amber outline here sends the reader to check something
                      that has already been checked. */}
                  {g.second.action === 'explained' && (
                    <div className="gap-resolved" data-testid={`gap-action-${g.id}`}>
                      EXPLAINED · no area of its own needed
                    </div>
                  )}
                  {g.second.action === 'unresolved' && g.second.status === 'read' && g.second.why && (
                    <div className="gap-why" data-testid={`gap-action-${g.id}`}>
                      still unresolved · {g.second.why}
                    </div>
                  )}
                </div>
              )}
              {/* Needed for the schedule? Asserted only from a bar callout the
                  grammar actually read — a fact about the content. Otherwise
                  "Unknown / Needs Review", never a quiet "no": that would take
                  a layer-name rule, which is wrong on the next drawing. */}
              {/* "Unknown / Needs Review" is a REVIEW PROMPT. On a piece that
                  has been read and resolved there is nothing left to review,
                  and printing it anyway is what made a fully-read drawing look
                  like it still had four things wrong with it. */}
              <div
                className={`gap-bbs${g.bbs === 'required' ? ' required' : ' unknown'}`}
                data-testid={`gap-bbs-${g.id}`}
                hidden={Boolean(g.second && g.second.action !== 'unresolved' && g.bbs !== 'required')}
              >
                <b>{g.bbs === 'required' ? 'BBS: required' : 'BBS: Unknown / Needs Review'}</b>
                <span> — {g.bbsBasis}</span>
              </div>
              {g.callouts.length === 0 && g.sampleText.length > 0 && (
                <div className="gap-why">{g.sampleText.map((t) => `"${t}"`).join(', ')}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {split && !reading && (
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={split.blocked !== null}
            onClick={() => split.run(docId)}
          >
            {status === 'split' || status === 'stale' ? 'Read again' : 'Read drawing'}
          </button>
          {split.pendingAll > 1 && (
            <button
              type="button"
              className="btn"
              disabled={split.blocked !== null}
              onClick={() => split.runAll()}
            >
              Read all ({split.pendingAll})
            </button>
          )}
        </div>
      )}
      {split?.blocked && <div className="run-blocked">{split.blocked}</div>}
    </div>
  );
}

export function SectionDetailBlock({ detail }: { detail: SectionDetailData }) {
  const data = useStudioData();
  const store = useStudioStore();
  const mm = (v: number) => `${Math.round(v).toLocaleString('en-IN')} mm`;

  // R4a, the reverse direction: the facts read from this section.
  const sectionFacts = (data.facts?.ledger.entries ?? [])
    .filter(
      (e) => e.fact.supersededBy === undefined && e.fact.source?.sectionId === detail.sectionId,
    )
    .map((e) => e.fact);

  return (
    <div data-testid="section-detail">
      <div className="section">
        <h3>
          What it represents <span className="rule" />
        </h3>
        <dl className="kv">
          <dt>Label</dt>
          <dd>{detail.label}</dd>
          <dt>Kind</dt>
          <dd>
            {detail.kind} <span className="hint-dim">— a hint, never an assignment</span>
          </dd>
          {detail.memberHints.length > 0 && (
            <>
              <dt>Members</dt>
              <dd>
                {detail.memberHints.map((m) => (
                  <div key={m.mark}>
                    <b>{m.mark}</b> <span className="hint-dim">— {m.basis}</span>
                  </div>
                ))}
              </dd>
            </>
          )}
          {detail.calloutHints.length > 0 && (
            <>
              <dt>Callouts</dt>
              <dd>{detail.calloutHints.join(' · ')}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="section">
        <h3>
          Where it is <span className="rule" />
        </h3>
        <dl className="kv">
          <dt>Bounds</dt>
          <dd>
            {mm(detail.bounds.xMin)}, {mm(detail.bounds.yMin)} → {mm(detail.bounds.xMax)},{' '}
            {mm(detail.bounds.yMax)}
          </dd>
          <dt>Parent</dt>
          <dd>{detail.parentName}</dd>
        </dl>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            data-testid="show-on-sheet"
            disabled={!detail.parentSheetId}
            title={
              detail.parentSheetId
                ? 'Open the parent sheet zoomed to this section'
                : 'The parent drawing is not loaded'
            }
            onClick={() => {
              if (detail.parentSheetId) store.focusOn(detail.parentSheetId, detail.bounds);
            }}
          >
            Show on the sheet
          </button>
        </div>
      </div>

      <div className="section">
        <h3>
          Dimensions <span className="rule" />
        </h3>
        <dl className="kv">
          <dt>Size</dt>
          <dd>
            {mm(detail.widthMm)} × {mm(detail.heightMm)}
          </dd>
          <dt>Entities</dt>
          <dd>{detail.entityCount.toLocaleString('en-IN')}</dd>
          {detail.evidenceIds.length > 0 && (
            <>
              <dt>Evidence</dt>
              <dd>{detail.evidenceIds.join(', ')}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="section">
        <h3>
          Quality <span className="rule" />
        </h3>
        <dl className="kv">
          <dt>Confidence</dt>
          <dd>
            {detail.confidence ? detail.confidence.toFixed(2) : '—'}{' '}
            <span className="hint-dim">— the orchestrator's own</span>
          </dd>
          <dt>Produced</dt>
          <dd>orchestrator step {detail.orchestratorStep || '—'}</dd>
        </dl>
        {detail.limitations.length > 0 && (
          <div className="limitations" data-testid="section-limitations">
            {detail.limitations.map((l, i) => (
              <div key={i} className="limitation">
                <span className="code">{l.code}</span> {l.message}
                {l.count > 1 ? ` (×${l.count})` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {sectionFacts.length > 0 && (
        <div className="section">
          <h3>
            Facts read from it <span className="rule" />
          </h3>
          <div className="section-list">
            {sectionFacts.map((f) => (
              <button
                key={f.id}
                type="button"
                className="section-row"
                title="Open in the Specification"
                onClick={() => store.revealFact(f.id)}
              >
                <span className="sid">{f.id}</span>
                <span className="scount">
                  {f.value === null ? '—' : String(f.value)}
                  {f.unit ? ` ${f.unit}` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SpecificationTab() {
  const data = useStudioData();
  const store = useStudioStore();
  const sheets = useStudio((s) => s.sheets);
  const sheet = sheets.active ? data.sheets[sheets.active] : null;
  // One resolver, shared with the stage view — a section resolves to its
  // parent in both, or the dock and the full specification would disagree
  // about which drawing you are looking at.
  const drawingNumber = activeDrawingNumber(data, sheets.active) ?? undefined;

  return (
    <div className="spec-dock" data-testid="spec-dock">
      <div className="doc-head">
        <h2 className="doc-title">Specification</h2>
        <span className="doc-sub">
          {sheet && drawingNumber
            ? `facts from ${drawingNumber}, plus open questions`
            : 'the whole project'}
        </span>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => store.setStageMode('spec')}>
            Open the full specification
          </button>
          <DownloadSpecificationButton />
        </div>
      </div>
      <AboutDrawingBlock />
      <SpecificationRows scope={sheet && drawingNumber ? { drawingNumber } : undefined} />
    </div>
  );
}
