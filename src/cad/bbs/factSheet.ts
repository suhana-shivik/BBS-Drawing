// ============================================================
// THE FACTS THIS SCHEDULE IS ABOUT TO BE BUILT FROM.
//
// Every number a BBS rests on, listed before the schedule is read, each one
// saying where it came from. Not a summary of the result — the INPUTS, which
// is a different document and the only one that can be checked before the
// arithmetic runs.
//
// WHY IT HAS TO EXIST SEPARATELY
//
// A finished schedule is very good at hiding its own inputs. Every row of it
// is arithmetically consistent with whatever went in, so a wrong cover, a
// count carried over from an old answer and a diameter the grammar dropped all
// produce a table that looks exactly like a right one. The only place those
// are visible is before they are spent: 20 verticals of Ø16 read off a
// callout, a height supplied by a person, a cover nobody stated.
//
// THE ONE RULE
//
// Every line says its ORIGIN, and MISSING is an origin like any other. A line
// with no value is not omitted and never shows a zero — a fact this schedule
// does not have is exactly the thing a reader is looking for.
// ============================================================
import type { BbsBar, BbsInterpretation, BbsMember, BbsSettings } from './types';
import { cuttingLengthInputFor, type DesignInputDeclaration } from './designInputs';

/**
 * Where a value came from. Deliberately the four words a person would use
 * about a drawing, not the engine's internal states.
 */
export type FactOrigin =
  /** read off the sheet — a callout, a dimension, a schedule cell */
  | 'DRAWING'
  /** a person typed it */
  | 'USER INPUT'
  /** computed from other facts, and the basis says which */
  | 'DERIVED'
  /** nobody stated it and the engine fell back to a project convention */
  | 'PROJECT DEFAULT'
  /** not established — the schedule cannot proceed on this line */
  | 'MISSING';

export interface FactLine {
  /** what it is about — a member mark, a bar mark, or the schedule itself */
  subject: string;
  /** the value's name, stable for keying — 'height', 'cover', 'count' */
  field: string;
  /** how it reads to a person — "P1 height" */
  label: string;
  /** the value as it will be used; null when there is none */
  value: string | null;
  unit?: string;
  origin: FactOrigin;
  /** the evidence — a callout verbatim, the words a person used, a basis */
  saidAs?: string;
  /** true when a schedule must not be produced until this is settled */
  blocking: boolean;
}

export interface FactSheet {
  lines: FactLine[];
  /** the lines a person has to settle before the schedule means anything */
  open: FactLine[];
  /** may a schedule be produced from these facts? */
  ok: boolean;
}

export interface FactSheetInput {
  interpretation: BbsInterpretation;
  settings: BbsSettings;
  /** engine keys a person has answered, e.g. { p1_height: { mm, saidAs } } */
  userFacts?: Readonly<Record<string, { mm: number; saidAs?: string }>>;
  /** what the drawing declares a design input rather than stating */
  designInputs?: readonly DesignInputDeclaration[];
  /** cutting lengths a person typed, by bar mark */
  typedLengths?: Readonly<Record<string, number>>;
}

const line = (l: FactLine): FactLine => l;

/** The engine key a member axis is answered under — bbsFacts.ts's convention. */
const axisKey = (mark: string, name: string): string =>
  `${mark}.${name}`.toLowerCase().replace(/\./g, '_');

/**
 * One member axis, with its origin.
 *
 * A dimension a PERSON supplied and one the sheet dimensions are both numbers
 * on the same member and must never read alike: the second is checkable
 * against the drawing and the first is only as good as the person's memory of
 * it. `userFacts` is what tells them apart, which is why it is consulted
 * before the value rather than after.
 */
function axisLine(
  member: BbsMember,
  field: 'length' | 'width' | 'height',
  mm: number | undefined,
  userFacts: FactSheetInput['userFacts'],
): FactLine {
  const said = userFacts?.[axisKey(member.mark, field)];
  if (said) {
    return line({
      subject: member.mark,
      field,
      label: `${member.mark} ${field}`,
      value: String(said.mm),
      unit: 'mm',
      origin: 'USER INPUT',
      ...(said.saidAs ? { saidAs: said.saidAs } : {}),
      blocking: false,
    });
  }
  return line({
    subject: member.mark,
    field,
    label: `${member.mark} ${field}`,
    value: mm !== undefined && mm > 0 ? String(mm) : null,
    unit: 'mm',
    origin: mm !== undefined && mm > 0 ? 'DRAWING' : 'MISSING',
    blocking: !(mm !== undefined && mm > 0),
  });
}

/** How many of this member the job holds, and on whose authority. */
function countLine(member: BbsMember, userFacts: FactSheetInput['userFacts']): FactLine {
  const said = userFacts?.[axisKey(member.mark, 'count')];
  const base = { subject: member.mark, field: 'count', label: `${member.mark} quantity` };
  if (said) {
    return line({
      ...base,
      value: String(said.mm),
      origin: 'USER INPUT',
      ...(said.saidAs ? { saidAs: said.saidAs } : {}),
      blocking: false,
    });
  }
  // A count the drawing establishes comes with a rule that says HOW — a pitch
  // to divide the run by. Without one, a count of 1 is not a reading of the
  // sheet, it is what an unplaced member falls to, and a schedule multiplied
  // by it is a schedule for one of something the job may hold fifty of.
  if (member.countRule) {
    return line({
      ...base,
      value: String(member.count),
      origin: 'DERIVED',
      saidAs: `at ${member.countRule.pitchMm} mm pitch along the run${member.countRule.endsInclusive ? ', ends included' : ''}`,
      blocking: false,
    });
  }
  if (typeof member.count === 'number' && member.count > 1) {
    return line({ ...base, value: String(member.count), origin: 'DRAWING', blocking: false });
  }
  return line({
    ...base,
    value: null,
    origin: 'MISSING',
    saidAs: 'the sheet does not establish how many of these the job holds',
    blocking: true,
  });
}

function barLines(
  bar: BbsBar,
  mark: string,
  input: FactSheetInput,
): FactLine[] {
  const out: FactLine[] = [];
  const kind = bar.barType.toLowerCase();
  out.push(
    line({
      subject: mark,
      field: 'diameter',
      label: `${mark} (${kind}) diameter`,
      value: bar.diaMm > 0 ? String(bar.diaMm) : null,
      unit: 'mm',
      origin: bar.diaMm > 0 ? 'DRAWING' : 'MISSING',
      saidAs: bar.fromCallout,
      blocking: !(bar.diaMm > 0),
    }),
  );

  // How many, per member — a stated count or a spacing, never both invented.
  if (typeof bar.manualCount === 'number' && bar.manualCount > 0) {
    out.push(
      line({
        subject: mark,
        field: 'bars_per_member',
        label: `${mark} bars per member`,
        value: String(bar.manualCount),
        origin: 'DRAWING',
        saidAs: bar.fromCallout,
        blocking: false,
      }),
    );
  } else if (typeof bar.spacingMm === 'number' && bar.spacingMm > 0) {
    out.push(
      line({
        subject: mark,
        field: 'spacing',
        label: `${mark} spacing`,
        value: String(bar.spacingMm),
        unit: 'mm c/c',
        origin: 'DRAWING',
        saidAs: `${bar.fromCallout}${bar.zone ? ` (${bar.zone})` : ''}`,
        blocking: false,
      }),
    );
  } else {
    out.push(
      line({
        subject: mark,
        field: 'bars_per_member',
        label: `${mark} bars per member`,
        value: null,
        origin: 'MISSING',
        saidAs: `${bar.fromCallout} states neither a count nor a spacing`,
        blocking: true,
      }),
    );
  }

  out.push(
    line({
      subject: mark,
      field: 'shape',
      label: `${mark} shape code`,
      value: bar.shapeCode,
      origin: 'DRAWING',
      saidAs: bar.fromCallout,
      blocking: false,
    }),
  );

  // WHERE THE CUTTING LENGTH IS GOING TO COME FROM.
  //
  // The line a reader checks first and the one the engine is least entitled to
  // be casual about. Four possibilities and they are not interchangeable: a
  // person typed it, the drawing says it is a design input, the shape formula
  // will produce it, or nothing will.
  const typed = input.typedLengths?.[mark];
  const declared = cuttingLengthInputFor(input.designInputs ?? [], {
    mark,
    memberMark: bar.memberMark,
    diaMm: bar.diaMm,
  });
  if (typeof typed === 'number' && typed > 0) {
    out.push(
      line({
        subject: mark,
        field: 'cutting_length',
        label: `${mark} cutting length`,
        value: String(typed),
        unit: 'mm',
        origin: 'USER INPUT',
        blocking: false,
      }),
    );
  } else if (declared) {
    out.push(
      line({
        subject: mark,
        field: 'cutting_length',
        label: `${mark} cutting length`,
        value: null,
        unit: 'mm',
        origin: 'MISSING',
        saidAs: `the drawing declares this a design input — ${declared.where} reads "${declared.saidAs}"`,
        blocking: true,
      }),
    );
  } else {
    out.push(
      line({
        subject: mark,
        field: 'cutting_length',
        label: `${mark} cutting length`,
        value: null,
        unit: 'mm',
        origin: 'DERIVED',
        saidAs: `shape ${bar.shapeCode} over the member's dimensions, less bend deductions`,
        blocking: false,
      }),
    );
  }
  return out;
}

/** The settings every length and lap on the sheet is computed against. */
function settingLines(settings: BbsSettings): FactLine[] {
  const coverOrigin: FactOrigin =
    settings.coverSource === 'stated'
      ? 'USER INPUT'
      : settings.coverSource === 'sheet'
        ? 'DRAWING'
        : settings.coverSource === 'default'
          ? 'PROJECT DEFAULT'
          : 'DERIVED';
  return [
    line({
      subject: 'schedule',
      field: 'cover',
      label: 'Clear cover',
      value: String(settings.coverMm),
      unit: 'mm',
      origin: coverOrigin,
      // Cover is in every arm of every link. A default here is not a detail.
      blocking: coverOrigin === 'PROJECT DEFAULT',
    }),
    line({
      subject: 'schedule',
      field: 'concrete_grade',
      label: 'Concrete grade',
      value: settings.concreteGrade,
      origin: 'DRAWING',
      saidAs: 'sets the bond stress the development length comes out of (IS 456 Table 21)',
      blocking: false,
    }),
    line({
      subject: 'schedule',
      field: 'steel_grade',
      label: 'Steel grade',
      value: settings.steelGrade,
      origin: 'DRAWING',
      blocking: false,
    }),
    line({
      subject: 'schedule',
      field: 'ld',
      label: 'Development length / lap',
      value: settings.ldMultiple ? `${settings.ldMultiple}φ` : 'IS 456 derivation',
      origin: settings.ldMultiple ? 'DRAWING' : 'DERIVED',
      saidAs: settings.ldMultiple
        ? 'a lap rule stated in the sheet notes'
        : 'derived per bar from the concrete and steel grades',
      blocking: false,
    }),
  ];
}

/**
 * Everything this schedule is about to be built from, with its provenance.
 *
 * Pure: it reads the inputs and reports them. It computes no quantity and
 * decides nothing — a fact sheet that could change an answer would be part of
 * the arithmetic it exists to let somebody check.
 */
export function factSheet(input: FactSheetInput): FactSheet {
  const lines: FactLine[] = [...settingLines(input.settings)];

  const used = new Set<string>();
  const markOf = (bar: BbsBar): string => {
    if (bar.barMark && !used.has(bar.barMark)) {
      used.add(bar.barMark);
      return bar.barMark;
    }
    const prefix = ['STIRRUP', 'TIE', 'RING'].includes(bar.barType) ? 'T' : 'M';
    let i = 1;
    let mark = `${bar.memberMark}-${prefix}${i}`;
    while (used.has(mark)) mark = `${bar.memberMark}-${prefix}${++i}`;
    used.add(mark);
    return mark;
  };

  for (const member of input.interpretation.members) {
    lines.push(countLine(member, input.userFacts));
    lines.push(axisLine(member, 'length', member.lengthMm, input.userFacts));
    lines.push(axisLine(member, 'width', member.widthMm, input.userFacts));
    lines.push(axisLine(member, 'height', member.heightMm, input.userFacts));
  }
  for (const bar of input.interpretation.bars) {
    lines.push(...barLines(bar, markOf(bar), input));
  }

  const open = lines.filter((l) => l.blocking);
  return { lines, open, ok: open.length === 0 };
}

/** The fact sheet as a person reads it — one line each, origin on every one. */
export function factSheetLines(sheet: FactSheet): string[] {
  return sheet.lines.map((l) => {
    const value = l.value === null ? '—' : `${l.value}${l.unit ? ` ${l.unit}` : ''}`;
    const said = l.saidAs ? `  · ${l.saidAs}` : '';
    return `${l.label}: ${value}  [${l.origin}]${said}`;
  });
}
