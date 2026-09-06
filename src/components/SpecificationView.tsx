// R4 — memory rendered as the project SPECIFICATION (UI_REQUIREMENTS_UPDATE §4).
//
// Two surfaces, one store: the full stage view here (reading, auditing,
// answering, exporting) and the dock tab (a filter over the same ledger —
// see Dock.tsx, which renders <SpecificationRows scope=…>). Rows group by the
// first segment of the dotted key and expand in place exactly as schedule rows
// do; every non-missing fact's source renders as the resolvable chain
// drawing › section › handles (§4.4), sharing the schedule's selection and
// highlight path through StudioFactsSeam.open.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { blockedFacts, factVersions, type FactVersion, type Ledger } from '../facts/ledger';
import { factOnDrawing, factPlaceable, factSubject, type Fact, type FactState } from '../facts/types';
import { activeDrawingNumber, useStudioData, type StudioFactsSeam } from '../studio/data';
import { useStudio, useStudioStore } from '../studio/store';
import { downloadSpecification } from '../studio/exportSpec';
import { Icon } from './icons';
import { toast } from './Toasts';
import './SpecificationView.css';

// ------------------------------------------------------------
// small pieces
// ------------------------------------------------------------

/** Chip colour role per §4.3: trust order is the one thing the view communicates. */
const CHIP_CLASS: Record<FactState, string> = {
  MEASURED: 'ok',
  DECLARED: 'ok',
  DERIVED: 'accent',
  SUPPLIED: 'accent',
  MISSING: 'warn',
};

function StateChip({ fact }: { fact: Fact }) {
  if (fact.contradicted) {
    return <span className="spec-chip warn" data-testid="fact-chip">contradicted</span>;
  }
  return (
    <span className={`spec-chip ${CHIP_CLASS[fact.state]}`} data-testid="fact-chip">
      {fact.state.toLowerCase()}
      {fact.stale ? ' · stale' : ''}
    </span>
  );
}

function valueText(fact: { value: Fact['value']; unit?: string }): string {
  if (fact.value === null || fact.value === undefined) return '—';
  const v =
    typeof fact.value === 'number' ? fact.value.toLocaleString('en-IN') : String(fact.value);
  return fact.unit ? `${v} ${fact.unit}` : v;
}

/**
 * R4a — the provenance chain `GW-01 R1 › REGION-12 › 79A47, 79A48`. Every
 * segment is a link resolving to a location; hovering shows the raw text —
 * the fact exactly as drawn.
 */
export function SourceChain({
  source,
  facts,
}: {
  source: NonNullable<Fact['source']>;
  facts: StudioFactsSeam;
}) {
  const hover = source.rawText ? `as drawn: "${source.rawText}"` : undefined;
  return (
    <span className="spec-chain" title={hover} data-testid="source-chain">
      <button type="button" onClick={() => facts.open(source, 'drawing')}>
        {[source.drawingNumber || 'drawing', source.revision].filter(Boolean).join(' ')}
      </button>
      {source.sectionId && (
        <>
          <span className="sep">›</span>
          <button type="button" onClick={() => facts.open(source, 'section')}>
            {source.sectionId}
          </button>
        </>
      )}
      {source.handles && source.handles.length > 0 && (
        <>
          <span className="sep">›</span>
          <button type="button" onClick={() => facts.open(source, 'handles')}>
            {source.handles.join(', ')}
          </button>
        </>
      )}
    </span>
  );
}

/** Inline answer/edit form — one input, one act, three doors to it (§4.4). */
function AnswerForm({
  label,
  placeholder,
  onSubmit,
}: {
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="spec-answer">
      <input
        type="text"
        value={draft}
        placeholder={placeholder ?? 'your answer…'}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
        {label}
      </button>
    </div>
  );
}

// ------------------------------------------------------------
// history (R5 §5.5)
// ------------------------------------------------------------

function HistoryList({
  versions,
  facts,
}: {
  versions: FactVersion[];
  facts: StudioFactsSeam;
}) {
  // versions[0] is current — history proper starts at 1.
  const past = versions.slice(1);
  if (!past.length) return null;
  return (
    <div className="spec-history" data-testid="fact-history">
      <span className="h">History</span>
      {past.map((v, i) => (
        <div key={i} className="spec-hrow">
          <s className="old">{valueText(v)}</s>
          <span className="spec-chip dim">{v.state.toLowerCase()}</span>
          {v.source && <SourceChain source={v.source} facts={facts} />}
          {v.reason && <span className="why">{v.reason}</span>}
          {v.supersededAt && (
            <span className="when">{new Date(v.supersededAt).toLocaleDateString('en-IN')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** `R1 → R2` — the value changed at the last revision (§5.5). */
function revisionChip(versions: FactVersion[]): string | null {
  if (versions.length < 2) return null;
  const [cur, prev] = versions;
  if (prev.reason !== 'newer-revision') return null;
  if (prev.value === cur.value) return null;
  const from = prev.source?.revision;
  const to = cur.source?.revision;
  return from || to ? `${from ?? '—'} → ${to ?? '—'}` : null;
}

// ------------------------------------------------------------
// one row
// ------------------------------------------------------------

function FactRow({
  fact,
  facts,
  ledger,
  ask,
  open,
  onToggle,
}: {
  fact: Fact;
  facts: StudioFactsSeam;
  ledger: Ledger;
  /** the question for a blocked (missing/contradicted) fact, if any */
  ask?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const versions = useMemo(() => factVersions(ledger, fact.id), [ledger, fact.id]);
  const revChip = revisionChip(versions);
  const name = fact.id.includes('.') ? fact.id.slice(fact.id.indexOf('.') + 1) : fact.id;

  return (
    <div className={`spec-row${open ? ' open' : ''}`} data-fact={fact.id} data-testid={`fact-${fact.id}`}>
      <button type="button" className="spec-line" onClick={onToggle} aria-expanded={open}>
        <span className="name">{name}</span>
        <span className="val">{valueText(fact)}</span>
        {/* One cell, so the chips wrap inside the row instead of pushing the
            row past the panel's right edge — which is how "not tied to a
            drawing" came to be sliced in half by the dock. */}
        <span className="tags">
          <StateChip fact={fact} />
          {revChip && <span className="spec-chip accent" data-testid="rev-chip">{revChip}</span>}
        </span>
        <span className="ctx">
          {fact.state === 'MISSING'
            ? (fact.neededFor?.length ? `needed for ${fact.neededFor.join(', ')}` : 'ask ▸')
            : fact.state === 'SUPPLIED'
              ? [fact.suppliedBy, fact.readOn].filter(Boolean).join(', ') +
                (fact.saidAs ? ` · "${fact.saidAs}"` : '')
              : fact.state === 'DERIVED'
                ? fact.basis ?? ''
                : fact.state === 'MEASURED'
                  ? fact.method ?? ''
                  : fact.source
                    ? `${fact.source.drawingNumber} ${fact.source.revision}${fact.source.sectionId ? ` › ${fact.source.sectionId}` : ''}`
                    : ''}
        </span>
      </button>

      {open && (
        <div className="spec-detail" data-testid={`fact-detail-${fact.id}`}>
          {/* §4.3 — the expansion per state, like a schedule row's derivation */}
          {fact.source && (
            <div className="drow">
              <span className="k">Source</span>
              <SourceChain source={fact.source} facts={facts} />
              {fact.source.rawText && <span className="raw">as drawn: “{fact.source.rawText}”</span>}
            </div>
          )}
          {fact.state === 'DERIVED' && (
            <div className="drow">
              <span className="k">Basis</span>
              <span>{fact.basis ?? '—'}</span>
              {fact.dependsOn?.length ? <span className="dim">from {fact.dependsOn.join(', ')}</span> : null}
            </div>
          )}
          {fact.state === 'MEASURED' && (
            <div className="drow">
              <span className="k">Method</span>
              <span>{fact.method ?? '—'}</span>
            </div>
          )}
          {fact.state === 'SUPPLIED' && (
            <div className="drow">
              <span className="k">Said as</span>
              <span className="raw">“{fact.saidAs ?? String(fact.value)}”</span>
              <span className="dim">
                {[fact.suppliedBy, fact.readOn].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          {fact.state === 'MISSING' && (
            <>
              {fact.lookedIn?.length ? (
                <div className="drow">
                  <span className="k">Looked in</span>
                  <span>{fact.lookedIn.join(' · ')}</span>
                </div>
              ) : null}
              {fact.neededFor?.length ? (
                <div className="drow">
                  <span className="k">Needed for</span>
                  <span>{fact.neededFor.join(' · ')}</span>
                </div>
              ) : null}
            </>
          )}
          {fact.evidence?.length ? (
            <div className="drow">
              <span className="k">Evidence</span>
              <span className="dim">{fact.evidence.join(' · ')}</span>
            </div>
          ) : null}

          {/* blocked (missing or contradicted) — the ask, and the answer door */}
          {(fact.state === 'MISSING' || fact.contradicted) && (
            <div className="drow ask" data-testid={`fact-ask-${fact.id}`}>
              <span className="k warn">Ask</span>
              <span>{ask ?? fact.ask ?? `What is ${fact.id}?`}</span>
            </div>
          )}
          {(fact.state === 'MISSING' || fact.contradicted) && (
            <AnswerForm
              label="Answer"
              placeholder={fact.unit ? `value in ${fact.unit}` : 'your answer…'}
              onSubmit={(v) => void facts.answer(fact.id, v)}
            />
          )}

          {/* §4.5 — supplied facts are editable and withdrawable; measured and
              declared are not: disagreeing with a reading is an override,
              recorded SUPPLIED with the reading kept in history. */}
          {fact.state === 'SUPPLIED' && !fact.contradicted && (
            <div className="spec-actions">
              <AnswerForm
                label="Edit"
                placeholder="corrected value"
                onSubmit={(v) => void facts.override(fact.id, v)}
              />
              <button
                type="button"
                className="btn"
                data-testid={`withdraw-${fact.id}`}
                onClick={() => void facts.withdraw(fact.id)}
              >
                Withdraw
              </button>
            </div>
          )}
          {(fact.state === 'MEASURED' || fact.state === 'DECLARED') && !fact.contradicted && (
            <div className="spec-actions">
              <span className="dim">
                {fact.state === 'DECLARED'
                  ? 'Read off the drawing — not editable. Overriding records your value as supplied and keeps this reading.'
                  : 'Computed from geometry — not editable. Overriding records your value as supplied and keeps this measurement.'}
              </span>
              <AnswerForm
                label="Override"
                onSubmit={(v) => void facts.override(fact.id, v)}
              />
            </div>
          )}

          <HistoryList versions={versions} facts={facts} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// the grouped rows — shared by the stage view and the dock tab
// ------------------------------------------------------------

export interface SpecificationScope {
  /** dock tab: facts sourced from this drawing + facts blocking it (§4.2) */
  drawingNumber?: string;
  /** R5 §5.5 — only facts touched by the latest revision event */
  changedOnly?: boolean;
}

/**
 * Take the whole specification away as a file.
 *
 * Rendered wherever the About block is, and null when there is nothing
 * established yet — an export button over an empty note downloads a header and
 * a date, which is worse than no button.
 */
export function DownloadSpecificationButton() {
  const about = useStudioData().facts?.aboutDrawing;
  if (!about) return null;
  return (
    <button
      type="button"
      className="btn"
      data-testid="download-specification"
      title={`Download this drawing's specification and all ${about.sectionNotes.length} section notes as Markdown`}
      onClick={() => {
        const name = downloadSpecification(about);
        toast(`Downloaded ${name}`, 'ok');
      }}
    >
      <Icon name="download" size={13} />
      <span>Download .md</span>
    </button>
  );
}

type SectionDetailData = NonNullable<
  NonNullable<StudioFactsSeam['aboutDrawing']>['sectionNotes'][number]['detail']
>;

/**
 * One section's reading, laid out.
 *
 * NOTHING IS TRUNCATED HERE. The flat `note` is capped because it goes into a
 * prompt and tokens are paid for; this is the page, where the reader is
 * checking the record against the sheet. "… and 57 more" is precisely what a
 * record must never say to the person auditing it — the fifty-seven it did not
 * show are the ones they came to find.
 *
 * Laid out by KIND rather than as prose: callouts, dimensions and text are
 * three different questions, and a reader scanning for steel should not have
 * to read past a title block to reach a bar.
 */
function SectionDetailView({ detail, kind }: { detail: SectionDetailData; kind: string }) {
  return (
    <div className="asn-detail">
      <div className="asn-made-of">
        <span className="asn-kind">{kind}</span>
        <span>{detail.entityCount.toLocaleString('en-IN')} entities</span>
        {detail.byType.map((t) => (
          <span key={t.type} className="asn-chip">
            {t.type} {t.count}
          </span>
        ))}
      </div>
      <div className="asn-made-of layers">
        {detail.byLayer.map((l) => (
          <span key={l.layer} className="asn-chip layer">
            {l.layer} {l.count}
          </span>
        ))}
      </div>

      <h4>
        Bar callouts <span className="asn-n">{detail.callouts.length}</span>
      </h4>
      {detail.callouts.length ? (
        <table className="asn-table">
          <thead>
            <tr>
              <th>on the sheet</th>
              <th>dia</th>
              <th>spacing</th>
              <th>count</th>
              <th>legs</th>
            </tr>
          </thead>
          <tbody>
            {detail.callouts.map((c, i) => (
              <tr key={`${c.raw}-${i}`}>
                {/* The sheet's own words first, always. What the grammar read
                    sits BESIDE them, never instead of them. */}
                <td className="mono">{c.raw}</td>
                <td>{c.diaMm !== undefined ? `Ø${c.diaMm}` : '—'}</td>
                <td>{c.spacingMm !== undefined ? `${c.spacingMm} c/c` : '—'}</td>
                <td>{c.count !== undefined ? c.count : '—'}</td>
                <td>{c.legs !== undefined ? `${c.legs}L` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="asn-none">None the bar grammar could read in this section.</p>
      )}

      <h4>
        Dimensions <span className="asn-n">{detail.dimensions.length}</span>
      </h4>
      {detail.dimensions.length ? (
        <table className="asn-table">
          <thead>
            <tr>
              <th>handle</th>
              <th>measured</th>
              <th>written</th>
            </tr>
          </thead>
          <tbody>
            {detail.dimensions.map((d) => (
              <tr key={d.handle}>
                <td className="mono">{d.handle}</td>
                <td>{d.measurementMm === null ? '—' : `${Math.round(d.measurementMm)} mm`}</td>
                {/* A detailer's override outranks the measurement — it is what
                    the yard cuts to — so it gets its own column rather than a
                    footnote. */}
                <td className={d.textOverride ? 'asn-written' : ''}>
                  {d.textOverride ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="asn-none">None inside this section.</p>
      )}

      <h4>
        Text, verbatim <span className="asn-n">{detail.text.length}</span>
      </h4>
      {detail.text.length ? (
        <ol className="asn-text">
          {detail.text.map((t, i) => (
            <li key={`${t}-${i}`}>{t}</li>
          ))}
        </ol>
      ) : (
        <p className="asn-none">None inside this section.</p>
      )}
    </div>
  );
}

export function AboutDrawingBlock() {
  const about = useStudioData().facts?.aboutDrawing;
  if (!about) return null;
  return (
    <details className="about-drawing" data-testid="about-drawing">
      <summary>
        About Drawing · {about.drawingName} · {about.conclusionCount} validated conclusion{about.conclusionCount === 1 ? '' : 's'}
      </summary>
      <div className="about-drawing-body">
        <small>Updated {new Date(about.updatedAt).toLocaleString('en-IN')}</small>
        <pre>{about.note}</pre>
        {about.sectionNotes.map((section) => (
          <details key={section.sectionId} className="about-section-note">
            <summary>
              {section.sectionId} · {section.label}
              {section.detail ? (
                <span className="asn-tally">
                  {section.detail.callouts.length} callout
                  {section.detail.callouts.length === 1 ? '' : 's'} ·{' '}
                  {section.detail.dimensions.length} dimension
                  {section.detail.dimensions.length === 1 ? '' : 's'} ·{' '}
                  {section.detail.text.length} text
                </span>
              ) : null}
            </summary>
            {section.detail ? (
              <SectionDetailView detail={section.detail} kind={section.kind} />
            ) : (
              // A note written before the reading was structured. Shown as it
              // stands rather than pretending to a detail it never had.
              <pre>{section.note}</pre>
            )}
          </details>
        ))}
      </div>
    </details>
  );
}

export function SpecificationRows({ scope }: { scope?: SpecificationScope }) {
  const data = useStudioData();
  const store = useStudioStore();
  const reveal = useStudio((s) => s.spec.reveal);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const hostRef = useRef<HTMLDivElement>(null);

  const facts = data.facts;
  const ledger = facts?.ledger ?? { entries: [] };

  const blocked = useMemo(() => new Map(blockedFacts(ledger).map((b) => [b.id, b] as const)), [ledger]);

  const currentFacts = useMemo(() => {
    const out: Fact[] = [];
    for (const e of ledger.entries) {
      if (e.fact.supersededBy === undefined) out.push(e.fact);
    }
    return out;
  }, [ledger]);

  const changedIds = useMemo(() => {
    const impact = data.revision?.latest?.impact;
    if (!impact) return null;
    return new Set([
      ...impact.changed.map((c) => c.id),
      ...impact.added,
      ...impact.nowMissing,
    ]);
  }, [data.revision?.latest]);

  const visible = useMemo(() => {
    // ONE rule, in `factOnDrawing`. This filter used to be
    // `f.source?.drawingNumber === num || !isUsable(f)`, and that second
    // clause is why every drawing's specification listed every drawing's open
    // questions: a MISSING fact is never usable, so it passed the filter
    // whatever drawing it came from.
    let list = scope?.drawingNumber
      ? currentFacts.filter((f) => factOnDrawing(f, scope.drawingNumber!))
      : currentFacts;
    if (scope?.changedOnly && changedIds) {
      list = list.filter((f) => changedIds.has(f.id));
    }
    return list;
  }, [currentFacts, scope?.drawingNumber, scope?.changedOnly, changedIds]);

  /**
   * THIS DRAWING'S FACTS, AND THE ONES THAT ARE ONLY HERE BECAUSE NOTHING CAN
   * PLACE THEM.
   *
   * `factOnDrawing` lists an unplaceable fact on every drawing deliberately —
   * hiding it makes it unreachable from any surface. But interleaved among the
   * open drawing's own rows it reads as one of them: open the pedestal detail
   * and `c1.height`, answered on the columns sheet, sits at the top of the
   * list under a heading naming the pedestal. Same rows, same reachability —
   * gathered under their own heading, folded away, saying what they are.
   *
   * They are only worth separating when a drawing is in scope. With "every
   * drawing" showing, nothing is claiming to be one drawing's.
   */
  // Each row carried a "not tied to a drawing" chip instead; the heading over
  // the block says it once, which is both truer and the only version that fits
  // in a 400px dock.
  const [placed, unplaced] = useMemo(() => {
    if (!scope?.drawingNumber) return [visible, [] as Fact[]];
    const mine: Fact[] = [];
    const loose: Fact[] = [];
    for (const f of visible) (factPlaceable(f) ? mine : loose).push(f);
    return [mine, loose];
  }, [visible, scope?.drawingNumber]);

  const groupBySubject = (list: Fact[]) => {
    const bySubject = new Map<string, Fact[]>();
    for (const f of list) {
      const s = factSubject(f.id);
      const of = bySubject.get(s) ?? [];
      of.push(f);
      bySubject.set(s, of);
    }
    return [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const groups = useMemo(() => groupBySubject(placed), [placed]);
  const looseGroups = useMemo(() => groupBySubject(unplaced), [unplaced]);

  // §6.4 — a fact search result is a location: scroll to it, expanded.
  useEffect(() => {
    if (!reveal) return;
    setOpenIds((prev) => new Set([...prev, reveal]));
    const el = hostRef.current?.querySelector<HTMLElement>(`[data-fact="${reveal}"]`);
    // A revealed fact may be one of the unplaceable ones, folded away. A
    // search result that scrolls to a closed <details> is a search result that
    // lands nowhere.
    el?.closest('details')?.setAttribute('open', '');
    el?.scrollIntoView?.({ block: 'center' });
    store.clearFactReveal();
  }, [reveal, store]);

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!facts) {
    return (
      <div className="dock-void">
        <span className="vt">No fact ledger</span>
        <span className="vs">The specification connects to the project's fact ledger — it is not wired in the demo.</span>
      </div>
    );
  }
  if (!facts.loaded) return <div className="spec-empty">reading the ledger…</div>;
  if (!groups.length && !looseGroups.length) {
    return (
      <div className="dock-void" data-testid="spec-empty">
        <span className="vt">Nothing on file yet</span>
        <span className="vs">
          Facts land here as drawings are read and questions are answered — every entry with its
          state and the exact place it came from.
        </span>
      </div>
    );
  }

  const rowsOf = (list: Fact[]) =>
    list.map((f) => (
      <FactRow
        key={f.id}
        fact={f}
        facts={facts}
        ledger={ledger}
        ask={blocked.get(f.id)?.ask}
        open={openIds.has(f.id)}
        onToggle={() => toggle(f.id)}
      />
    ));

  return (
    <div className="spec-rows" ref={hostRef} data-testid="spec-rows">
      {groups.map(([subject, list]) => (
        <div key={subject} className="spec-group">
          <div className="spec-subject">
            {subject.toUpperCase()}
            <span className="rule" />
          </div>
          {rowsOf(list)}
        </div>
      ))}

      {looseGroups.length > 0 && (
        <details className="spec-loose" data-testid="spec-unplaced">
          <summary>
            <span className="lt">Not tied to a drawing</span>
            <span className="ln">
              {unplaced.length} fact{unplaced.length === 1 ? '' : 's'}
            </span>
          </summary>
          <p className="lwhy">
            No drawing was recorded when {unplaced.length === 1 ? 'this was' : 'these were'}{' '}
            answered, so {unplaced.length === 1 ? 'it is' : 'they are'} listed on every drawing —
            not necessarily {scope?.drawingNumber}'s. Answering{' '}
            {unplaced.length === 1 ? 'it' : 'them'} again from the drawing{' '}
            {unplaced.length === 1 ? 'it belongs' : 'they belong'} to places{' '}
            {unplaced.length === 1 ? 'it' : 'them'}.
          </p>
          {looseGroups.map(([subject, list]) => (
            <div key={subject} className="spec-group">
              <div className="spec-subject">
                {subject.toUpperCase()}
                <span className="rule" />
              </div>
              {rowsOf(list)}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// R5 §5.4 — the revision impact report
// ------------------------------------------------------------

function ImpactReport() {
  const data = useStudioData();
  const facts = data.facts;
  const rev = data.revision;
  const [openManually, setOpenManually] = useState(false);
  if (!rev?.latest || !facts) return null;
  const { impact } = rev.latest;
  const open = rev.showReport || openManually;

  if (!open) {
    return (
      <button type="button" className="spec-impact-pill" onClick={() => setOpenManually(true)}>
        Last revision: {impact.drawing} {impact.from} → {impact.to} · {impact.changed.length} changed ▸
      </button>
    );
  }

  const line = (label: string, cls: string, n: number) => (
    <div className={`irow ${cls}`}>
      <span className="k">{label}</span>
      <span className="n">{n}</span>
    </div>
  );

  return (
    <div className="spec-impact" data-testid="impact-report">
      <div className="ihead">
        <b>
          {impact.drawing} {impact.from} → {impact.to}
        </b>
        <span className="spacer" />
        <button
          type="button"
          className="ibtn"
          aria-label="Dismiss the revision report"
          onClick={() => {
            setOpenManually(false);
            rev.dismissReport();
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {line('CHANGED', 'warn', impact.changed.length)}
      {impact.changed.map((c) => (
        <div key={c.id} className="ichange">
          <span className="id">{c.id}</span>
          <s>{c.oldValue === null ? '—' : String(c.oldValue)}</s>
          <span className="arrow">→</span>
          <b>{c.newValue === null ? '—' : String(c.newValue)}</b>
          {c.oldSource && <SourceChain source={c.oldSource} facts={facts} />}
          {c.newSource && <SourceChain source={c.newSource} facts={facts} />}
        </div>
      ))}
      {line('UNCHANGED', '', impact.unchanged.length)}
      {line('NEW', 'accent', impact.added.length)}
      {impact.added.map((id) => (
        <div key={id} className="ichange">
          <span className="id">{id}</span>
        </div>
      ))}
      {line('NOW MISSING', impact.nowMissing.length ? 'warn' : '', impact.nowMissing.length)}
      {impact.nowMissing.map((id) => (
        <div key={id} className="ichange">
          <span className="id">{id}</span>
          <span className="dim">was on {impact.from}, not found on {impact.to} — it blocks until answered</span>
        </div>
      ))}
      {line('SURVIVED', '', impact.survived.length)}
      {impact.survived.length > 0 && (
        <div className="ichange">
          <span className="dim">{impact.survived.join(', ')} — supplied facts, unaffected</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// the stage view
// ------------------------------------------------------------

export function SpecificationView() {
  const data = useStudioData();
  const activeSheetId = useStudio((s) => s.sheets.active);
  const [changedOnly, setChangedOnly] = useState(false);
  // The specification is READ PER DRAWING. It used to render the whole ledger
  // on every visit, so opening one drawing and asking for its specification
  // answered with four drawings' facts and every project-wide open question
  // interleaved — unreadable as any one drawing's spec, which is the only
  // thing it is ever opened to be. The project-wide view is still a click
  // away; it is no longer the only view.
  const [wholeProject, setWholeProject] = useState(false);
  const facts = data.facts;
  const drawing = activeDrawingNumber(data, activeSheetId);
  const scoped = !wholeProject && drawing ? drawing : undefined;
  const hasRevision = !!data.revision?.latest;

  const { currentCount, openCount } = useMemo(() => {
    if (!facts) return { currentCount: 0, openCount: 0 };
    // Counted through the SAME predicate the rows are filtered by — a header
    // that says 13 facts over a list of 4 is a header nobody can trust.
    const inScope = (f: Fact) => !scoped || factOnDrawing(f, scoped);
    return {
      currentCount: facts.ledger.entries.filter(
        (e) => e.fact.supersededBy === undefined && inScope(e.fact),
      ).length,
      openCount: blockedFacts(facts.ledger).filter((b) => inScope(b.fact)).length,
    };
  }, [facts, scoped]);

  return (
    <div className="spec-view" data-testid="spec-view">
      <div className="spec-head">
        <h2>Specification</h2>
        <span className="sub" data-testid="spec-scope">
          {scoped ? `${scoped} · ` : drawing ? 'every drawing · ' : ''}
          {currentCount} fact{currentCount === 1 ? '' : 's'} on file
          {openCount > 0 ? ` · ${openCount} open question${openCount === 1 ? '' : 's'}` : ''}
        </span>
        <span className="spacer" />
        {drawing && (
          <label
            className="spec-filter"
            title={
              wholeProject
                ? `Show only what belongs to ${drawing}`
                : 'Show every drawing in the project — a fact read off one drawing can block another'
            }
          >
            <input
              type="checkbox"
              data-testid="spec-whole-project"
              checked={wholeProject}
              onChange={(e) => setWholeProject(e.target.checked)}
            />
            Every drawing
          </label>
        )}
        <label className={`spec-filter${hasRevision ? '' : ' off'}`} title={hasRevision ? 'Only facts touched by the last revision' : 'No revision has landed yet'}>
          <input
            type="checkbox"
            disabled={!hasRevision}
            checked={changedOnly && hasRevision}
            onChange={(e) => setChangedOnly(e.target.checked)}
          />
          Changed since {data.revision?.latest ? `${data.revision.latest.impact.drawing} ${data.revision.latest.impact.to}` : 'last revision'}
        </label>
        {/* Two exports, and they are not the same document. The CSV is the
            FACT LEDGER — one row per fact, for a spreadsheet. The Markdown is
            the established READING of the drawing, notes and all, for someone
            who has to check what the drawing was understood to say. */}
        <DownloadSpecificationButton />
        {facts && (
          <button type="button" className="btn" data-testid="spec-export" onClick={() => facts.exportCsv()}>
            <Icon name="download" size={13} /> Export CSV
          </button>
        )}
      </div>
      <ImpactReport />
      <div className="spec-legend">
        <span className="spec-chip ok">measured</span>
        <span className="spec-chip ok">declared</span>
        <span className="spec-chip accent">derived</span>
        <span className="spec-chip accent">supplied</span>
        <span className="spec-chip warn">missing</span>
        <span className="dim">— ordered by trust; missing blocks the quantity</span>
      </div>
      <div className="spec-scroll">
        <AboutDrawingBlock />
        <SpecificationRows scope={{ drawingNumber: scoped, changedOnly }} />
      </div>
    </div>
  );
}
