// ============================================================
// THE EDITABLE SCHEDULE — how a person completes what questioning could not.
//
// This is STAGE 3 and 4 of the workflow, and it does NOT replace stage 1. The
// interview still asks for every fact it can safely ask for, and every answer
// is still a USER_INPUT DataFact. What reaches here is the residue: an input
// the drawing does not state, that the interview could not put a safe question
// to, or that a person must settle because two readings disagree.
//
// Two rules govern everything below.
//
// 1. EXCEL IS NOT A SECOND ENGINE. Nothing here computes a cutting length, a
//    count or a weight. `applyEdits` changes INPUTS and calls `scheduleRow` —
//    the same function `buildBbs` calls — then `buildSteelSummary`,
//    `reconcileSchedule` and `validateSchedule`. The grid is an input surface
//    and a printed output; the arithmetic has exactly one home.
//
// 2. AN EDIT NEVER ERASES A READING. The drawing-derived value and its
//    provenance are kept beside the person's, and the difference is recorded
//    as an OVERRIDE. Nothing is silently replaced, and nothing missing is
//    silently filled with zero or a default.
// ============================================================

import {
  STIRRUP_SHAPES,
  buildSteelSummary,
  reconcileSchedule,
  scheduleRow,
  type Reconciliation,
} from './schedule';
import { validateSchedule, type ScheduleValidation } from './validation';
import { describeBar } from './describe';
import type {
  BbsBar,
  BbsMember,
  BbsRow,
  BbsSettings,
  EngineInputs,
} from '../src/cad/bbs/types';
import type { SummaryLine } from '../src/domain/india/bbs';
import { SHAPES, type ShapeCode } from '../src/domain/india/bbs';

// ------------------------------------------------------------
// what a person may edit
// ------------------------------------------------------------

export type EditScope = 'member' | 'bar' | 'settings';
export type EditUnit = 'mm' | 'count' | 'code' | 'axis' | 'degrees' | 'percent' | 'text';

export interface EditableField {
  id: string;
  label: string;
  scope: EditScope;
  unit: EditUnit;
  /** the group the editor shows it under */
  group: 'dimension' | 'quantity' | 'geometry' | 'detailing' | 'design input';
  /**
   * A value a person cannot safely invent — it must be READ from the drawing
   * or stated by the designer. The editor still offers it, but only against
   * an explicit confirmation that the figure comes from the drawing or the
   * design, and the fact records that confirmation.
   */
  requiresEvidence?: boolean;
  /** what the value means, shown in the editor */
  help: string;
}

/**
 * Every input the schedule computes FROM. Anything not on this list is an
 * OUTPUT — a cutting length the shape formula produced, a total, a weight —
 * and the editor shows it read-only. A schedule where the totals can be typed
 * over is a spreadsheet, not a calculation.
 */
export const EDITABLE_FIELDS: readonly EditableField[] = [
  { id: 'memberLength', label: 'Member length L', scope: 'member', unit: 'mm', group: 'dimension', help: "The member's length in plan, in mm." },
  { id: 'memberWidth', label: 'Member width W', scope: 'member', unit: 'mm', group: 'dimension', help: "The member's width in plan, in mm." },
  { id: 'memberHeight', label: 'Member depth/height H', scope: 'member', unit: 'mm', group: 'dimension', help: 'The depth or height, in mm.' },
  { id: 'memberCount', label: 'Member count', scope: 'member', unit: 'count', group: 'quantity', help: 'How many of this member the job has. Not the number of bars.' },
  { id: 'barsPerMember', label: 'Bars per member', scope: 'bar', unit: 'count', group: 'quantity', help: 'An explicit count for this bar in ONE member. Leave empty to derive it from spacing.' },
  { id: 'diaMm', label: 'Diameter', scope: 'bar', unit: 'mm', group: 'quantity', help: 'Bar diameter in mm.' },
  { id: 'spacingMm', label: 'Spacing c/c', scope: 'bar', unit: 'mm', group: 'quantity', help: 'Centre-to-centre spacing in mm.' },
  { id: 'distributionAxis', label: 'Spaced along', scope: 'bar', unit: 'axis', group: 'geometry', help: 'The member axis these bars march along: L, W or H.' },
  {
    id: 'shapeCode', label: 'Shape code', scope: 'bar', unit: 'code', group: 'geometry', requiresEvidence: true,
    help: 'The bar shape as the detail draws it. Read it from the section — it decides the cutting-length formula.',
  },
  { id: 'legA', label: 'A', scope: 'bar', unit: 'mm', group: 'geometry', requiresEvidence: true, help: 'Leg A as dimensioned on the bar. Leave empty to derive it from the member and cover.' },
  { id: 'legB', label: 'B', scope: 'bar', unit: 'mm', group: 'geometry', requiresEvidence: true, help: 'Leg B as dimensioned on the bar.' },
  { id: 'legC', label: 'C', scope: 'bar', unit: 'mm', group: 'geometry', requiresEvidence: true, help: 'Leg C as dimensioned on the bar.' },
  { id: 'legD', label: 'D', scope: 'bar', unit: 'mm', group: 'geometry', requiresEvidence: true, help: 'Leg D, or the crank angle in degrees for shape 34.' },
  { id: 'legs', label: 'Legs', scope: 'bar', unit: 'count', group: 'geometry', help: 'Legs of a link — 2, 4, 6. Two-legged is one hoop.' },
  { id: 'hookStart', label: 'Hook (start)', scope: 'bar', unit: 'code', group: 'detailing', help: 'none, hook90, hook135 or hook180 — IS 2502 allowances.' },
  { id: 'hookEnd', label: 'Hook (end)', scope: 'bar', unit: 'code', group: 'detailing', help: 'none, hook90, hook135 or hook180.' },
  { id: 'endDeductionMm', label: 'End cover X/Y', scope: 'bar', unit: 'mm', group: 'detailing', help: 'The end gap the schedule states, when it differs from the clear cover.' },
  { id: 'coverMm', label: 'Clear cover', scope: 'settings', unit: 'mm', group: 'dimension', help: 'Clear cover in mm. It is in every arm of every bar.' },
  { id: 'ldMultiple', label: 'Ld multiple', scope: 'settings', unit: 'count', group: 'detailing', help: 'Development length as a multiple of φ, when the office states one. Empty derives it from IS 456.' },
  { id: 'anchorageMm', label: 'Anchorage', scope: 'settings', unit: 'mm', group: 'detailing', help: 'An anchorage length the design states, in mm.' },
  { id: 'lapMm', label: 'Lap', scope: 'settings', unit: 'mm', group: 'detailing', help: 'A lap length the design states, in mm.' },
  { id: 'wastagePct', label: 'Wastage %', scope: 'settings', unit: 'percent', group: 'detailing', help: 'Wastage added to the gross weight.' },
  { id: 'concreteGrade', label: 'Concrete grade', scope: 'settings', unit: 'text', group: 'detailing', help: 'M20, M25, M30 … governs bond stress for Ld.' },
  { id: 'steelGrade', label: 'Steel grade', scope: 'settings', unit: 'text', group: 'detailing', help: 'Fe415, Fe500 … governs σs for Ld.' },
  {
    id: 'enteredCuttingLengthMm', label: 'Entered cutting length', scope: 'bar', unit: 'mm', group: 'design input', requiresEvidence: true,
    help: 'Only where the drawing declares the cutting length a design input, or no geometry on the sheet can fix it. It is recorded as ENTERED, never as derived.',
  },
];

export const FIELD_BY_ID: ReadonlyMap<string, EditableField> = new Map(EDITABLE_FIELDS.map((f) => [f.id, f]));

/** The fact a field writes to, for one row. This is the dependency key. */
export function factIdForField(field: EditableField, memberMark: string): string {
  switch (field.id) {
    case 'memberLength':
      return `${memberMark}.length`;
    case 'memberWidth':
      return `${memberMark}.width`;
    case 'memberHeight':
      return `${memberMark}.height`;
    case 'memberCount':
      return `${memberMark}.count`;
    case 'coverMm':
      return 'settings.cover';
    default:
      return field.scope === 'settings' ? `settings.${snake(field.id)}` : `${memberMark}.${snake(field.id)}`;
  }
}

const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/_mm$/i, '').toLowerCase();

// ------------------------------------------------------------
// validating what was typed
// ------------------------------------------------------------

export type EditValue = number | string | undefined;

export interface EditValidation {
  ok: boolean;
  /** the parsed value, or undefined when the cell was cleared */
  value?: EditValue;
  /** what the value means, in the words the fact records */
  saidAs?: string;
  reason?: string;
}

const AXES = ['L', 'W', 'H'];
const HOOKS = ['none', 'hook90', 'hook135', 'hook180'];

/**
 * Validate one cell against its field's unit. An empty cell CLEARS the input
 * (back to whatever the drawing said); it never becomes zero.
 */
export function validateEdit(field: EditableField, raw: string): EditValidation {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: undefined, saidAs: '' };

  switch (field.unit) {
    case 'mm':
    case 'count':
    case 'percent':
    case 'degrees': {
      // "3500", "3500 mm", "3.5 m", "3,500"
      const cleaned = text.replace(/,/g, '');
      const m = /^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|nos?|no\.?|%|deg|°)?$/i.exec(cleaned);
      if (!m) return { ok: false, reason: `"${text}" is not a number${field.unit === 'mm' ? ' in mm' : ''}` };
      let value = Number(m[1]);
      const unit = (m[2] ?? '').toLowerCase();
      if (field.unit === 'mm') {
        if (unit === 'm') value *= 1000;
        else if (unit === 'cm') value *= 10;
        else if (unit && !['mm'].includes(unit)) return { ok: false, reason: `"${m[2]}" is not a length unit — give mm` };
      }
      if (field.unit === 'count' && !Number.isInteger(value)) {
        return { ok: false, reason: `a count must be a whole number, not ${value}` };
      }
      if (field.unit !== 'percent' && value <= 0) {
        return { ok: false, reason: 'must be greater than zero — a missing value is left empty, never entered as zero' };
      }
      if (field.unit === 'percent' && (value < 0 || value > 100)) {
        return { ok: false, reason: 'a percentage must be between 0 and 100' };
      }
      if (field.unit === 'mm' && value > 100_000) {
        return { ok: false, reason: `${value} mm is over 100 m — check the unit` };
      }
      return { ok: true, value, saidAs: text };
    }
    case 'axis': {
      const axis = text.toUpperCase();
      if (!AXES.includes(axis)) return { ok: false, reason: `the axis must be one of ${AXES.join(', ')}` };
      return { ok: true, value: axis, saidAs: text };
    }
    case 'code': {
      if (field.id === 'shapeCode') {
        const code = text.toUpperCase();
        if (!(code in SHAPES)) {
          return { ok: false, reason: `"${text}" is not a shape code — one of ${Object.keys(SHAPES).join(', ')}` };
        }
        return { ok: true, value: code, saidAs: `${code} (${SHAPES[code as ShapeCode].label})` };
      }
      const hook = text.toLowerCase().replace(/\s|°/g, '');
      const norm = hook === '90' ? 'hook90' : hook === '135' ? 'hook135' : hook === '180' ? 'hook180' : hook;
      if (!HOOKS.includes(norm)) return { ok: false, reason: `a hook must be one of ${HOOKS.join(', ')}` };
      return { ok: true, value: norm, saidAs: text };
    }
    case 'text': {
      if (field.id === 'concreteGrade' && !/^M\s*\d{2,3}$/i.test(text)) {
        return { ok: false, reason: 'a concrete grade looks like M25' };
      }
      if (field.id === 'steelGrade' && !/^Fe\s*\d{3}D?$/i.test(text)) {
        return { ok: false, reason: 'a steel grade looks like Fe500' };
      }
      return { ok: true, value: text.toUpperCase().replace(/\s+/g, ''), saidAs: text };
    }
    default:
      return { ok: false, reason: 'this field cannot be edited' };
  }
}

// ------------------------------------------------------------
// the grid
// ------------------------------------------------------------

export type CellSource = 'DRAWING_READ' | 'USER_INPUT' | 'DERIVED' | 'ASSUMED' | 'MISSING' | 'ENTERED';

export interface EditableCell {
  field: string;
  label: string;
  value: EditValue;
  /** where the current value came from */
  source: CellSource;
  /** the drawing's own value, kept even after a person overrides it */
  drawingValue?: EditValue;
  drawingSource?: string;
  factId: string;
  requiresEvidence: boolean;
  /** this cell is what the row is waiting on */
  blocking: boolean;
}

export type IssueKind = 'BLOCKED' | 'MISMATCH' | 'ASSUMED';

export interface RowIssue {
  kind: IssueKind;
  /** the editable field that would settle it, when one would */
  field?: string;
  factId?: string;
  reason: string;
  /** where on the drawing this was looked for */
  section?: string;
  sourceText?: string;
  suggested?: string;
}

export interface EditableRow {
  barMark: string;
  memberMark: string;
  memberType: string;
  description: string;
  /** the engineering validation of the row as it stands */
  status: 'VALIDATED' | 'PARTIALLY_VALIDATED' | 'UNVALIDATED' | 'REJECTED';
  /** BLOCKED / MISMATCH / ASSUMED, each naming the field that settles it */
  issues: RowIssue[];
  cells: EditableCell[];
  /** what the pipeline computed — never editable */
  outputs: {
    cuttingLengthMm: number | null;
    lengthSource: string;
    barsPerMember: number | null;
    memberCount: number | null;
    totalBars: number | null;
    totalLengthM: number | null;
    unitWeightKgPerM: number | null;
    weightKg: number | null;
    weightWithWastageKg: number | null;
    /** the A/B/C/D the schedule PRINTED — derived from the member unless the bar states its own */
    legs: Partial<Record<'A' | 'B' | 'C' | 'D', number>>;
    coverMm: number | null;
  };
  sourceSection?: string;
  sourceCallout?: string;
  sourceHandles: string[];
  factIds: string[];
  /** the reading confidence of the callout this row was cut from, when one was recorded */
  confidence?: number;
  /** the note a schedule prints in its Status column — BLOCKED …, INFERRED … */
  note?: string;
}

export interface EditableGrid {
  rows: EditableRow[];
  settings: BbsSettings;
  summary: readonly SummaryLine[];
  validation: ScheduleValidation;
  reconciliation?: Reconciliation;
  /** the whole schedule's headline — INCOMPLETE until every gate passes */
  status: 'FINAL' | 'INCOMPLETE';
  blockers: string[];
  /**
   * What the schedule itself disputes — a sanity check, an independent
   * verifier, a referee gate. Not tied to one row, and not answerable by
   * arithmetic: each stands until a person says they have checked it.
   */
  disputes: string[];
}

/** Which fact a blocked row named, mapped to the field that would settle it. */
function fieldForFact(factId: string | undefined): string | undefined {
  if (!factId) return undefined;
  if (factId === 'settings.cover') return 'coverMm';
  if (/\.length$/.test(factId)) return 'memberLength';
  if (/\.width$/.test(factId)) return 'memberWidth';
  if (/\.height$/.test(factId)) return 'memberHeight';
  if (/\.count$/.test(factId)) return 'memberCount';
  if (/total_run$/.test(factId)) return 'memberLength';
  return undefined;
}

/**
 * Everything a person must see about one row: what it computed, what it is
 * waiting on, what rests on an assumption, and which readings disagree. A
 * blocked row is never hidden — it is the reason this view exists.
 */
export function rowIssues(row: BbsRow): RowIssue[] {
  const issues: RowIssue[] = [];
  const trace = row.trace;

  if (trace?.failedStage) {
    const field =
      fieldForFact(trace.missingFact) ??
      (trace.failedStage === 'CUTTING_LENGTH_RESOLVED' ? 'enteredCuttingLengthMm' : undefined);
    issues.push({
      kind: 'BLOCKED',
      ...(field ? { field } : {}),
      ...(trace.missingFact ? { factId: trace.missingFact } : {}),
      reason: trace.reason ?? row.missing ?? `stopped at ${trace.failedStage}`,
      ...(trace.source ? { section: trace.source } : {}),
      ...(trace.sourceText ? { sourceText: trace.sourceText } : {}),
      ...(trace.action ? { suggested: trace.action } : {}),
    });
  }

  if (row.secondOpinion && !row.secondOpinion.withinTolerance) {
    const so = row.secondOpinion;
    issues.push({
      kind: 'MISMATCH',
      field: 'shapeCode',
      reason:
        `two derivations of this cutting length disagree: ${so.primaryMm.toFixed(0)} mm from the shape formula, ` +
        `${so.lengthMm.toFixed(0)} mm built up from arms, bends and hooks (difference ${so.diffMm.toFixed(0)} mm, ` +
        `tolerance ${so.toleranceMm.toFixed(0)} mm). Neither was chosen.`,
      suggested: 'Confirm the shape the detail draws, or enter the cutting length the design requires.',
    });
  }

  if (row.disputedAxis) {
    issues.push({
      kind: 'MISMATCH',
      field: row.disputedAxis === 'L' ? 'memberLength' : row.disputedAxis === 'W' ? 'memberWidth' : 'memberHeight',
      reason: `two readings of ${row.memberMark}'s ${row.disputedAxis} disagree — the row used one of them.`,
      suggested: `State ${row.memberMark} ${row.disputedAxis} and the row recomputes.`,
    });
  }

  const coverStatus = row.coverStatus ?? trace?.coverStatus;
  if (coverStatus === 'ASSUMED') {
    issues.push({
      kind: 'ASSUMED',
      field: 'coverMm',
      factId: 'settings.cover',
      reason: `cover ${row.coverMm ?? '?'} mm is the project default — this sheet does not state it.`,
      suggested: 'Give the clear cover and every dependent row recomputes.',
    });
  }
  for (const [axis, src] of Object.entries(trace?.dimSources ?? {})) {
    if (typeof src === 'string' && /^(ASSUMED|PROJECT_DEFAULT|DEFAULT)\b/i.test(src)) {
      issues.push({
        kind: 'ASSUMED',
        field: axis === 'L' ? 'memberLength' : axis === 'W' ? 'memberWidth' : 'memberHeight',
        factId: `${row.memberMark}.${axis === 'L' ? 'length' : axis === 'W' ? 'width' : 'height'}`,
        reason: `${row.memberMark} ${axis} is assumed — ${src}`,
      });
    }
  }
  return issues;
}

function cellValue(field: EditableField, bar: BbsBar, member: BbsMember, settings: BbsSettings, entered?: number): EditValue {
  switch (field.id) {
    case 'memberLength': return member.lengthMm;
    case 'memberWidth': return member.widthMm;
    case 'memberHeight': return member.heightMm;
    case 'memberCount': return member.count > 0 ? member.count : undefined;
    case 'barsPerMember': return bar.manualCount;
    case 'diaMm': return bar.diaMm;
    case 'spacingMm': return bar.spacingMm;
    case 'distributionAxis': return bar.distributionAxis;
    case 'shapeCode': return bar.shapeCode;
    case 'legA': return bar.legDimsMm?.A;
    case 'legB': return bar.legDimsMm?.B;
    case 'legC': return bar.legDimsMm?.C;
    case 'legD': return bar.legDimsMm?.D;
    case 'legs': return bar.legs;
    case 'hookStart': return bar.hookStart;
    case 'hookEnd': return bar.hookEnd;
    case 'endDeductionMm': return bar.endDeductionMm;
    case 'coverMm': return member.coverMm ?? settings.coverMm;
    case 'ldMultiple': return settings.ldMultiple;
    case 'anchorageMm': return settings.anchorageMm;
    case 'lapMm': return settings.lapMm;
    case 'wastagePct': return settings.wastagePct;
    case 'concreteGrade': return settings.concreteGrade;
    case 'steelGrade': return settings.steelGrade;
    case 'enteredCuttingLengthMm': return entered;
    default: return undefined;
  }
}

function sourceOfCell(field: EditableField, row: BbsRow, member: BbsMember, value: EditValue): CellSource {
  if (value === undefined || value === null) return 'MISSING';
  if (field.id === 'enteredCuttingLengthMm') return 'ENTERED';
  const axis = field.id === 'memberLength' ? 'L' : field.id === 'memberWidth' ? 'W' : field.id === 'memberHeight' ? 'H' : null;
  if (axis) {
    const src = member.dimSources?.[axis] ?? row.trace?.dimSources?.[axis] ?? '';
    if (/^USER_INPUT/i.test(src)) return 'USER_INPUT';
    if (/^DRAWING_READ|schedule table|read from/i.test(src)) return 'DRAWING_READ';
    if (/^ASSUMED|PROJECT_DEFAULT/i.test(src)) return 'ASSUMED';
    if (/^DERIVED/i.test(src)) return 'DERIVED';
    return 'DRAWING_READ';
  }
  if (field.id === 'coverMm') {
    const status = row.coverStatus ?? row.trace?.coverStatus;
    return status === 'ASSUMED' ? 'ASSUMED' : status === 'USER_INPUT' ? 'USER_INPUT' : 'DRAWING_READ';
  }
  if (field.scope === 'settings') return 'DERIVED';
  return 'DRAWING_READ';
}

/**
 * The editable schedule for a built result. EVERY row appears — calculated,
 * blocked, mismatched — because the point of this view is the ones that are
 * not finished.
 */
export function buildEditGrid(
  rows: readonly BbsRow[],
  inputs: EngineInputs,
  extras: {
    summary?: readonly SummaryLine[];
    reconciliation?: Reconciliation;
    validation?: ScheduleValidation;
    drawingHashMatches?: boolean;
    /** rows a reconstruction could not reproduce — see `reconstructEngineInputs` */
    unreproduced?: readonly string[];
    /** disputes the filed schedule carries, minus any a person has acknowledged */
    disputes?: readonly string[];
    /** the referee's gates passed on the build this came from */
    verificationOk?: boolean;
  } = {},
): EditableGrid {
  const settings = inputs.settings;
  const summary = extras.summary ?? buildSteelSummary(rows, settings.wastagePct);
  const reconciliation = extras.reconciliation ?? reconcileSchedule(rows, summary);
  const validation =
    extras.validation ??
    validateSchedule(rows, {
      reconciliationOk: reconciliation.ok,
      drawingHashMatches: extras.drawingHashMatches,
      ...(extras.disputes ? { disputes: extras.disputes } : {}),
      ...(extras.verificationOk !== undefined ? { verificationOk: extras.verificationOk } : {}),
    });

  const editable: EditableRow[] = rows.map((row) => {
    const bar = inputs.bars[row.barMark] ?? ({ memberMark: row.memberMark, diaMm: row.diaMm, shapeCode: row.shapeCode, barType: row.barType, fromCallout: row.fromCallout, handles: row.handles } as BbsBar);
    const member = inputs.members[row.memberMark] ?? ({ mark: row.memberMark, type: '', count: 0, source: { table: '', row: 0 }, incomplete: true, missing: [] } as BbsMember);
    const issues = rowIssues(row);
    if (extras.unreproduced?.includes(row.barMark)) {
      // Not editable, and said so plainly: the filed schedule's own numbers
      // could not be reproduced from what it recorded, so an edit here would
      // be a change to something nobody can see.
      issues.push({
        kind: 'MISMATCH',
        reason:
          'this row was filed before the schedule recorded the inputs it was computed from, and its ' +
          'numbers could not be reproduced from what it does record. Rebuild the BBS for this drawing to edit it.',
      });
    }
    const blockingFields = new Set(issues.filter((i) => i.kind !== 'ASSUMED').map((i) => i.field).filter(Boolean) as string[]);
    const entered = inputs.enteredCuttingLengthMm?.[row.barMark];

    const cells: EditableCell[] = EDITABLE_FIELDS.map((field) => {
      const value = cellValue(field, bar, member, settings, entered);
      return {
        field: field.id,
        label: field.label,
        value,
        source: sourceOfCell(field, row, member, value),
        factId: factIdForField(field, row.memberMark),
        requiresEvidence: field.requiresEvidence === true,
        blocking: blockingFields.has(field.id),
      };
    });

    return {
      barMark: row.barMark,
      memberMark: row.memberMark,
      memberType: member.type || '',
      description: row.description,
      status: row.engineering ?? 'UNVALIDATED',
      issues,
      cells,
      outputs: {
        cuttingLengthMm: row.cuttingLengthMm,
        lengthSource: row.lengthSource,
        barsPerMember: row.barsPerMember,
        memberCount: row.memberCount,
        totalBars: row.totalBars,
        totalLengthM: row.totalLengthM,
        unitWeightKgPerM: row.unitWeightKgPerM,
        weightKg: row.weightKg,
        weightWithWastageKg: row.weightWithWastageKg ?? null,
        legs: Object.fromEntries(
          (row.segments ?? [])
            .filter((seg) => ['A', 'B', 'C', 'D'].includes(seg.label))
            .map((seg) => [seg.label, seg.mm]),
        ),
        coverMm: row.coverMm ?? row.trace?.coverMm ?? null,
      },
      ...(row.trace?.source ? { sourceSection: row.trace.source } : {}),
      sourceCallout: row.fromCallout,
      sourceHandles: [...(row.handles ?? [])],
      factIds: [...(row.trace?.factsUsed ?? [])],
      ...(typeof row.confidence === 'number' ? { confidence: row.confidence } : {}),
      ...(row.missing ? { note: row.missing } : row.warnings[0] ? { note: row.warnings[0] } : {}),
    };
  });

  return {
    rows: editable,
    settings,
    summary,
    validation,
    reconciliation,
    status: validation.final ? 'FINAL' : 'INCOMPLETE',
    blockers: validation.blockers,
    disputes: [...(extras.disputes ?? [])],
  };
}

// ------------------------------------------------------------
// stage 1 before stage 3 — what to ASK before anything is typed
// ------------------------------------------------------------

/**
 * A question the interview should put before the editable schedule is needed.
 *
 * THE EDITOR DOES NOT REPLACE THE INTERVIEW. Everything a person can safely
 * be ASKED is asked — once, keyed by the fact it writes to, so ten rows
 * waiting on one cover produce one question. What is left over is the
 * residue: figures that cannot be safely answered in words because they must
 * be READ off a drawing or stated by a designer. Those are `editorOnly`, and
 * they are what the editable schedule exists for.
 */
export interface PendingQuestion {
  /** stable identity — the fact the answer writes to. Never asked twice. */
  dependencyKey: string;
  factId: string;
  field?: string;
  question: string;
  why: string;
  /** the rows this one answer unblocks */
  blocks: string[];
  /** no safe question can be put — it must be completed in the editable schedule */
  editorOnly: boolean;
  suggested?: string;
}

/**
 * Every unresolved input in the schedule, as one question per dependency.
 *
 * `alreadyAsked` holds dependency keys already put to someone, so a rebuild
 * never re-asks a settled question. A row blocked on a fact somebody already
 * answered is a propagation bug, not a question.
 */
export function questionsFor(
  grid: EditableGrid,
  alreadyAsked: ReadonlySet<string> = new Set(),
): PendingQuestion[] {
  const byKey = new Map<string, PendingQuestion>();

  for (const row of grid.rows) {
    for (const issue of row.issues) {
      if (issue.kind === 'ASSUMED' && !issue.factId) continue;
      const field = issue.field ? FIELD_BY_ID.get(issue.field) : undefined;
      const factId = issue.factId ?? (field ? factIdForField(field, row.memberMark) : undefined);
      if (!factId) continue;
      if (alreadyAsked.has(factId)) continue;

      const existing = byKey.get(factId);
      if (existing) {
        if (!existing.blocks.includes(row.barMark)) existing.blocks.push(row.barMark);
        continue;
      }
      byKey.set(factId, {
        dependencyKey: factId,
        factId,
        ...(issue.field ? { field: issue.field } : {}),
        question: questionText(factId, field, row),
        why: issue.reason,
        blocks: [row.barMark],
        // A shape, a leg dimension or a design cutting length cannot be
        // invented at a keyboard — it is read off the detail or stated by the
        // designer. Asking "what shape is it?" in a chat box invites a guess,
        // so these go to the editable schedule, where the source is confirmed.
        editorOnly: field?.requiresEvidence === true,
        ...(issue.suggested ? { suggested: issue.suggested } : {}),
      });
    }
  }
  return [...byKey.values()];
}

function questionText(factId: string, field: EditableField | undefined, row: EditableRow): string {
  if (factId === 'settings.cover') return 'What is the clear cover, in mm?';
  if (/\.count$/.test(factId)) return `How many ${row.memberMark} are there in the whole job?`;
  if (/\.length$/.test(factId)) return `What is ${row.memberMark}'s length, in mm?`;
  if (/\.width$/.test(factId)) return `What is ${row.memberMark}'s width, in mm?`;
  if (/\.height$/.test(factId)) return `What is ${row.memberMark}'s depth or height, in mm?`;
  if (field?.requiresEvidence) return `${row.barMark}: ${field.label} must be read from the drawing — complete it in the editable schedule.`;
  return `${row.barMark}: ${field?.label ?? factId} is not on record.`;
}

// ------------------------------------------------------------
// what the schedule itself disputes
// ------------------------------------------------------------

/**
 * The disputes a filed schedule carries, minus the ones a person has already
 * acknowledged.
 *
 * These are the findings that are NOT about one row's arithmetic: a sanity
 * check saying the steel per metre is a fraction of what this kind of
 * structure carries, an independent verifier rejecting a placement count, a
 * referee gate that failed. Every row can compute and the schedule still rest
 * on something nobody has settled — so they are carried, shown, and they hold
 * FINAL back until somebody says they have checked them.
 *
 * A warning that names a member belongs to that row and is already reported
 * there; only the schedule-level ones are disputes.
 */
export function disputesOf(
  filed: {
    warnings?: readonly { message: string; memberMark?: string }[];
    verification?: { ok?: boolean; failures?: readonly { gate?: string; message: string }[] };
    acknowledged?: readonly { dispute: string }[];
  },
  acknowledgedNow: readonly string[] = [],
): string[] {
  const settled = new Set([
    ...(filed.acknowledged ?? []).map((a) => a.dispute),
    ...acknowledgedNow,
  ]);
  const out: string[] = [];
  for (const w of filed.warnings ?? []) {
    if (w.memberMark) continue;
    if (!settled.has(w.message)) out.push(w.message);
  }
  for (const f of filed.verification?.failures ?? []) {
    const message = f.gate ? `${f.gate}: ${f.message}` : f.message;
    if (!settled.has(message)) out.push(message);
  }
  return out;
}

/** One dispute, checked and signed off by a person. */
export interface DisputeAcknowledgement {
  dispute: string;
  by: string;
  at: number;
}

// ------------------------------------------------------------
// a schedule filed before its inputs were recorded
// ------------------------------------------------------------
//
// Builds record `engineInputs` now, so a filed schedule can be rebuilt
// exactly. Schedules filed BEFORE that do not carry them — and telling
// someone to re-run a whole drawing to correct one width would be a poor
// answer when the artifact already prints every input it was computed from:
// the member's dimensions and count, the bar's diameter, spacing, shape and
// cover, and a trace naming how the count was arrived at.
//
// So the inputs are RECONSTRUCTED and then CHECKED. Each bar is rebuilt, run
// back through `scheduleRow`, and compared with the row as filed. A bar that
// reproduces exactly was reconstructed correctly — that is what "exactly"
// means. One that does not is reported by name and left un-editable, rather
// than being quietly edited into something the filed schedule never said.

export interface Reconstruction {
  inputs: EngineInputs;
  /** rows the reconstruction could not reproduce — editing these is refused */
  unreproduced: string[];
}

/** What a filed schedule carries, in the shape this file needs. Structural, so no import cycle. */
interface FiledSchedule {
  rows: readonly {
    barMark: string;
    memberMark: string;
    description?: string;
    diameterMm: number;
    spacingMm?: number;
    memberCount?: number;
    barsPerMember?: number;
    totalBars?: number;
    cuttingLengthMm?: number;
    coverMm?: number;
    coverSource?: string;
    shapeCode?: string;
    location?: string;
    handles?: string[];
    sourceHandles?: string[];
    trace?: {
      sourceText?: string;
      sourceHandles?: string[];
      measuredAlong?: 'L' | 'W' | 'H';
      dimSources?: Partial<Record<'L' | 'W' | 'H', string>>;
      method?: { quantity?: string };
    };
  }[];
  members?: readonly {
    mark: string;
    type?: string;
    count?: number;
    dims?: { L?: number; W?: number; H?: number };
    coverMm?: number;
    coverSource?: string;
  }[];
  settings?: BbsSettings;
  project?: { runMm?: number };
}

const AXIS_CANDIDATES: readonly (('L' | 'W' | 'H') | undefined)[] = [undefined, 'L', 'W', 'H'];

const near = (a: number | null | undefined, b: number | null | undefined): boolean => {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  return Math.abs(a - b) <= 0.005 * Math.max(1, Math.abs(a));
};

/**
 * Rebuild the inputs a filed schedule was computed from, and say which rows
 * the rebuild could not reproduce. Returns null when the artifact does not
 * even carry rows and members — there is nothing to reconstruct from.
 */
export function reconstructEngineInputs(filed: FiledSchedule): Reconstruction | null {
  if (!Array.isArray(filed.rows) || !filed.rows.length || !filed.settings) return null;

  const members: Record<string, BbsMember> = {};
  for (const m of filed.members ?? []) {
    // the dimension SOURCES live on the rows' traces, not on the member
    const fromRow = filed.rows.find((r) => r.memberMark === m.mark)?.trace?.dimSources;
    members[m.mark] = {
      mark: m.mark,
      type: m.type ?? '',
      count: m.count ?? 0,
      ...(m.dims?.L ? { lengthMm: m.dims.L } : {}),
      ...(m.dims?.W ? { widthMm: m.dims.W } : {}),
      ...(m.dims?.H ? { heightMm: m.dims.H } : {}),
      ...(fromRow ? { dimSources: { ...fromRow } } : {}),
      ...(m.coverMm !== undefined ? { coverMm: m.coverMm } : {}),
      ...(m.coverSource !== undefined ? { coverSource: m.coverSource } : {}),
      source: { table: '', row: 0 },
      incomplete: false,
      missing: [],
    };
  }

  const settings = { ...filed.settings };
  const inputs: EngineInputs = {
    bars: {},
    members,
    settings,
    runMm: filed.project?.runMm ?? null,
    coverTable: [],
    takeoffCounts: {},
    enteredCuttingLengthMm: {},
    declaredInputs: {},
  };

  const unreproduced: string[] = [];
  for (const row of filed.rows) {
    const member = members[row.memberMark];
    if (!member) {
      unreproduced.push(row.barMark);
      continue;
    }
    const shapeCode = ((row.shapeCode || '00') as ShapeCode) in SHAPES ? ((row.shapeCode || '00') as ShapeCode) : '00';
    const base: BbsBar = {
      memberMark: row.memberMark,
      diaMm: row.diameterMm,
      shapeCode,
      barType: (row.location as BbsBar['barType']) || (STIRRUP_SHAPES.has(shapeCode) ? 'STIRRUP' : 'MAIN'),
      fromCallout: row.trace?.sourceText ?? row.description ?? '',
      handles: [...(row.handles ?? row.trace?.sourceHandles ?? [])],
      ...(row.spacingMm ? { spacingMm: row.spacingMm } : {}),
      // A count the filed row reached MANUALLY was an explicit input; one it
      // derived from spacing must stay derived, or editing the spacing would
      // change nothing.
      ...(row.trace?.method?.quantity === 'MANUAL' && row.barsPerMember
        ? { manualCount: row.barsPerMember }
        : {}),
    };

    // The axis a bar marches along is not printed, so it is SEARCHED for:
    // the candidate that reproduces the filed length and count is the one the
    // build used. A row that reproduces under no candidate is reported.
    let chosen: BbsBar | null = null;
    for (const axis of AXIS_CANDIDATES) {
      const candidate: BbsBar = axis ? { ...base, distributionAxis: axis } : { ...base };
      const built = scheduleRow({
        bar: candidate,
        member,
        settings,
        runMm: inputs.runMm,
        takeoffCount: null,
        coverTable: [],
        barMark: row.barMark,
        description: row.description ?? '',
      });
      if (
        near(built.row.cuttingLengthMm, row.cuttingLengthMm ?? null) &&
        near(built.row.barsPerMember, row.barsPerMember ?? null) &&
        near(built.row.totalBars, row.totalBars ?? null)
      ) {
        chosen = candidate;
        break;
      }
    }
    inputs.bars[row.barMark] = chosen ?? base;
    if (!chosen) unreproduced.push(row.barMark);
  }

  return { inputs, unreproduced };
}

// ------------------------------------------------------------
// the Excel round trip
// ------------------------------------------------------------
//
// The workbook this product writes is the same schedule the grid shows, so a
// person can take it away, complete it in Excel and bring it back. What
// returns is a set of CELL EDITS — never a calculation. A cutting length
// typed into the workbook is an ENTERED design input, recorded as such, and
// the totals beside it are recomputed here rather than read from the file.

/** The workbook's column headings, mapped to the inputs they carry. */
export const EXPORT_LABEL_TO_FIELD: Readonly<Record<string, string>> = {
  'Member Count': 'memberCount',
  'Bars/Member': 'barsPerMember',
  'Dia (mm)': 'diaMm',
  'Spacing c/c (mm)': 'spacingMm',
  'Cover (mm)': 'coverMm',
  Shape: 'shapeCode',
  'A (mm)': 'legA',
  'B (mm)': 'legB',
  'C (mm)': 'legC',
  'D (mm)': 'legD',
  'Cutting Length (mm)': 'enteredCuttingLengthMm',
};

/** The column a person ticks to say an evidence-bearing figure came from the drawing. */
export const CONFIRM_COLUMN_LABEL = 'Confirm from drawing';

const isTruthy = (v: unknown): boolean =>
  typeof v === 'number' ? v !== 0 : /^(y|yes|true|1|x|✓|confirmed)$/i.test(String(v ?? '').trim());

/**
 * What the workbook PRINTED in this column.
 *
 * Several columns show a computed figure when the bar states no input of its
 * own: "Bars/Member" prints the count derived from spacing, "A (mm)" prints
 * the leg derived from the member and the cover. Comparing a returned
 * workbook against the INPUT would call every one of those a correction. The
 * comparison is against what was printed, so an untouched file yields nothing.
 */
function printedValue(field: string, row: EditableRow, cell: EditableCell | undefined): EditValue {
  switch (field) {
    case 'barsPerMember':
      return row.outputs.barsPerMember ?? undefined;
    case 'memberCount':
      return row.outputs.memberCount ?? undefined;
    case 'enteredCuttingLengthMm':
      return row.outputs.cuttingLengthMm ?? undefined;
    case 'legA':
    case 'legB':
    case 'legC':
    case 'legD':
      return row.outputs.legs[field.slice(3) as 'A' | 'B' | 'C' | 'D'] ?? cell?.value;
    case 'coverMm':
      return row.outputs.coverMm ?? cell?.value;
    default:
      return cell?.value;
  }
}

const same = (a: EditValue, b: string | number | null): boolean => {
  if (a === undefined || a === null) return b === null || String(b ?? '').trim() === '';
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.0005;
  return String(a).trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
};

/**
 * Read an edited workbook back as cell edits.
 *
 * Only cells that CHANGED become edits — reimporting an untouched workbook
 * produces nothing, so a round trip is never mistaken for a correction. A
 * heading the schedule does not own is ignored rather than guessed at.
 */
export function editsFromWorkbook(
  grid: EditableGrid,
  sheet: readonly (readonly (string | number | null)[])[],
): CellEdit[] {
  const headerAt = sheet.findIndex((row) => row.some((c) => String(c ?? '').trim() === 'Bar Mark'));
  if (headerAt < 0) return [];
  const header = sheet[headerAt].map((c) => String(c ?? '').trim());
  const markAt = header.indexOf('Bar Mark');
  const confirmAt = header.indexOf(CONFIRM_COLUMN_LABEL);
  const columns = header
    .map((label, index) => ({ index, field: EXPORT_LABEL_TO_FIELD[label] }))
    .filter((c): c is { index: number; field: string } => Boolean(c.field));
  if (markAt < 0 || !columns.length) return [];

  const byMark = new Map(grid.rows.map((r) => [r.barMark, r]));
  const edits: CellEdit[] = [];
  for (const line of sheet.slice(headerAt + 1)) {
    const barMark = String(line[markAt] ?? '').trim();
    const row = byMark.get(barMark);
    if (!row) continue;
    const confirmed = confirmAt >= 0 ? isTruthy(line[confirmAt]) : false;
    for (const { index, field } of columns) {
      const cell = row.cells.find((c) => c.field === field);
      if (!cell) continue;
      const raw = line[index] ?? null;
      // A BLANK CELL IS NOT AN INSTRUCTION. Columns the export leaves empty
      // are common, and reading one as "clear this input" would silently
      // delete a reading. Clearing is done in the grid, deliberately.
      if (raw === null || String(raw).trim() === '') continue;
      if (same(printedValue(field, row, cell), raw)) continue;
      edits.push({
        barMark,
        field,
        value: raw === null ? '' : String(raw),
        ...(confirmed ? { confirmed: true } : {}),
      });
    }
  }
  return edits;
}

// ------------------------------------------------------------
// applying edits
// ------------------------------------------------------------

export interface CellEdit {
  barMark: string;
  field: string;
  /** as typed; empty clears the input back to what the drawing said */
  value: string;
  /** the person confirms an evidence-bearing figure comes from the drawing or the design */
  confirmed?: boolean;
}

/** A USER_INPUT DataFact an edit produced, with the reading it stands beside. */
export interface EditedFact {
  factId: string;
  value: number | string | null;
  unit?: string;
  saidAs: string;
  /** what the drawing said, kept whatever the person types */
  previous?: { value: number | string | null; source: CellSource };
  /** the person's value differs from a drawing-derived one */
  override: boolean;
  /** an evidence-bearing field the person explicitly confirmed */
  confirmed?: boolean;
  /** the rows that read this fact */
  affects: string[];
}

export interface EditRejection {
  barMark: string;
  field: string;
  value: string;
  reason: string;
}

/**
 * ONE EDIT, KEPT.
 *
 * A schedule corrected in place keeps its version, so the record of what
 * changed has to live somewhere: here, on the artifact itself, alongside the
 * calculation run each save files. Every entry names the fact, the value it
 * replaced and where that value came from, so "the width was 3000 because
 * the schedule table said so, and is 2900 because a person said so on the
 * 7th" is answerable from the document alone.
 */
export interface BbsEditEvent {
  at: number;
  by: string;
  edits: {
    factId: string;
    to: number | string | null;
    from?: number | string | null;
    fromSource?: CellSource;
    override: boolean;
    confirmed?: boolean;
    affects: string[];
  }[];
  /** disputes this save signed off */
  acknowledged?: string[];
  rowsRecalculated: string[];
  statusBefore: 'FINAL' | 'INCOMPLETE';
  statusAfter: 'FINAL' | 'INCOMPLETE';
  reconciled: boolean;
  netWeightKg: number;
}

export interface AppliedEdits {
  /** the recalculated schedule — through `scheduleRow`, never through this file */
  rows: BbsRow[];
  summary: SummaryLine[];
  reconciliation: Reconciliation;
  validation: ScheduleValidation;
  inputs: EngineInputs;
  /** the USER_INPUT DataFacts to persist */
  facts: EditedFact[];
  /** edits that did not pass validation — nothing was changed for these */
  rejected: EditRejection[];
  /** the rows whose inputs changed, directly or through a shared fact */
  invalidated: string[];
  status: 'FINAL' | 'INCOMPLETE';
}

function clone(inputs: EngineInputs): EngineInputs {
  return {
    bars: Object.fromEntries(Object.entries(inputs.bars).map(([k, v]) => [k, { ...v, ...(v.legDimsMm ? { legDimsMm: { ...v.legDimsMm } } : {}) }])),
    members: Object.fromEntries(Object.entries(inputs.members).map(([k, v]) => [k, { ...v }])),
    settings: { ...inputs.settings },
    runMm: inputs.runMm,
    coverTable: [...inputs.coverTable],
    takeoffCounts: { ...inputs.takeoffCounts },
    enteredCuttingLengthMm: { ...(inputs.enteredCuttingLengthMm ?? {}) },
    declaredInputs: { ...(inputs.declaredInputs ?? {}) },
  };
}

function setLeg(bar: BbsBar, leg: 'A' | 'B' | 'C' | 'D', value: EditValue): void {
  const dims = { ...(bar.legDimsMm ?? {}) };
  if (typeof value === 'number') dims[leg] = value;
  else delete dims[leg];
  if (Object.keys(dims).length) bar.legDimsMm = dims;
  else delete bar.legDimsMm;
}

/** Write one validated value onto the inputs. Returns false when the field is unknown. */
function writeValue(inputs: EngineInputs, edit: CellEdit, field: EditableField, value: EditValue): boolean {
  const bar = inputs.bars[edit.barMark];
  const memberMark = bar?.memberMark ?? edit.barMark.split('-')[0];
  const member = inputs.members[memberMark];
  const num = typeof value === 'number' ? value : undefined;

  switch (field.id) {
    case 'memberLength': if (!member) return false; member.lengthMm = num; return true;
    case 'memberWidth': if (!member) return false; member.widthMm = num; return true;
    case 'memberHeight': if (!member) return false; member.heightMm = num; return true;
    case 'memberCount': if (!member) return false; member.count = num ?? 0; return true;
    case 'barsPerMember': if (!bar) return false; bar.manualCount = num; return true;
    case 'diaMm': if (!bar || num === undefined) return false; bar.diaMm = num; return true;
    case 'spacingMm': if (!bar) return false; bar.spacingMm = num; return true;
    case 'distributionAxis': if (!bar) return false; bar.distributionAxis = value as 'L' | 'W' | 'H' | undefined; return true;
    case 'shapeCode': if (!bar || value === undefined) return false; bar.shapeCode = value as ShapeCode; return true;
    case 'legA': if (!bar) return false; setLeg(bar, 'A', value); return true;
    case 'legB': if (!bar) return false; setLeg(bar, 'B', value); return true;
    case 'legC': if (!bar) return false; setLeg(bar, 'C', value); return true;
    case 'legD': if (!bar) return false; setLeg(bar, 'D', value); return true;
    case 'legs': if (!bar) return false; bar.legs = num; return true;
    case 'hookStart': if (!bar) return false; bar.hookStart = value as BbsBar['hookStart']; return true;
    case 'hookEnd': if (!bar) return false; bar.hookEnd = value as BbsBar['hookEnd']; return true;
    case 'endDeductionMm': if (!bar) return false; bar.endDeductionMm = num; return true;
    case 'coverMm':
      if (num === undefined) return false;
      inputs.settings.coverMm = num;
      // a cover a PERSON gave is stated, not the project default — this is what
      // lifts the "cover assumed" block off every row that reads it
      inputs.settings.coverSource = 'stated';
      return true;
    case 'ldMultiple': inputs.settings.ldMultiple = num; return true;
    case 'anchorageMm': inputs.settings.anchorageMm = num; return true;
    case 'lapMm': inputs.settings.lapMm = num; return true;
    case 'wastagePct': if (num === undefined) return false; inputs.settings.wastagePct = num; return true;
    case 'concreteGrade': if (value === undefined) return false; inputs.settings.concreteGrade = String(value); return true;
    case 'steelGrade': if (value === undefined) return false; inputs.settings.steelGrade = String(value); return true;
    case 'enteredCuttingLengthMm':
      if (num === undefined) delete inputs.enteredCuttingLengthMm![edit.barMark];
      else inputs.enteredCuttingLengthMm![edit.barMark] = num;
      return true;
    default:
      return false;
  }
}

/**
 * Rebuild the schedule from its inputs — through `scheduleRow`, the one
 * builder. `previous` supplies each row's printed description so a rebuilt
 * row is the same document; everything numeric is computed afresh.
 */
export function recalculate(
  inputs: EngineInputs,
  previous: readonly BbsRow[] = [],
): { rows: BbsRow[]; summary: SummaryLine[]; reconciliation: Reconciliation } {
  const descriptions = new Map(previous.map((r) => [r.barMark, r.description]));
  const rows: BbsRow[] = [];
  for (const [barMark, bar] of Object.entries(inputs.bars)) {
    const member = inputs.members[bar.memberMark];
    if (!member) continue;
    const built = scheduleRow({
      bar,
      member,
      settings: inputs.settings,
      runMm: inputs.runMm,
      ...(inputs.enteredCuttingLengthMm?.[barMark] !== undefined
        ? { enteredCuttingLengthMm: inputs.enteredCuttingLengthMm[barMark] }
        : {}),
      declaredInput: inputs.declaredInputs?.[barMark] ?? null,
      takeoffCount: inputs.takeoffCounts[bar.memberMark] ?? null,
      coverTable: inputs.coverTable,
      barMark,
      description: descriptions.get(barMark) ?? describeBar(bar, member),
    });
    rows.push(built.row);
  }
  const order = new Map(previous.map((r, i) => [r.barMark, i]));
  rows.sort((a, b) => (order.get(a.barMark) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.barMark) ?? Number.MAX_SAFE_INTEGER));
  const summary = buildSteelSummary(rows, inputs.settings.wastagePct);
  return { rows, summary, reconciliation: reconcileSchedule(rows, summary) };
}

/**
 * The whole of stage 4, in order: validate → USER_INPUT DataFact (keeping the
 * drawing's own value) → record the override → invalidate the rows that read
 * the fact → recalculate through the canonical pipeline → reconcile →
 * validate. An edit that does not pass validation changes nothing.
 */
export function applyEdits(
  rows: readonly BbsRow[],
  inputs: EngineInputs,
  edits: readonly CellEdit[],
  opts: {
    drawingHashMatches?: boolean;
    requireConfirmation?: boolean;
    /** disputes still standing after this save — they block FINAL */
    disputes?: readonly string[];
    verificationOk?: boolean;
  } = {},
): AppliedEdits {
  const grid = buildEditGrid(rows, inputs);
  const next = clone(inputs);
  const facts: EditedFact[] = [];
  const rejected: EditRejection[] = [];
  const touchedRows = new Set<string>();
  const touchedFacts = new Set<string>();

  for (const edit of edits) {
    const field = FIELD_BY_ID.get(edit.field);
    if (!field) {
      rejected.push({ ...edit, reason: `"${edit.field}" is not an editable input — outputs are computed, not entered` });
      continue;
    }
    const gridRow = grid.rows.find((r) => r.barMark === edit.barMark);
    if (!gridRow) {
      rejected.push({ ...edit, reason: `no row "${edit.barMark}" in this schedule` });
      continue;
    }
    const check = validateEdit(field, edit.value);
    if (!check.ok) {
      rejected.push({ ...edit, reason: check.reason ?? 'not a valid value' });
      continue;
    }
    // A figure that must be READ is only accepted against an explicit
    // confirmation. Without it the row stays blocked — which is the point:
    // some inputs cannot safely be invented at a keyboard.
    if (field.requiresEvidence && opts.requireConfirmation !== false && !edit.confirmed && check.value !== undefined) {
      rejected.push({
        ...edit,
        reason: `${field.label} must come from the drawing or the design — confirm the source and it will be recorded with that confirmation`,
      });
      continue;
    }
    const cell = gridRow.cells.find((c) => c.field === field.id);
    if (!writeValue(next, edit, field, check.value)) {
      rejected.push({ ...edit, reason: `${field.label} could not be applied to ${edit.barMark}` });
      continue;
    }

    const factId = cell?.factId ?? factIdForField(field, gridRow.memberMark);
    const wasDrawing = cell?.source === 'DRAWING_READ';
    const changed = cell?.value !== check.value;
    facts.push({
      factId,
      value: check.value === undefined ? null : (check.value as number | string),
      ...(field.unit === 'mm' ? { unit: 'mm' } : {}),
      saidAs: check.saidAs ?? edit.value,
      ...(cell && cell.value !== undefined ? { previous: { value: cell.value as number | string, source: cell.source } } : {}),
      override: wasDrawing && changed,
      ...(edit.confirmed ? { confirmed: true } : {}),
      affects: [],
    });
    touchedFacts.add(factId);
    touchedRows.add(edit.barMark);
  }

  // DEPENDENCY INVALIDATION — a fact belongs to every row that read it. A
  // cover answered once recomputes every row cut to it; a member length
  // recomputes that member's bars and nothing else.
  const invalidated = new Set(touchedRows);
  for (const row of grid.rows) {
    if (row.factIds.some((id) => touchedFacts.has(id))) invalidated.add(row.barMark);
  }
  for (const fact of facts) {
    fact.affects = grid.rows
      .filter((r) => r.factIds.includes(fact.factId) || (touchedRows.has(r.barMark) && r.cells.some((c) => c.factId === fact.factId)))
      .map((r) => r.barMark);
  }

  const rebuilt = recalculate(next, rows);
  const validation = validateSchedule(rebuilt.rows, {
    reconciliationOk: rebuilt.reconciliation.ok,
    drawingHashMatches: opts.drawingHashMatches,
    ...(opts.disputes ? { disputes: opts.disputes } : {}),
    ...(opts.verificationOk !== undefined ? { verificationOk: opts.verificationOk } : {}),
  });

  return {
    rows: rebuilt.rows,
    summary: rebuilt.summary,
    reconciliation: rebuilt.reconciliation,
    validation,
    inputs: next,
    facts,
    rejected,
    invalidated: [...invalidated],
    status: validation.final ? 'FINAL' : 'INCOMPLETE',
  };
}
