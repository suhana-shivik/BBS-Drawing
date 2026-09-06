// The schedule (STUDIO_DESIGN §6). A row is not a row — it is a closed
// derivation: click it and it expands IN PLACE, below itself, pushing the rows
// beneath it down. Expanding never re-sorts, never re-paginates, never moves
// the row. The column set is derived per drawing, never templated (§6.2).
//
// This component is pure: rows in, selection out. The dock wires it to the
// store's single shared `select` object.

import React, { useMemo, useState } from 'react';
import {
  cellValue,
  deriveColumns,
  groupRows,
  legCountOf,
  scheduleTotalText,
  singleShapeOf,
  steelSummary,
  subtotalText,
  type ScheduleRow,
} from '../studio/schedule';
import { computeWhenResolved, renderBlockedRow } from '../facts/blocked';
import { emptyLedger, type Ledger } from '../facts/ledger';
import { Icon } from './icons';
import './BbsSheet.css';

export type { ScheduleRow } from '../studio/schedule';

export interface BbsSheetProps {
  rows: ScheduleRow[];
  group?: 'member' | 'dia' | 'shape';
  selectedRowIds?: string[];
  /** §6.3: clicking a row highlights its steel — one selection, two views. */
  onRowSelect?: (row: ScheduleRow) => void;
  /**
   * §6.4 — the ledger a blocked row's hole is read against, so the row can
   * show what was searched and what to ask, and can tell when the hole has
   * since been filled.
   */
  ledger?: Ledger;
  /**
   * Answering a hole HERE is the same act as answering it in the Specification
   * (§4.4, three doors to one act): it writes SUPPLIED to the one store.
   */
  onAnswerFact?: (factId: string, value: string) => void;
}

const SOURCE_LABEL: Record<ScheduleRow['lengthSource'], string> = {
  ENTERED: 'ENTERED',
  SHAPE_FORMULA: 'SHAPE_FORMULA',
  IS_DERIVED: 'IS_DERIVED',
  UNAVAILABLE: 'UNAVAILABLE',
  DRAWN_GEOMETRY: 'drawn geometry',
  CUSTOM_FORMULA: 'stated formula',
};

export function BbsSheet({
  rows,
  group = 'member',
  selectedRowIds = [],
  onRowSelect,
  ledger,
  onAnswerFact,
}: BbsSheetProps) {
  const [open, setOpen] = useState<string[]>([]);

  const columns = useMemo(() => deriveColumns(rows), [rows]);
  const blocks = useMemo(() => groupRows(rows, group), [rows, group]);
  const oneShape = useMemo(() => singleShapeOf(rows), [rows]);
  const summary = useMemo(() => steelSummary(rows), [rows]);
  const totalText = useMemo(() => scheduleTotalText(rows), [rows]);
  const totalBlocked = rows.length > 0 && rows.every((r) => r.weightKg === null);
  // §25 — the four numbers a reader needs before any total: what computed,
  // what is open, what rests on an assumption, and what carries a warning.
  // Calculated is not validated; the line says which.
  const tally = useMemo(() => {
    const calculated = rows.filter((r) => r.weightKg !== null).length;
    const assumed = rows.filter(
      (r) => r.coverStatus === 'ASSUMED' || r.engineering === 'PARTIALLY_VALIDATED',
    ).length;
    // a validation warning is a check that did not pass — not an informational note
    const warned = rows.filter((r) => r.engineering === 'REJECTED' || r.engineering === 'PARTIALLY_VALIDATED' || r.engineering === 'UNVALIDATED').length;
    const validated = rows.filter((r) => r.engineering === 'VALIDATED').length;
    return { calculated, open: rows.length - calculated, assumed, warned, validated };
  }, [rows]);

  // One row open at a time by default; Alt keeps the others open.
  const toggle = (id: string, keepOthers: boolean) => {
    setOpen((cur) => {
      const isOpen = cur.includes(id);
      if (isOpen) return cur.filter((x) => x !== id);
      return keepOthers ? [...cur, id] : [id];
    });
  };

  const span = columns.length + 1;

  return (
    <div className="bbs-sheet">
      {oneShape !== null && (
        <div className="bbs-shape-note">
          All bars shape {oneShape || 'straight'} — stated here instead of an empty column.
        </div>
      )}
      {rows.length > 0 && (
        <div className="bbs-shape-note" data-testid="bbs-tally">
          Calculated rows {tally.calculated} · Open rows {tally.open} · Assumed inputs {tally.assumed} ·
          Validation warnings {tally.warned} ·{' '}
          {tally.validated === rows.length && tally.open === 0
            ? 'VALIDATED'
            : `${tally.validated}/${rows.length} validated — calculated is not final`}
        </div>
      )}
      <div className="bbs-wrap">
        <table className="bbs" data-testid="bbs-table">
          <thead>
            <tr>
              <th className="disclose-col" aria-label="Open the derivation" />
              {columns.map((c) => (
                <th key={c.id} className={c.numeric ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {blocks.map((block) => (
            <tbody key={block.key} data-testid={`bbs-group-${block.key}`}>
              <tr className="bbs-group-row">
                <td colSpan={span}>{block.label}</td>
              </tr>
              {block.rows.map((row) => {
                const isOpen = open.includes(row.id);
                const selected = selectedRowIds.includes(row.id);
                return (
                  <React.Fragment key={row.id}>
                    <tr
                      className={[
                        'bbs-row',
                        isOpen ? 'open' : '',
                        selected ? 'selected' : '',
                        row.status === 'unavailable' ? 'unavailable' : '',
                      ].filter(Boolean).join(' ')}
                      data-testid={`bbs-row-${row.id}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={(e) => {
                        toggle(row.id, e.altKey);
                        onRowSelect?.(row);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle(row.id, e.altKey);
                          onRowSelect?.(row);
                        }
                      }}
                    >
                      <td className="disclose-col">
                        {/* The disclosure triangle is a real button. */}
                        <button
                          type="button"
                          className="disclose"
                          aria-label={`${isOpen ? 'Close' : 'Open'} the derivation for ${row.mark} ${row.diaMm}mm`}
                          aria-expanded={isOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(row.id, e.altKey);
                          }}
                        >
                          <Icon name="chevronRight" size={11} />
                        </button>
                      </td>
                      {columns.map((c) => (
                        <td key={c.id} className={c.numeric ? 'num' : undefined}>
                          {/* §6.4 — the hole is named in the cell, never a bare dash. */}
                          {c.id === 'cuttingLength' && row.blocked ? (
                            <span className="cell-blocked" data-testid={`bbs-hole-${row.id}`}>
                              needs {row.blocked.missingFactIds.join(', ')}
                            </span>
                          ) : (
                            cellValue(row, c.id)
                          )}
                          {c.id === 'weight' && row.warnings.length > 0 && (
                            <span className="row-flag" title={row.warnings.join('\n')}>
                              <Icon name="warning" size={11} />
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                    {isOpen && (
                      <tr className="bbs-derivation-row" data-testid={`bbs-derivation-${row.id}`}>
                        <td colSpan={span}>
                          <Derivation row={row} ledger={ledger} onAnswerFact={onAnswerFact} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              <tr className="bbs-subtotal">
                <td />
                <td colSpan={span - 2}>{block.label} subtotal</td>
                <td
                  className={block.incomplete === block.rows.length ? 'blocked-total' : 'num'}
                  data-testid={`bbs-subtotal-${block.key}`}
                >
                  {subtotalText(block)}
                </td>
              </tr>
            </tbody>
          ))}
          <tbody>
            <tr className="bbs-total">
              <td />
              <td colSpan={span - 2}>Schedule total</td>
              <td className={totalBlocked ? 'blocked-total' : 'num'} data-testid="bbs-total">
                {totalText}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="bbs-summary">
        <h3>
          Steel summary by diameter <span className="rule" />
        </h3>
        <table className="bbs bbs-summary-table">
          <thead>
            <tr>
              <th>Ø</th>
              <th className="num">Total length</th>
              <th className="num">Weight</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((line) => (
              <tr key={line.diaMm}>
                <td>{line.diaMm} mm</td>
                <td className="num">{line.totalLengthM.toLocaleString('en-IN', { maximumFractionDigits: 1 })} m</td>
                <td className="num">{line.weightKg.toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- the open derivation ----------------------------------------------------

function Derivation({
  row,
  ledger,
  onAnswerFact,
}: {
  row: ScheduleRow;
  ledger?: Ledger;
  onAnswerFact?: (factId: string, value: string) => void;
}) {
  const legs = row.segments.filter((s) => s.mm >= 0);
  const deductions = row.segments.filter((s) => s.mm < 0);
  return (
    <div className="derivation">
      {/* §6.4 / STUDIO_DESIGN §6.1 — an incomplete row is a question, not a
          blank. It opens on the formula with its hole named, where the run
          looked, and the exact ask; answering here writes SUPPLIED to the same
          ledger the Specification writes to. */}
      {row.blocked && (
        <BlockedBlock row={row} ledger={ledger} onAnswerFact={onAnswerFact} />
      )}
      <div className="deriv-top">
        <ShapeDiagram row={row} />
        <div className="deriv-legs">
          {legs.map((s) => (
            <span key={s.label} className="leg-chip num">
              {s.label} = {s.mm.toLocaleString('en-IN')}
            </span>
          ))}
        </div>
      </div>

      <section>
        <h4>
          Cutting length
          <span className={`source-badge ${row.lengthSource.toLowerCase()}`}>
            source: {SOURCE_LABEL[row.lengthSource]}
          </span>
        </h4>
        <table className="deriv-table">
          <tbody>
            {row.segments.map((s, i) => (
              <tr key={i} className={s.mm < 0 ? 'deduction' : undefined}>
                <td className="lbl">{s.mm < 0 ? '—' : s.label}</td>
                <td className="what">{s.note ?? (s.mm < 0 ? 'bend deduction' : legLabel(s.label))}</td>
                <td className="num">
                  {s.mm < 0 ? '−' : ''}
                  {Math.abs(s.mm).toLocaleString('en-IN')} mm
                </td>
              </tr>
            ))}
            <tr className="rule-row">
              <td />
              <td>cutting length</td>
              <td className="num strong">
                {row.cuttingLengthMm === null ? '—' : `${row.cuttingLengthMm.toLocaleString('en-IN')} mm`}
              </td>
            </tr>
          </tbody>
        </table>
        {/* The substituted arithmetic behind the length — shown, never hidden. */}
        {row.lengthWorking && <div className="working num">{row.lengthWorking}</div>}
        {row.status === 'unavailable' && row.missing && (
          <div className="missing">
            <Icon name="warning" size={13} /> {row.missing}
          </div>
        )}
      </section>

      <section>
        <h4>Count</h4>
        <table className="deriv-table">
          <tbody>
            {row.barsPerMember !== null && (
              <tr>
                <td className="lbl" />
                <td className="what">bars per member</td>
                <td className="num">{row.barsPerMember}</td>
              </tr>
            )}
            {row.memberCount !== null && (
              <tr>
                <td className="lbl" />
                <td className="what">members{row.occurrenceBand ? ` · ${row.occurrenceBand}` : ''}</td>
                <td className="num">{row.memberCount}</td>
              </tr>
            )}
            {row.spacingMm !== null && (
              <tr>
                <td className="lbl" />
                <td className="what">spacing c/c</td>
                <td className="num">{row.spacingMm} mm</td>
              </tr>
            )}
            {/* A count that could not be derived is NOT 0. Zero bars weighs
                nothing, adds cleanly into every subtotal and reads as an
                answer; the hole says what is missing instead (§6.4). */}
            <tr className="rule-row">
              <td />
              <td>total bars</td>
              {row.totalBars === null ? (
                <td className="num none" data-testid="count-blocked">
                  not derived — {row.missing ?? 'the count depends on a dimension that is not resolved'}
                </td>
              ) : (
                <td className="num strong">{row.totalBars.toLocaleString('en-IN')}</td>
              )}
            </tr>
          </tbody>
        </table>
        {row.countWorking && <div className="working num">{row.countWorking}</div>}
      </section>

      <section>
        <h4>Weight</h4>
        <div className="working num">
          {row.weightWorking ??
            (row.weightKg !== null && row.unitWeightKgPerM !== null && row.totalLengthM !== null
              ? `${row.unitWeightKgPerM.toFixed(3)} kg/m × ${row.totalLengthM.toLocaleString('en-IN')} m = ${row.weightKg.toLocaleString('en-IN')} kg`
              : 'blocked on the cutting length above')}
        </div>
      </section>

      <section>
        <h4>Evidence</h4>
        <div className="evidence-row">
          {row.fromCallout ? (
            <span className="ev num" title="The callout this row was read from">
              <Icon name="text" size={11} /> “{row.fromCallout}”
            </span>
          ) : null}
          {row.handles.length ? (
            <span className="ev num" title="DXF entity handles behind this row">
              <Icon name="section" size={11} /> {row.handles.length} entities
            </span>
          ) : (
            // §6.3: when there is nothing to highlight, say so — never silence.
            <span className="ev none">
              No geometry recorded — this row came from the schedule table on the sheet.
            </span>
          )}
          <span className={`ev status-${row.status}`}>{row.status}</span>
        </div>
      </section>

      {row.warnings.length > 0 && (
        <section className="deriv-warnings">
          {row.warnings.map((w, i) => (
            <div key={i} className="warning-line">
              <Icon name="warning" size={13} /> {w}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The §6.4 block, rendered through the SHARED renderer (src/facts/blocked.ts)
 * so the schedule, the chat and the Specification cannot drift into three
 * accounts of one hole. `computeWhenResolved` is the gate: once every named
 * fact resolves to a usable value the row stops being a question and says what
 * it is waiting on instead — a rebuild, which spends model calls and is never
 * fired from here.
 */
function BlockedBlock({
  row,
  ledger,
  onAnswerFact,
}: {
  row: ScheduleRow;
  ledger?: Ledger;
  onAnswerFact?: (factId: string, value: string) => void;
}) {
  const blocked = row.blocked!;
  const led = ledger ?? emptyLedger();
  const gate = computeWhenResolved(blocked, led, (facts) =>
    blocked.missingFactIds.map((id) => `${id} = ${String(facts[id].value)}`).join(' · '),
  );

  return (
    <section className="row-blocked" data-testid={`bbs-blocked-${row.id}`}>
      <h4>
        <Icon name="warning" size={13} /> Blocked — this row is a formula, not a number
      </h4>
      <pre className="blocked-formula num" data-testid={`bbs-blocked-formula-${row.id}`}>
        {renderBlockedRow(blocked, led)}
      </pre>
      {gate.computed ? (
        <div className="blocked-answered" data-testid={`bbs-blocked-answered-${row.id}`}>
          Answered: {gate.value}. Rebuild the schedule to compute this row — the engine does the
          arithmetic, and rebuilding spends model calls.
        </div>
      ) : (
        blocked.missingFactIds.map((id, i) => (
          <InlineAnswer
            key={id}
            factId={id}
            ask={blocked.ask[i]}
            disabled={!onAnswerFact}
            onAnswer={(value) => onAnswerFact?.(id, value)}
          />
        ))
      )}
    </section>
  );
}

/** One hole, one input — the same act as answering in the Specification. */
function InlineAnswer({
  factId,
  ask,
  disabled,
  onAnswer,
}: {
  factId: string;
  ask?: string;
  disabled?: boolean;
  onAnswer: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    if (!draft.trim() || disabled) return;
    onAnswer(draft.trim());
    setDraft('');
  };
  return (
    <div className="blocked-answer" data-testid={`bbs-answer-${factId}`}>
      <label htmlFor={`answer-${factId}`}>{ask ?? `What is ${factId}?`}</label>
      <div className="blocked-answer-row">
        <input
          id={`answer-${factId}`}
          type="text"
          value={draft}
          placeholder="value in mm"
          aria-label={`Answer ${factId}`}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={disabled || !draft.trim()}
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
        >
          Answer {factId}
        </button>
      </div>
    </div>
  );
}

function legLabel(label: string): string {
  if (label === 'a') return 'straight run';
  if (label === 'hooks') return 'end hooks';
  return 'leg';
}

// The shape diagram is drawn from the shape code and the leg values — it is
// the row's own geometry, so a wrong leg is visible as a wrong picture.
function ShapeDiagram({ row }: { row: ScheduleRow }) {
  const legs = row.segments.filter((s) => s.mm > 0 && s.label !== 'hooks');
  if (!legs.length) return null;
  const W = 180;
  const H = 72;
  const pad = 14;

  // Walk the legs: the first (longest-run) leg horizontal, turns alternate
  // downward then horizontal — enough to see relative leg proportions.
  const pts: [number, number][] = [[0, 0]];
  let dir: 'h' | 'v' = 'h';
  let x = 0;
  let y = 0;
  legs.forEach((s) => {
    if (dir === 'h') x += s.mm;
    else y += s.mm;
    pts.push([x, y]);
    dir = dir === 'h' ? 'v' : 'h';
  });
  const maxX = Math.max(...pts.map((p) => p[0]), 1);
  const maxY = Math.max(...pts.map((p) => p[1]), 1);
  const sx = (W - pad * 2) / maxX;
  const sy = maxY > 0 ? Math.min((H - pad * 2) / maxY, sx) : sx;
  const path = pts
    .map(([px, py], i) => `${i ? 'L' : 'M'}${(pad + px * sx).toFixed(1)} ${(pad + py * sy).toFixed(1)}`)
    .join(' ');

  return (
    <div className="shape-diagram">
      <span className="shape-code num">SHAPE {row.shapeCode || '00'}</span>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`Shape ${row.shapeCode}`}>
        <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {legs.map((s, i) => {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[i + 1];
          const mx = pad + ((ax + bx) / 2) * sx;
          const my = pad + ((ay + by) / 2) * sy;
          const horizontal = ay === by;
          return (
            <text
              key={s.label}
              x={horizontal ? mx : mx + 8}
              y={horizontal ? my - 5 : my}
              fontSize={10}
              textAnchor={horizontal ? 'middle' : 'start'}
              fill="currentColor"
              opacity={0.75}
            >
              {s.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
