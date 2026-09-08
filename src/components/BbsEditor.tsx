// ============================================================
// EXPAND / EDIT — the whole schedule, full page, the way the workbook prints it.
//
// Every row: calculated, blocked, mismatched, assumed. Every column the
// downloaded Excel carries, in the same order, so what is on screen and what
// is in the file are the same document.
//
// The one thing the screen adds is the distinction the file cannot make:
// INPUT cells are white and typed into, OUTPUT cells are grey and inert.
// Nothing here computes — Save hands the edits to `applyEdits`, which files
// them as USER_INPUT DataFacts and recomputes through `calculations/schedule.ts`.
// ============================================================
import React, { useMemo, useState } from 'react';
import {
  FIELD_BY_ID,
  validateEdit,
  type CellEdit,
  type EditableField,
  type EditableGrid,
  type EditableRow,
  type EditRejection,
  type RowIssue,
} from '../../calculations/bbsEdit';
import { Icon } from './icons';
import './BbsEditor.css';

export interface BbsEditorProps {
  grid: EditableGrid;
  title: string;
  subtitle?: string;
  /** the drawing number and revision the schedule was built from, for the S.No block */
  drawing?: string;
  revision?: string;
  /**
   * Hand the edits over. `asNewVersion` is the DELIBERATE act of filing a
   * revision; without it the schedule being edited is corrected in place —
   * a recalculation is not a version.
   */
  onSave: (
    edits: CellEdit[],
    opts?: { asNewVersion?: boolean; acknowledged?: string[] },
  ) => void | Promise<void>;
  onClose: () => void;
  rejected?: readonly EditRejection[];
  busy?: boolean;
}

type Draft = Record<string, { value: string; confirmed?: boolean }>;

const cellKey = (barMark: string, field: string): string => `${barMark}::${field}`;

const ISSUE_LABEL: Record<RowIssue['kind'], string> = {
  BLOCKED: 'BLOCKED',
  MISMATCH: 'MISMATCH',
  ASSUMED: 'ASSUMED',
};

// ------------------------------------------------------------
// the columns — the workbook's own set, plus the inputs it has no column for
// ------------------------------------------------------------
type Column =
  | { kind: 'input'; id: string; label: string; group: string }
  | { kind: 'output'; id: OutputId; label: string; group: string; numeric?: number | false };

type OutputId =
  | 'sno' | 'member' | 'memberType' | 'mark' | 'location' | 'status'
  | 'coverSource' | 'cuttingLength' | 'lengthSource' | 'barsPerMemberOut' | 'memberCountOut'
  | 'totalBars' | 'totalLength' | 'unitWeight' | 'weight' | 'wastage' | 'weightWithWastage'
  | 'sourceSection' | 'sourceCallout' | 'sourceHandle' | 'factIds' | 'confidence' | 'validation' | 'note';

const input = (id: string, group: string): Column => ({
  kind: 'input',
  id,
  label: FIELD_BY_ID.get(id)?.label ?? id,
  group,
});
const output = (id: OutputId, label: string, group: string, numeric: number | false = false): Column => ({
  kind: 'output',
  id,
  label,
  group,
  numeric,
});

/**
 * §31's column set. Identity and provenance are printed; the engineering
 * inputs are typed into; the computed figures are shown and never editable.
 * The member's own dimensions have no column in the workbook — they are the
 * commonest thing a blocked row is waiting on, so they are here.
 */
const COLUMNS: readonly Column[] = [
  // The two that NAME the row lead and stay put while the rest scrolls —
  // forty-nine columns is a long way to lose track of which bar you are on.
  output('sno', 'S.No', 'identity'),
  output('mark', 'Bar Mark', 'identity'),
  output('member', 'Member Mark', 'identity'),
  output('memberType', 'Member Type', 'identity'),
  output('location', 'Location', 'identity'),
  output('status', 'Status', 'identity'),

  input('memberLength', 'member'),
  input('memberWidth', 'member'),
  input('memberHeight', 'member'),
  input('memberCount', 'member'),

  input('shapeCode', 'bar'),
  input('diaMm', 'bar'),
  input('spacingMm', 'bar'),
  input('distributionAxis', 'bar'),
  input('barsPerMember', 'bar'),
  input('legs', 'bar'),
  input('legA', 'bar'),
  input('legB', 'bar'),
  input('legC', 'bar'),
  input('legD', 'bar'),

  input('coverMm', 'detailing'),
  output('coverSource', 'Cover source', 'detailing'),
  input('endDeductionMm', 'detailing'),
  input('hookStart', 'detailing'),
  input('hookEnd', 'detailing'),
  input('ldMultiple', 'detailing'),
  input('anchorageMm', 'detailing'),
  input('lapMm', 'detailing'),
  input('wastagePct', 'detailing'),
  input('concreteGrade', 'detailing'),
  input('steelGrade', 'detailing'),
  input('enteredCuttingLengthMm', 'detailing'),

  output('cuttingLength', 'Cutting Length (mm)', 'calculated', 0),
  output('lengthSource', 'Length by', 'calculated'),
  output('barsPerMemberOut', 'Bars/Member', 'calculated', 0),
  output('memberCountOut', 'Member Count', 'calculated', 0),
  output('totalBars', 'Total Bars', 'calculated', 0),
  output('totalLength', 'Total Length (m)', 'calculated', 2),
  output('unitWeight', 'Unit Weight (kg/m)', 'calculated', 3),
  output('weight', 'Net Weight (kg)', 'calculated', 2),
  output('wastage', 'Wastage (kg)', 'calculated', 2),
  output('weightWithWastage', 'Gross Weight (kg)', 'calculated', 2),

  output('sourceSection', 'Source Section', 'provenance'),
  output('sourceCallout', 'Source Callout', 'provenance'),
  output('sourceHandle', 'Source Entity/Handle', 'provenance'),
  output('factIds', 'Fact IDs', 'provenance'),
  output('confidence', 'Confidence', 'provenance', 2),
  output('validation', 'Validation', 'provenance'),
  output('note', 'Status / open question', 'provenance'),
];

const GROUP_LABEL: Record<string, string> = {
  identity: '',
  member: 'MEMBER — inputs',
  bar: 'BAR — inputs',
  detailing: 'DETAILING — inputs',
  calculated: 'CALCULATED — read only',
  provenance: 'PROVENANCE',
};

const num = (v: number | null | undefined, digits = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '';

function outputValue(id: OutputId, row: EditableRow, index: number, digits: number | false): string {
  const d = digits === false ? 0 : digits;
  switch (id) {
    case 'sno': return String(index + 1);
    case 'member': return row.memberMark;
    case 'memberType': return row.memberType;
    case 'mark': return row.barMark;
    case 'location': return row.description;
    case 'status': return '';
    case 'coverSource': return row.cells.find((c) => c.field === 'coverMm')?.source ?? '';
    case 'cuttingLength': return num(row.outputs.cuttingLengthMm, d);
    case 'lengthSource': return row.outputs.cuttingLengthMm === null ? '' : row.outputs.lengthSource;
    case 'barsPerMemberOut': return num(row.outputs.barsPerMember, d);
    case 'memberCountOut': return num(row.outputs.memberCount, d);
    case 'totalBars': return num(row.outputs.totalBars, d);
    case 'totalLength': return num(row.outputs.totalLengthM, d);
    case 'unitWeight': return num(row.outputs.unitWeightKgPerM, d);
    case 'weight': return num(row.outputs.weightKg, d);
    case 'wastage':
      return typeof row.outputs.weightWithWastageKg === 'number' && typeof row.outputs.weightKg === 'number'
        ? num(row.outputs.weightWithWastageKg - row.outputs.weightKg, d)
        : '';
    case 'weightWithWastage': return num(row.outputs.weightWithWastageKg, d);
    case 'sourceSection': return row.sourceSection ?? '';
    case 'sourceCallout': return row.sourceCallout ?? '';
    case 'sourceHandle': return row.sourceHandles.join(' ');
    case 'factIds': return row.factIds.join(', ');
    case 'confidence': return num(row.confidence, d);
    case 'validation': return row.status;
    case 'note': return row.note ?? '';
    default: return '';
  }
}

export function BbsEditor({
  grid,
  title,
  subtitle,
  drawing,
  revision,
  onSave,
  onClose,
  rejected = [],
  busy,
}: BbsEditorProps) {
  const [draft, setDraft] = useState<Draft>({});
  // EVERY ROW, by default. A schedule is read as a whole — the finished rows
  // are the context that makes an unfinished one legible.
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  // Disputes the person has ticked in this sitting — signed off on Save.
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

  const rows = useMemo(
    () => (onlyUnresolved ? grid.rows.filter((r) => r.issues.length > 0) : grid.rows),
    [grid, onlyUnresolved],
  );

  const edits = useMemo<CellEdit[]>(
    () =>
      Object.entries(draft)
        .filter(([, d]) => d.value !== undefined)
        .map(([key, d]) => {
          const [barMark, field] = key.split('::');
          return { barMark, field, value: d.value, ...(d.confirmed ? { confirmed: true } : {}) };
        }),
    [draft],
  );

  // Validated as you type, by the same function the save path uses — a cell
  // can never look accepted here and be refused there.
  const localErrors = useMemo(() => {
    const out = new Map<string, string>();
    for (const edit of edits) {
      const field = FIELD_BY_ID.get(edit.field);
      if (!field) continue;
      const check = validateEdit(field, edit.value);
      if (!check.ok) out.set(cellKey(edit.barMark, edit.field), check.reason ?? 'not valid');
      else if (field.requiresEvidence && check.value !== undefined && !edit.confirmed) {
        out.set(cellKey(edit.barMark, edit.field), 'confirm this comes from the drawing or the design');
      }
    }
    for (const r of rejected) out.set(cellKey(r.barMark, r.field), r.reason);
    return out;
  }, [edits, rejected]);

  const counts = grid.validation.counts;
  const standing = grid.disputes.filter((d) => !acknowledged.includes(d));
  const canSave = edits.length > 0 || acknowledged.length > 0;
  const attention = grid.rows.filter((r) => r.issues.length > 0).length;
  const failedGates = grid.validation.gates.filter((g) => !g.ok);

  const set = (barMark: string, field: string, value: string) =>
    setDraft((d) => ({ ...d, [cellKey(barMark, field)]: { ...d[cellKey(barMark, field)], value } }));
  const confirm = (barMark: string, field: string, confirmed: boolean) =>
    setDraft((d) => ({
      ...d,
      [cellKey(barMark, field)]: { value: d[cellKey(barMark, field)]?.value ?? '', confirmed },
    }));

  return (
    <div className="bbsed-overlay" role="dialog" aria-modal="true" aria-label="Edit bar bending schedule">
      <div className="bbsed" data-testid="bbs-editor">
        <header className="bbsed-head">
          <div className="bbsed-title">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className={`bbsed-status ${grid.status === 'FINAL' ? 'is-final' : 'is-incomplete'}`}>
            {grid.status === 'FINAL' ? 'FINAL' : 'INCOMPLETE — ACTION REQUIRED'}
          </div>
          <button type="button" className="bbsed-x" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="bbsed-tally" data-testid="bbs-editor-tally">
          <span>Rows <b>{counts.rows}</b></span>
          <span>Calculated <b>{counts.calculated}</b></span>
          <span>Open <b>{counts.open}</b></span>
          <span>Mismatched <b>{counts.mismatches}</b></span>
          <span>Assumed inputs <b>{counts.assumedInputs}</b></span>
          <span>Missing facts <b>{counts.missingFacts}</b></span>
          <span>Validated <b>{counts.validated}</b>/{counts.rows}</span>
        </div>

        {failedGates.length > 0 && (
          <details className="bbsed-gates" data-testid="bbs-editor-gates">
            <summary>
              Why this schedule is not final — {failedGates.length} of {grid.validation.gates.length} gates
            </summary>
            <ul>
              {failedGates.map((g) => (
                <li key={g.name}>
                  <b>{g.name}</b>
                  {g.detail ? <span> — {g.detail}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        )}

        {grid.disputes.length > 0 && (
          <div className="bbsed-disputes" data-testid="bbs-editor-disputes">
            <h3>
              {standing.length > 0
                ? `${standing.length} unresolved dispute${standing.length === 1 ? '' : 's'} — the arithmetic is not what these doubt`
                : 'Disputes checked — they no longer hold this schedule back'}
            </h3>
            <ul>
              {grid.disputes.map((d) => (
                <li key={d}>
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledged.includes(d)}
                      onChange={(e) =>
                        setAcknowledged((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))
                      }
                      aria-label={`I have checked: ${d.slice(0, 60)}`}
                    />
                    <span>{d}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="bbsed-hint">
              Tick one only when you have checked it against the drawing. Saving records who signed it off and when.
            </p>
          </div>
        )}

        <div className="bbsed-tools">
          <label className="bbsed-toggle">
            <input
              type="checkbox"
              checked={onlyUnresolved}
              onChange={(e) => setOnlyUnresolved(e.target.checked)}
            />
            Show only rows needing attention ({attention})
          </label>
          <span className="bbsed-hint">
            White cells are inputs you can complete. Grey cells are calculated — they update when you save.
          </span>
          <span className="bbsed-showing">
            Showing {rows.length} of {grid.rows.length} rows
          </span>
        </div>

        <div className="bbsed-wrap">
          <table className="bbsed-grid">
            <thead>
              <tr className="bbsed-groups">
                {COLUMNS.map((c, i) => {
                  const first = i === 0 || COLUMNS[i - 1].group !== c.group;
                  if (!first) return null;
                  const span = COLUMNS.filter((x) => x.group === c.group).length;
                  return (
                    <th key={c.group} colSpan={span} className={`bbsed-group is-${c.group}`}>
                      {GROUP_LABEL[c.group]}
                    </th>
                  );
                })}
              </tr>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.id}
                    className={[
                      c.kind === 'input' ? 'bbsed-input-col' : 'bbsed-out',
                      c.id === 'sno' ? 'bbsed-freeze is-first' : c.id === 'mark' ? 'bbsed-freeze is-second' : '',
                    ].join(' ')}
                    title={c.kind === 'input' ? FIELD_BY_ID.get(c.id)?.help : 'Calculated — updates when you save'}
                  >
                    {c.label}
                    {c.kind === 'input' && FIELD_BY_ID.get(c.id)?.requiresEvidence ? (
                      <span className="bbsed-ev" title="Must come from the drawing or the design"> ⚑</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <EditorRow
                  key={row.barMark}
                  row={row}
                  index={grid.rows.indexOf(row)}
                  draft={draft}
                  errors={localErrors}
                  onChange={set}
                  onConfirm={confirm}
                />
              ))}
            </tbody>
          </table>
        </div>

        {attention > 0 && (
          <details className="bbsed-issues" data-testid="bbs-editor-issues" open>
            <summary>What is unresolved ({attention} row{attention === 1 ? '' : 's'})</summary>
            <ul>
              {grid.rows.flatMap((row) =>
                row.issues.map((issue, i) => (
                  <li key={`${row.barMark}-${i}`}>
                    <span className={`bbsed-chip is-${issue.kind.toLowerCase()}`}>{ISSUE_LABEL[issue.kind]}</span>
                    <b>{row.barMark}</b> <span className="bbsed-mem">{row.memberMark}</span>
                    <span className="bbsed-why"> {issue.reason}</span>
                    {issue.suggested ? <em className="bbsed-do"> {issue.suggested}</em> : null}
                    {issue.section ? <span className="bbsed-src"> Looked in: {issue.section}</span> : null}
                  </li>
                )),
              )}
            </ul>
          </details>
        )}

        <footer className="bbsed-foot">
          <span className="bbsed-count">
            {drawing ? <span className="bbsed-drawing">{drawing}{revision ? ` rev ${revision}` : ''} · </span> : null}
            {!canSave
              ? 'Type into a white cell to correct it, then save.'
              : [
                  edits.length ? `${edits.length} edit${edits.length === 1 ? '' : 's'}` : '',
                  acknowledged.length ? `${acknowledged.length} dispute${acknowledged.length === 1 ? '' : 's'} checked` : '',
                  localErrors.size ? `${localErrors.size} to correct` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
          <button type="button" className="btool" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btool"
            title="File the recalculated schedule as the next version, leaving this one as it stands"
            disabled={busy || !canSave || localErrors.size > 0}
            onClick={() => void onSave(edits, { asNewVersion: true, ...(acknowledged.length ? { acknowledged } : {}) })}
            data-testid="bbs-editor-save-new"
          >
            Save as new version
          </button>
          <button
            type="button"
            className="btool is-primary"
            title={`Correct ${title} in place — same file, same version, recalculated`}
            disabled={busy || !canSave || localErrors.size > 0}
            onClick={() => void (acknowledged.length ? onSave(edits, { acknowledged }) : onSave(edits))}
            data-testid="bbs-editor-save"
          >
            <Icon name="save" /> {busy ? 'Recalculating…' : 'Save & recalculate'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function EditorRow({
  row,
  index,
  draft,
  errors,
  onChange,
  onConfirm,
}: {
  row: EditableRow;
  index: number;
  draft: Draft;
  errors: Map<string, string>;
  onChange: (barMark: string, field: string, value: string) => void;
  onConfirm: (barMark: string, field: string, confirmed: boolean) => void;
}) {
  const worst =
    row.issues.find((i) => i.kind === 'BLOCKED') ??
    row.issues.find((i) => i.kind === 'MISMATCH') ??
    row.issues.find((i) => i.kind === 'ASSUMED');

  return (
    <tr className={worst ? `is-${worst.kind.toLowerCase()}` : ''} data-testid={`bbsed-row-${row.barMark}`}>
      {COLUMNS.map((col) => {
        if (col.kind === 'output') {
          if (col.id === 'status') {
            return (
              <td key={col.id} className="bbsed-out">
                <span className={`bbsed-chip is-${(worst?.kind ?? row.status).toLowerCase()}`}>
                  {worst ? ISSUE_LABEL[worst.kind] : row.status}
                </span>
              </td>
            );
          }
          const text = outputValue(col.id, row, index, col.numeric ?? false);
          return (
            <td
              key={col.id}
              className={[
                'bbsed-out',
                col.numeric !== false ? 'is-num' : '',
                col.id === 'sno' ? 'bbsed-freeze is-first' : col.id === 'mark' ? 'bbsed-freeze is-second' : '',
                col.id === 'note' ? 'bbsed-note' : '',
              ].join(' ')}
              title={text}
            >
              {text}
            </td>
          );
        }

        const field = FIELD_BY_ID.get(col.id) as EditableField;
        const cell = row.cells.find((c) => c.field === col.id);
        const key = cellKey(row.barMark, col.id);
        const error = errors.get(key);
        const typed = draft[key];
        const shown = typed?.value ?? (cell?.value === undefined ? '' : String(cell.value));
        return (
          <td
            key={col.id}
            className={[
              'bbsed-cell',
              cell?.blocking ? 'is-wanted' : '',
              error ? 'is-error' : '',
              cell?.source === 'ASSUMED' ? 'is-assumed' : '',
              cell?.source === 'USER_INPUT' ? 'is-user' : '',
            ].join(' ')}
            title={
              error ??
              [field?.help, cell?.source ? `Currently: ${cell.source}` : '', cell?.factId ? `Fact: ${cell.factId}` : '']
                .filter(Boolean)
                .join('\n')
            }
          >
            <input
              value={shown}
              aria-label={`${row.barMark} ${field?.label ?? col.id}`}
              onChange={(e) => onChange(row.barMark, col.id, e.target.value)}
              placeholder={cell?.blocking ? 'needed' : ''}
            />
            {field?.requiresEvidence && typed?.value ? (
              <label className="bbsed-confirm" title="I have read this from the drawing, or the designer stated it">
                <input
                  type="checkbox"
                  checked={typed.confirmed ?? false}
                  onChange={(e) => onConfirm(row.barMark, col.id, e.target.checked)}
                  aria-label={`Confirm ${row.barMark} ${field.label} comes from the drawing`}
                />
                from drawing
              </label>
            ) : null}
            {error ? <span className="bbsed-err">{error}</span> : null}
          </td>
        );
      })}
    </tr>
  );
}
