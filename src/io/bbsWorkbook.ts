// ============================================================
// A bar bending schedule as a workbook.
//
// EXPORT MIRRORS THE SCREEN (STUDIO_DESIGN §6.2).
//
// "CSV and XLSX carry exactly the visible columns in the visible order. A
// schedule that exports differently from how it was checked is a different
// document." So this module does not choose the columns — the caller hands it
// the visible column set, in the visible order, exactly as the table derived
// it (`deriveColumns` in src/studio/schedule.ts returns that shape directly).
// `defaultColumns` exists only for a caller that has no table on screen.
//
// THE HONESTY RULE (HOW_TO_BUILD_IT §6.4) IS THE IMPORTANT ONE.
//
// A row the engine could not compute exports with its quantity cells EMPTY and
// its hole named in a text cell — never as `0`. A zero sums. A zero in a
// weight column that means "not computed" is indistinguishable, in a
// spreadsheet a fabricator orders steel from, from a zero that means "none
// required", and the schedule looks finished when it is not. The same rule
// governs subtotals and the schedule total: a total over nothing but blocked
// rows prints no figure at all.
//
// Note the one deliberate exception. A blocked row keeps its Ø, its spacing
// and its unit weight, because those are facts READ from the drawing, not
// quantities derived from them. Blanking them would hide evidence to make a
// rule look tidy.
//
// Nothing here recomputes a number. Every figure comes from the engine result;
// the only arithmetic is addition of figures the engine already produced, and
// where that addition disagrees with the engine's own summary the workbook
// says so rather than picking a side.
// ============================================================
import type { BbsChatResult, BbsChatRow } from '../cad/bbs/chatResult';
import type { XlsxCell, XlsxRow, XlsxSheet, XlsxValue, XlsxWorkbook } from './xlsx';
import { writeXlsx, XLSX_MIME } from './xlsx';

export { XLSX_MIME };

// ------------------------------------------------------------
// what a caller supplies
// ------------------------------------------------------------

/**
 * A visible column. Structurally identical to `ScheduleColumn` in
 * src/studio/schedule.ts, so the on-screen set can be passed straight through
 * without an adapter — the point being that there is no opportunity for the
 * export's columns to drift from the table's.
 */
export interface BbsExportColumn {
  id: string;
  label: string;
  numeric: boolean;
}

/** The settings the numbers were computed under — a subset of `BbsSettings`. */
export interface BbsExportSettings {
  concreteGrade?: string;
  steelGrade?: string;
  coverMm?: number;
  bendMode?: string;
  wastagePct?: number;
  ldMultiple?: number;
}

/**
 * Where the schedule came from and what it was computed under.
 *
 * An exported schedule that cannot say which revision of which drawing it was
 * read from, and under which cover and wastage, is not checkable — it is a
 * list of numbers. Every field is optional and an absent one prints as "not
 * stated" rather than being silently omitted.
 */
export interface BbsProvenance {
  drawingName?: string;
  drawingNumber?: string;
  /**
   * The source drawing's own file name ("Foundations drawings.dxf"). It names
   * the export — see `bbsFileName` — and never appears in the header, which
   * states the title and the number instead.
   */
  drawingFile?: string;
  revision?: string;
  issueDate?: string;
  /** ISO text, or ms since epoch. Supplied — never read from a clock here. */
  exportedAt?: string | number;
  preparedBy?: string;
  projectName?: string;
  settings?: BbsExportSettings;
  /** the practice that produced the figures, one line each */
  conventions?: readonly string[];
}

export interface BbsWorkbookInput {
  result: BbsChatResult;
  /** The visible columns in the visible order. Omit only when there is no table. */
  columns?: readonly BbsExportColumn[];
  provenance?: BbsProvenance;
  /** Grouping, as on screen. Default: by member, as §6.2 specifies. */
  groupBy?: 'member' | 'dia';
}

// ------------------------------------------------------------
// formats
// ------------------------------------------------------------

const FMT = {
  mm: '#,##0',
  metres: '#,##0.00',
  kg: '#,##0.00',
  kgPerM: '0.000',
  tonnes: '0.000',
  count: '0',
} as const;

const HEADER_FILL = 'E7ECF2'; // panel-raised, from the product's own tokens
const TOTAL_FILL = 'F1F4F8';

const text = (v: string, over: Partial<XlsxCell> = {}): XlsxCell => ({ v, ...over });
const number = (v: number | null | undefined, numFmt: string, over: Partial<XlsxCell> = {}): XlsxCell => ({
  v: typeof v === 'number' && Number.isFinite(v) ? v : null,
  align: 'right',
  numFmt,
  ...over,
});
const empty = (over: Partial<XlsxCell> = {}): XlsxCell => ({ v: null, ...over });

/** pad a row out to `width` so a fill or a grey reads across the whole band */
function pad(cells: XlsxCell[], width: number, style: Partial<XlsxCell> = {}): XlsxRow {
  const out = [...cells];
  while (out.length < width) out.push(empty(style));
  return out;
}

function stamp(when: string | number | undefined): string {
  if (when === undefined || when === null || when === '') return 'not stated';
  if (typeof when === 'string') return when;
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? 'not stated' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const stated = (v: string | undefined): string => (v && v.trim() ? v.trim() : 'not stated');

/**
 * How much of the structure these figures are for.
 *
 * `extentClaims` means the counts came from reading a drawn band as the whole
 * job with no run fact to check it against — which makes the largest number in
 * the schedule an unverified reading. A spreadsheet gets forwarded, printed
 * and ordered from without the conversation that produced it, so the scope
 * travels in the header rather than in a warning at the bottom.
 */
function scopeText(result: BbsChatResult): string {
  const claims = result.extentClaims ?? [];
  if (!claims.length && !result.coversDrawnExtentMm) return 'the whole of the structure scheduled below';
  const mm =
    result.coversDrawnExtentMm ?? Math.max(...claims.map((c) => c.drawnExtentMm));
  const marks = claims.map((c) => c.memberMark).join(', ');
  return (
    `COVERS ONLY WHAT IS DRAWN — ${mm.toLocaleString('en-IN')} mm of structure. ` +
    (marks ? `${marks} counted by taking the drawn layout to BE the whole job; ` : '') +
    'no total run was supplied, so every figure below is scoped to the drawing.'
  );
}

// ------------------------------------------------------------
// columns
// ------------------------------------------------------------

/**
 * Quantity columns — the ones a blocked row must leave empty.
 *
 * Ø, spacing and unit weight are NOT here: a diameter read off a callout is
 * still true when the length that would consume it is missing.
 */
const QUANTITY_COLUMNS = new Set([
  'cuttingLength',
  'barsPerMember',
  'memberCount',
  'totalBars',
  'totalLength',
  'weight',
  'weightWithWastage',
]);

const isQuantityColumn = (id: string): boolean => QUANTITY_COLUMNS.has(id) || id.startsWith('leg:');

function columnFormat(id: string): string | undefined {
  if (id.startsWith('leg:')) return FMT.mm;
  switch (id) {
    case 'dia':
    case 'barsPerMember':
    case 'memberCount':
    case 'totalBars':
      return FMT.count;
    case 'cuttingLength':
    case 'cover':
    case 'spacing':
      return FMT.mm;
    case 'wastage':
      return FMT.kg;
    case 'confidence':
      return '0.00';
    case 'sno':
      return FMT.count;
    case 'totalLength':
      return FMT.metres;
    case 'unitWeight':
      return FMT.kgPerM;
    case 'weight':
    case 'weightWithWastage':
      return FMT.kg;
    default:
      return undefined;
  }
}

function columnWidth(id: string): number {
  switch (id) {
    case 'description':
      return 34;
    case 'mark':
    case 'member':
      return 14;
    case 'dia':
      return 8;
    case 'status':
      return 52;
    case 'coverSource':
    case 'engineering':
    case 'sourceCallout':
      return 28;
    case 'factIds':
    case 'sourceHandle':
      return 36;
    case 'sno':
      return 6;
    default:
      return 14;
  }
}

/**
 * The value a column takes from a row.
 *
 * A column this result cannot fill (a leg table, a shape code — neither is
 * carried on the chat artifact) returns null and prints blank, rather than
 * being dropped: the caller said it was visible, and the export mirrors the
 * screen.
 */
export interface ColumnContext {
  index: number;
  drawing?: string;
  revision?: string;
  sectionOf?: (row: BbsChatRow) => string | undefined;
}

function valueOf(row: BbsChatRow, id: string, ctx: ColumnContext = { index: 0 }): XlsxValue {
  if (id.startsWith('leg:')) {
    const leg = id.slice(4);
    const seg = row.segments?.find((sg) => sg.label === leg);
    return seg ? seg.mm : null;
  }
  switch (id) {
    case 'sno':
      return ctx.index + 1;
    case 'drawing':
      return ctx.drawing ?? '';
    case 'revision':
      return ctx.revision ?? '';
    case 'memberType':
      return row.memberType ?? '';
    case 'location':
      return row.location ?? '';
    case 'shape':
      return row.shapeCode ?? '';
    case 'lengthSource':
      return row.lengthSource ?? '';
    case 'wastage':
      return typeof row.weightWithWastageKg === 'number' && typeof row.totalWeightKg === 'number'
        ? row.weightWithWastageKg - row.totalWeightKg
        : null;
    case 'weightWithWastage':
      return row.weightWithWastageKg ?? null;
    case 'sourceSection':
      return ctx.sectionOf?.(row) ?? '';
    case 'sourceCallout':
      return row.description ?? '';
    case 'sourceHandle':
      return (row.sourceHandles ?? []).join(' ');
    case 'factIds':
      return (row.factIds ?? []).join(', ');
    case 'confidence':
      return typeof row.confidence === 'number' ? row.confidence : null;
    case 'engineering':
      return row.engineering ?? '';
    case 'mark':
      return row.barMark;
    case 'member':
      return row.memberMark;
    case 'description':
    case 'barType':
      return row.description;
    case 'dia':
      return row.diameterMm;
    case 'cuttingLength':
      return row.cuttingLengthMm ?? null;
    case 'barsPerMember':
      return row.barsPerMember ?? null;
    case 'memberCount':
      return row.memberCount ?? null;
    case 'totalBars':
      return row.totalBars ?? null;
    case 'spacing':
      return row.spacingMm ?? null;
    case 'totalLength':
      return row.totalLengthM ?? null;
    case 'unitWeight':
      return row.unitWeightKgPerM ?? null;
    case 'weight':
      return row.totalWeightKg ?? null;
    case 'cover':
      return row.coverMm ?? row.trace?.coverMm ?? null;
    case 'coverSource':
      return coverSourceText(row);
    case 'stage':
      return row.trace ? (row.trace.failedStage ? `FAILED at ${row.trace.failedStage}` : 'VALIDATED') : '';
    case 'status':
      return statusText(row);
    default:
      return null;
  }
}

/** "ASSUMED 50 (project default)" / "USER_INPUT 40" / "DRAWING_READ 40 (cover table: COLUMN)" */
export function coverSourceText(row: BbsChatRow): string {
  const status = row.coverStatus ?? row.trace?.coverStatus;
  const source = row.coverSource ?? row.trace?.coverSource ?? '';
  if (!status && !source) return '';
  // The settings carry the cover whoever stated it; the STATUS says who.
  // "USER_INPUT (project default)" is a contradiction, so the source is
  // worded by the status when the settings were the carrier.
  const where =
    source === 'settings-default'
      ? status === 'USER_INPUT'
        ? 'your answer'
        : status === 'DRAWING_READ'
          ? "the drawing's general note"
          : 'project default'
      : source === 'user-override'
        ? 'your answer'
        : source === 'member-cover-table'
          ? 'cover table'
          : source;
  return `${status ?? ''}${where ? ` (${where})` : ''}`.trim();
}

/** The column set when there is no table on screen to mirror. §6.2 rule 6 order. */
export function defaultColumns(result: BbsChatResult): BbsExportColumn[] {
  // §31 — the columns a final BBS carries. Every one reads from the row the
  // pipeline produced; nothing here is computed a second time.
  const cols: BbsExportColumn[] = [
    { id: 'sno', label: 'S.No', numeric: true },
    { id: 'drawing', label: 'Drawing', numeric: false },
    { id: 'revision', label: 'Revision', numeric: false },
    { id: 'member', label: 'Member Mark', numeric: false },
    { id: 'memberType', label: 'Member Type', numeric: false },
    { id: 'mark', label: 'Bar Mark', numeric: false },
    { id: 'location', label: 'Location', numeric: false },
    { id: 'shape', label: 'Shape', numeric: false },
    { id: 'dia', label: 'Dia (mm)', numeric: true },
  ];
  // §6.2 rule 1: a column appears only where a row can fill it.
  if (result.rows.some((r) => typeof r.spacingMm === 'number')) {
    cols.push({ id: 'spacing', label: 'Spacing c/c (mm)', numeric: true });
  }
  for (const leg of ['A', 'B', 'C', 'D'] as const) {
    if (result.rows.some((r) => r.segments?.some((sg) => sg.label === leg))) {
      cols.push({ id: `leg:${leg}`, label: `${leg} (mm)`, numeric: true });
    }
  }
  cols.push(
    // Every cutting length shows the cover it was cut to and where that
    // figure came from — an ASSUMED cover beside a length that was read
    // must never look like a reading.
    { id: 'cover', label: 'Cover (mm)', numeric: true },
    { id: 'coverSource', label: 'Cover source', numeric: false },
    { id: 'cuttingLength', label: 'Cutting Length (mm)', numeric: true },
    { id: 'lengthSource', label: 'Length by', numeric: false },
    { id: 'barsPerMember', label: 'Bars/Member', numeric: true },
    { id: 'memberCount', label: 'Member Count', numeric: true },
    { id: 'totalBars', label: 'Total Bars', numeric: true },
    { id: 'totalLength', label: 'Total Length (m)', numeric: true },
    { id: 'unitWeight', label: 'Unit Weight (kg/m)', numeric: true },
    { id: 'weight', label: 'Net Weight (kg)', numeric: true },
    { id: 'wastage', label: 'Wastage (kg)', numeric: true },
    { id: 'weightWithWastage', label: 'Gross Weight (kg)', numeric: true },
    { id: 'sourceSection', label: 'Source Section', numeric: false },
    { id: 'sourceCallout', label: 'Source Callout', numeric: false },
    { id: 'sourceHandle', label: 'Source Entity/Handle', numeric: false },
    { id: 'factIds', label: 'Fact IDs', numeric: false },
    { id: 'confidence', label: 'Confidence', numeric: true },
    { id: 'engineering', label: 'Validation', numeric: false },
  );
  return cols;
}

// ------------------------------------------------------------
// blocked rows
// ------------------------------------------------------------

export const isBlocked = (row: BbsChatRow): boolean => row.status === 'unavailable';

/**
 * The named hole, in the shape §6.4 prints it: `BLOCKED — <what is missing>`.
 * It goes in a visible text cell, never a cell comment — a reason a reader has
 * to hover to discover is a reason nobody reads.
 */
export function statusText(row: BbsChatRow): string {
  if (isBlocked(row)) {
    const why = (row.note ?? 'a required dimension is not resolved').trim();
    return /^blocked\b/i.test(why) ? why : `BLOCKED — ${why}`;
  }
  if (row.status === 'inferred') {
    const why = (row.note ?? 'derived from a project convention').trim();
    return `INFERRED — ${why}`;
  }
  return '';
}

// ------------------------------------------------------------
// steel summary
// ------------------------------------------------------------

export interface SteelLine {
  diaMm: number;
  /**
   * `null`, never `0`, where every row at this diameter is blocked. A
   * diameter is listed even when nothing at it could be computed — that a
   * 12 mm bar exists is a fact the drawing states — but the quantity beside
   * it stays empty, because a zero here is an order for no steel.
   */
  barCount: number | null;
  totalLengthM: number | null;
  /**
   * Null only when NO row at this diameter carries one — a blocked row has no
   * unit weight, and printing 0.000 for it put the one figure this column can
   * never legitimately hold into the sheet as though it were a reading.
   */
  unitWeightKgPerM: number | null;
  totalWeightKg: number | null;
  totalWeightWithWastageKg: number | null;
  /** rows at this diameter that could not be computed — in no figure above */
  openRows: number;
}

/**
 * The summary a fabricator orders from, reconciled against the schedule.
 *
 * The engine's own `diameterSummary` is the authority — it is what the rows
 * were footed into, and re-deriving it here would be a second opinion nobody
 * asked for. But the two are ADDED UP INDEPENDENTLY and compared: if the
 * summary does not equal the sum of the rows the reader is about to check it
 * against, the sheet says so instead of quietly printing one of them.
 */
export function steelLines(result: BbsChatResult): { lines: SteelLine[]; mismatchKg: number } {
  const fromRows = new Map<
    number,
    { kg: number; m: number; bars: number; open: number; done: number; unit: number | null }
  >();
  for (const row of result.rows) {
    const at =
      fromRows.get(row.diameterMm) ?? { kg: 0, m: 0, bars: 0, open: 0, done: 0, unit: null };
    // A blocked row carries no unit weight, but the diameter's unit weight is
    // a property of the diameter — so the first row that HAS one speaks for
    // the group rather than whichever row happened to be read first.
    if (at.unit === null && typeof row.unitWeightKgPerM === 'number') at.unit = row.unitWeightKgPerM;
    if (isBlocked(row)) at.open += 1;
    else {
      at.done += 1;
      at.kg += row.totalWeightKg ?? 0;
      at.m += row.totalLengthM ?? 0;
      at.bars += row.totalBars ?? 0;
    }
    fromRows.set(row.diameterMm, at);
  }
  const fromRowsLine = (diaMm: number, at: { kg: number; m: number; bars: number; open: number; done: number; unit: number | null }): SteelLine => ({
    diaMm,
    barCount: at.done ? at.bars : null,
    totalLengthM: at.done ? at.m : null,
    unitWeightKgPerM: at.unit,
    totalWeightKg: at.done ? at.kg : null,
    totalWeightWithWastageKg: at.done ? at.kg : null,
    openRows: at.open,
  });

  const summary = result.diameterSummary ?? [];
  const lines: SteelLine[] = summary.length
    ? summary.map((s) => ({
        diaMm: s.diaMm,
        barCount: s.barCount,
        totalLengthM: s.totalLengthM,
        unitWeightKgPerM: s.unitWeightKgPerM,
        totalWeightKg: s.totalWeightKg,
        totalWeightWithWastageKg: s.totalWeightWithWastageKg,
        openRows: fromRows.get(s.diaMm)?.open ?? 0,
      }))
    : // No engine summary (a wholly blocked result has none): the rows are all
      // there is, and they are added up as they stand.
      [...fromRows].map(([diaMm, at]) => fromRowsLine(diaMm, at));

  // A diameter the engine could not summarise — because every row at it is
  // blocked — is still listed, with empty quantities.
  for (const [dia, at] of fromRows) {
    if (!lines.some((l) => l.diaMm === dia)) lines.push(fromRowsLine(dia, at));
  }
  lines.sort((a, b) => a.diaMm - b.diaMm);

  const rowsKg = [...fromRows.values()].reduce((n, at) => n + at.kg, 0);
  const linesKg = lines.reduce((n, l) => n + (l.totalWeightKg ?? 0), 0);
  return { lines, mismatchKg: Math.abs(linesKg - rowsKg) < 0.005 ? 0 : linesKg - rowsKg };
}

// ------------------------------------------------------------
// grouping
// ------------------------------------------------------------

interface Group {
  label: string;
  rows: BbsChatRow[];
}

function groupsOf(result: BbsChatResult, by: 'member' | 'dia'): Group[] {
  const out: Group[] = [];
  const index = new Map<string, Group>();
  for (const row of result.rows) {
    const key = by === 'dia' ? `${row.diameterMm} mm` : row.memberMark || '—';
    let group = index.get(key);
    if (!group) {
      group = { label: key, rows: [] };
      index.set(key, group);
      out.push(group); // the schedule's own row order, preserved
    }
    group.rows.push(row);
  }
  return out;
}

interface Foot {
  kg: number | null;
  note: string;
}

/**
 * Foot a set of rows.
 *
 * `kg: null` when every row in the set is blocked — the case the rule exists
 * for. `0.00` there would be a quantity; there is no quantity, there is a
 * question.
 */
function foot(rows: readonly BbsChatRow[]): Foot {
  const open = rows.filter(isBlocked).length;
  const done = rows.length - open;
  if (rows.length && open === rows.length) {
    return { kg: null, note: `BLOCKED — ${open} row${open === 1 ? '' : 's'} not computed, no total can be stated` };
  }
  const kg = rows.reduce((n, r) => (isBlocked(r) ? n : n + (r.totalWeightKg ?? 0)), 0);
  return {
    kg,
    note: open ? `PARTIAL — ${done} of ${rows.length} rows computed, ${open} open` : '',
  };
}

// ------------------------------------------------------------
// the schedule sheet
// ------------------------------------------------------------

function provenanceBlock(input: BbsWorkbookInput, width: number): XlsxRow[] {
  const p = input.provenance ?? {};
  const s = p.settings ?? {};
  const result = input.result;
  const open = result.rows.filter(isBlocked).length;
  const used: Partial<NonNullable<BbsChatResult['settings']>> = result.settings ?? {};
  const sources = result.settingSources ?? {};
  const sourceTag = (key: keyof NonNullable<BbsChatResult['settings']>): string => {
    const src = sources[key];
    if (!src) return '';
    return src === 'default' ? ' (ASSUMED — project default)' : src === 'sheet' ? ' (drawing)' : ' (stated)';
  };
  const coverStatusLabel = (): string => {
    const statuses = new Set(result.rows.map((r) => r.coverStatus).filter((x): x is NonNullable<typeof x> => !!x));
    if (statuses.size === 1) {
      const only = [...statuses][0];
      return only === 'ASSUMED'
        ? 'ASSUMED — project default, not stated on the drawing, not supplied'
        : only === 'USER_INPUT'
          ? 'USER_INPUT — supplied by you'
          : 'DRAWING_READ — stated on the drawing';
    }
    if (statuses.size > 1) return `per row — ${[...statuses].join(' / ')} (see Cover source column)`;
    const src = sources.coverMm;
    return src === 'default'
      ? 'ASSUMED — project default, not stated on the drawing, not supplied'
      : src === 'sheet'
        ? 'DRAWING_READ — stated on the drawing'
        : src === 'stated'
          ? 'USER_INPUT — supplied by you'
          : 'not stated';
  };

  const line = (...cells: XlsxCell[]): XlsxRow => pad(cells, width);
  const label = (v: string): XlsxCell => text(v, { bold: true });

  const rows: XlsxRow[] = [
    line(text('BAR BENDING SCHEDULE', { bold: true }), text(stated(p.drawingName ?? result.project?.drawingName))),
    line(
      label('Drawing no.'),
      text(stated(p.drawingNumber)),
      label('Revision'),
      text(stated(p.revision)),
      label('Issued'),
      text(stated(p.issueDate)),
    ),
    line(
      label('Exported'),
      text(stamp(p.exportedAt)),
      label('Prepared by'),
      text(stated(p.preparedBy)),
      label('Result id'),
      text(result.id),
    ),
    // THE SETTINGS THE ARITHMETIC SPENT, with where each came from. The header
    // used to print a defaults table (cover 50) whatever the run had used —
    // so a schedule cut to a user's 40 mm said "50" at the top, and a schedule
    // resting on an assumption said nothing about it. `result.settings` is
    // what the rows were computed with; `settingSources` says whether each
    // was read off the sheet, stated by a person, or ASSUMED.
    line(
      label('Concrete'),
      text(`${stated(used.concreteGrade ?? s.concreteGrade)}${sourceTag('concreteGrade')}`),
      label('Steel'),
      text(`${stated(used.steelGrade ?? s.steelGrade)}${sourceTag('steelGrade')}`),
      label('Clear cover (mm)'),
      number(used.coverMm ?? s.coverMm, FMT.mm),
      label('Cover status'),
      text(coverStatusLabel(), { bold: coverStatusLabel().startsWith('ASSUMED') }),
    ),
    line(
      label('Bend deductions'),
      text(stated(used.bendMode ?? s.bendMode)),
      label('Ld'),
      text(
        (used.ldMultiple ?? s.ldMultiple)
          ? `${used.ldMultiple ?? s.ldMultiple}Ø project convention${sourceTag('ldMultiple')}`
          : 'IS 456',
      ),
      label('Wastage %'),
      number(used.wastagePct ?? s.wastagePct, FMT.count),
      label('Status'),
      text(
        open
          ? `${result.status.toUpperCase()} — ${open} of ${result.rows.length} rows open`
          : `${result.status.toUpperCase()} — ${result.rows.length} rows, none open`,
        { bold: true },
      ),
    ),
    line(
      label('Scope'),
      text(scopeText(result), { bold: (result.extentClaims ?? []).length > 0 }),
    ),
    line(
      label('Units'),
      text('Lengths in mm and weights in kg unless a column heading says otherwise. Weights are IS 1786 nominal mass.', {
        muted: true,
      }),
    ),
  ];

  for (const note of p.conventions ?? []) {
    rows.push(line(label('Convention'), text(note, { muted: true })));
  }
  rows.push(pad([], width));
  return rows;
}

function scheduleSheet(input: BbsWorkbookInput): XlsxSheet {
  const result = input.result;
  const columns = (input.columns?.length ? input.columns : defaultColumns(result)).slice();
  const anyBlocked = result.rows.some(isBlocked);

  // The visible columns, in the visible order — and then, only when something
  // is actually blocked, one appended column for the hole. It is appended
  // rather than substituted so the mirror is exact for every column the screen
  // showed; a spreadsheet has no room for the badge and the opened derivation
  // the table uses to say the same thing.
  const hasStatus = columns.some((c) => c.id === 'status');
  if (anyBlocked && !hasStatus) {
    columns.push({ id: 'status', label: 'Status / open question', numeric: false });
  }
  const width = Math.max(columns.length, 8);
  const statusAt = columns.findIndex((c) => c.id === 'status');
  const weightAt = columns.findIndex((c) => c.id === 'weight');

  const rows: XlsxRow[] = [...provenanceBlock(input, width)];
  const headerAt = rows.length;
  rows.push(
    pad(
      columns.map((c) =>
        text(c.label, { bold: true, fill: HEADER_FILL, align: c.numeric ? 'right' : 'left' }),
      ),
      width,
      { fill: HEADER_FILL },
    ),
  );

  const columnContext = (row: BbsChatRow): ColumnContext => ({
    index: input.result.rows.indexOf(row),
    drawing: input.provenance?.drawingNumber || input.provenance?.drawingName,
    revision: input.provenance?.revision,
  });
  const bodyRow = (row: BbsChatRow): XlsxRow => {
    const blocked = isBlocked(row);
    return pad(
      columns.map((col) => {
        // THE RULE. A blocked row's quantity cells are empty, always.
        if (blocked && isQuantityColumn(col.id)) return empty({ muted: true });
        const v = valueOf(row, col.id, columnContext(row));
        if (typeof v === 'number') {
          return number(v, columnFormat(col.id) ?? FMT.count, { muted: blocked });
        }
        return text(typeof v === 'string' ? v : '', {
          muted: blocked,
          bold: blocked && col.id === 'status',
          align: col.numeric ? 'right' : undefined,
        });
      }),
      width,
    );
  };

  for (const group of groupsOf(result, input.groupBy ?? 'member')) {
    rows.push(pad([text(group.label.toUpperCase(), { bold: true, fill: TOTAL_FILL })], width, { fill: TOTAL_FILL }));
    for (const row of group.rows) rows.push(bodyRow(row));

    const sub = foot(group.rows);
    const cells: XlsxCell[] = new Array(width).fill(null).map(() => empty({ fill: TOTAL_FILL }));
    cells[0] = text(`Subtotal — ${group.label}`, { bold: true, fill: TOTAL_FILL });
    if (weightAt >= 0) cells[weightAt] = number(sub.kg, FMT.kg, { bold: true, fill: TOTAL_FILL });
    else cells[Math.min(1, width - 1)] = number(sub.kg, FMT.kg, { bold: true, fill: TOTAL_FILL });
    if (sub.note) {
      const at = statusAt >= 0 ? statusAt : width - 1;
      cells[at] = text(sub.note, { bold: true, muted: true, fill: TOTAL_FILL });
    }
    rows.push(cells);
    rows.push(pad([], width));
  }

  // ---- schedule total ----
  const total = foot(result.rows);
  const totalCells: XlsxCell[] = new Array(width).fill(null).map(() => empty({ fill: TOTAL_FILL }));
  totalCells[0] = text('SCHEDULE TOTAL (kg)', { bold: true, fill: TOTAL_FILL });
  const totalAt = weightAt >= 0 ? weightAt : Math.min(1, width - 1);
  totalCells[totalAt] = number(total.kg, FMT.kg, { bold: true, fill: TOTAL_FILL });
  if (total.note) {
    totalCells[statusAt >= 0 ? statusAt : width - 1] = text(total.note, {
      bold: true,
      muted: true,
      fill: TOTAL_FILL,
    });
  }
  rows.push(totalCells);

  // ---- procurement total, in the tonnes the CSV foots in ----
  const procurement = total.kg === null ? null : (input.result.procurementWeightKg ?? total.kg);
  const wastage = input.provenance?.settings?.wastagePct;
  rows.push(
    pad(
      [
        text('TOTAL QUANTITY', { bold: true }),
        number(procurement === null ? null : procurement / 1000, FMT.tonnes, { bold: true }),
        text('MT'),
        text(
          procurement === null
            ? 'nothing to order — every row is blocked'
            : typeof wastage === 'number'
              ? `incl ${wastage}% wastage`
              : 'procurement weight as the engine footed it',
          { muted: true },
        ),
      ],
      width,
    ),
  );

  // ---- what is still open, listed where it cannot be missed ----
  const blockedRows = result.rows.filter(isBlocked);
  if (blockedRows.length) {
    rows.push(pad([], width));
    rows.push(
      pad(
        [
          text(
            `OPEN ROWS — ${blockedRows.length} row${blockedRows.length === 1 ? '' : 's'} not scheduled. A dimension was not on this sheet and nothing was assumed.`,
            { bold: true },
          ),
        ],
        width,
      ),
    );
    for (const row of blockedRows) {
      rows.push(pad([text(row.barMark), text(row.memberMark), text(statusText(row), { muted: true })], width));
    }
  }

  const askable = (result.gaps ?? []).filter((g) => g.askable);
  if (askable.length) {
    rows.push(pad([], width));
    rows.push(pad([text('OPEN QUESTIONS — answering these completes the rows above', { bold: true })], width));
    for (const gap of askable) {
      rows.push(pad([text(gap.memberMark ?? ''), text(gap.field ?? ''), text(gap.message, { muted: true })], width));
    }
  }

  if (result.assumptions?.length) {
    rows.push(pad([], width));
    rows.push(pad([text('ASSUMPTIONS — what was taken, and why', { bold: true })], width));
    for (const a of result.assumptions) {
      rows.push(
        pad([text(a.what), text(a.why, { muted: true }), text(a.toResolve ?? '', { muted: true })], width),
      );
    }
  }

  if (result.warnings?.length) {
    rows.push(pad([], width));
    rows.push(pad([text('WARNINGS', { bold: true })], width));
    for (const w of result.warnings) {
      rows.push(pad([text(w.memberMark ?? ''), text(w.message, { muted: true })], width));
    }
  }

  return {
    name: 'Schedule',
    columns: columns.map((c) => ({ width: columnWidth(c.id) })),
    freezeHeaderRows: headerAt + 1,
    rows,
  };
}

// ------------------------------------------------------------
// the steel summary sheet
// ------------------------------------------------------------

function steelSheet(input: BbsWorkbookInput): XlsxSheet {
  const { lines, mismatchKg } = steelLines(input.result);
  const p = input.provenance ?? {};
  const width = 7;
  const line = (...cells: XlsxCell[]): XlsxRow => pad(cells, width);

  const rows: XlsxRow[] = [
    line(text('STEEL SUMMARY BY DIAMETER', { bold: true }), text(stated(p.drawingName ?? input.result.project?.drawingName))),
    line(
      text('Drawing no.', { bold: true }),
      text(stated(p.drawingNumber)),
      text('Revision', { bold: true }),
      text(stated(p.revision)),
      text('Exported', { bold: true }),
      text(stamp(p.exportedAt)),
    ),
    line(
      text('Basis', { bold: true }),
      text('IS 1786 nominal mass. Wastage as stated on the Schedule sheet. Open rows are in no figure below.', {
        muted: true,
      }),
    ),
    line(text('Scope', { bold: true }), text(scopeText(input.result))),
    line(),
  ];

  const headers = [
    'Ø (mm)',
    'Bars',
    'Total length (m)',
    'Unit wt (kg/m)',
    'Weight (kg)',
    'Weight incl wastage (kg)',
    'of which lap (kg)',
    'Open rows',
  ];
  const headerAt = rows.length;
  rows.push(
    pad(
      headers.map((h, i) => text(h, { bold: true, fill: HEADER_FILL, align: i === 0 ? 'left' : 'right' })),
      width,
      { fill: HEADER_FILL },
    ),
  );

  // the lap share, from the pipeline's own summary — inside the weight, never added again
  const lapOf = (dia: number): number | null =>
    input.result.diameterSummary.find((d) => d.diaMm === dia)?.lapWeightKg ?? null;
  for (const l of lines) {
    rows.push(
      line(
        number(l.diaMm, FMT.count, { align: 'left' }),
        number(l.barCount, FMT.count),
        number(l.totalLengthM, FMT.metres),
        number(l.unitWeightKgPerM, FMT.kgPerM),
        number(l.totalWeightKg, FMT.kg),
        number(l.totalWeightWithWastageKg, FMT.kg),
        number(lapOf(l.diaMm), FMT.kg, { muted: true }),
        l.openRows ? number(l.openRows, FMT.count, { bold: true, muted: true }) : empty(),
      ),
    );
  }

  const anyComputed = input.result.rows.some((r) => !isBlocked(r));
  const sum = (pick: (l: SteelLine) => number | null): number | null =>
    anyComputed ? lines.reduce((n, l) => n + (pick(l) ?? 0), 0) : null;
  const openRows = input.result.rows.filter(isBlocked).length;

  rows.push(
    line(
      text('TOTAL', { bold: true, fill: TOTAL_FILL }),
      number(sum((l) => l.barCount), FMT.count, { bold: true, fill: TOTAL_FILL }),
      number(sum((l) => l.totalLengthM), FMT.metres, { bold: true, fill: TOTAL_FILL }),
      empty({ fill: TOTAL_FILL }),
      number(sum((l) => l.totalWeightKg), FMT.kg, { bold: true, fill: TOTAL_FILL }),
      number(sum((l) => l.totalWeightWithWastageKg), FMT.kg, { bold: true, fill: TOTAL_FILL }),
      number(sum((l) => lapOf(l.diaMm)), FMT.kg, { bold: true, fill: TOTAL_FILL }),
      openRows ? number(openRows, FMT.count, { bold: true, fill: TOTAL_FILL }) : empty({ fill: TOTAL_FILL }),
    ),
  );
  const procurementKg = sum((l) => l.totalWeightWithWastageKg);
  rows.push(
    line(
      text('TOTAL QUANTITY', { bold: true }),
      number(procurementKg === null ? null : procurementKg / 1000, FMT.tonnes, { bold: true }),
      text('MT'),
    ),
  );

  if (!anyComputed) {
    rows.push(line());
    rows.push(
      line(
        text('BLOCKED — no row in this schedule could be computed, so no steel can be ordered from it.', {
          bold: true,
          muted: true,
        }),
      ),
    );
  }
  if (openRows && anyComputed) {
    rows.push(line());
    rows.push(
      line(
        text(
          openRows === 1
            ? '1 row is still open and contributes nothing above — see the Schedule sheet.'
            : `${openRows} rows are still open and contribute nothing above — see the Schedule sheet.`,
          { muted: true },
        ),
      ),
    );
  }
  if (mismatchKg) {
    rows.push(line());
    rows.push(
      line(
        text(
          `NOT RECONCILED — the diameter summary differs from the sum of the schedule rows by ${mismatchKg.toFixed(2)} kg. Neither figure has been adjusted.`,
          { bold: true },
        ),
      ),
    );
  }

  return {
    name: 'Steel summary',
    columns: [{ width: 10 }, { width: 12 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 12 }],
    freezeHeaderRows: headerAt + 1,
    rows,
  };
}

// ------------------------------------------------------------
// the API
// ------------------------------------------------------------

// ------------------------------------------------------------
// the calculation trace sheet
// ------------------------------------------------------------

/**
 * Every row's stage trace, on its own sheet: the stages it reached, and if it
 * stopped, the FAILED_STAGE, MISSING_FACT, SOURCE, REASON and ACTION — plus
 * the facts it rests on and the cover it was cut to. A row that is open says
 * exactly what would close it; a row that computed says what it computed
 * from. Nothing here is a figure the Schedule sheet does not carry.
 */
function traceSheet(input: BbsWorkbookInput): XlsxSheet {
  const result = input.result;
  const p = input.provenance ?? {};
  const width = 12;
  const line = (...cells: XlsxCell[]): XlsxRow => pad(cells, width);
  const rows: XlsxRow[] = [
    line(text('CALCULATION TRACE', { bold: true }), text(stated(p.drawingName ?? result.project?.drawingName))),
    line(
      text('Drawing no.', { bold: true }),
      text(stated(p.drawingNumber)),
      text('Revision', { bold: true }),
      text(stated(p.revision)),
      text('Result id', { bold: true }),
      text(result.id),
    ),
    line(
      text('Stages', { bold: true }),
      text(
        'INPUT_RESOLVED → GEOMETRY_RESOLVED → CUTTING_LENGTH_RESOLVED → QUANTITY_RESOLVED → TOTAL_BARS_RESOLVED → ' +
          'TOTAL_LENGTH_RESOLVED → UNIT_WEIGHT_RESOLVED → WEIGHT_RESOLVED → VALIDATED',
        { muted: true },
      ),
    ),
  ];
  const rec = result.reconciliation;
  if (rec) {
    rows.push(
      line(
        text('Reconciliation', { bold: true }),
        text(
          rec.ok
            ? `RECONCILED — rows ${rec.rowsTotalLengthM.toFixed(2)} m / ${rec.rowsTotalWeightKg.toFixed(2)} kg equal the summary ` +
                `${rec.summaryTotalLengthM.toFixed(2)} m / ${rec.summaryTotalWeightKg.toFixed(2)} kg` +
                (rec.openRows.length ? `; ${rec.openRows.length} open row(s) in no total: ${rec.openRows.join(', ')}` : '')
            : `NOT RECONCILED — ${rec.differences
                .map((d) => `T${d.diaMm}: Δ${d.lengthDiffM.toFixed(2)} m / Δ${d.weightDiffKg.toFixed(2)} kg`)
                .join('; ')}`,
          { bold: !rec.ok },
        ),
      ),
    );
  }
  rows.push(line());
  const headers = [
    'Mark',
    'Member',
    'Stage reached',
    'Failed stage',
    'Missing fact',
    'Source',
    'Reason',
    'Action',
    'Cover (mm)',
    'Cover status',
    'Measured along',
    'Facts used',
  ];
  const headerAt = rows.length;
  rows.push(pad(headers.map((h) => text(h, { bold: true, fill: HEADER_FILL })), width, { fill: HEADER_FILL }));
  for (const row of result.rows) {
    const t = row.trace;
    const blocked = isBlocked(row);
    rows.push(
      line(
        text(row.barMark, { bold: blocked }),
        text(row.memberMark),
        text(t ? t.stages[t.stages.length - 1] ?? '' : blocked ? 'not computed' : 'VALIDATED'),
        text(t?.failedStage ?? '', { bold: blocked }),
        text(t?.missingFact ?? '', { bold: blocked }),
        text(t?.source ?? '', { muted: true }),
        text(t?.reason ?? (blocked ? row.note ?? '' : ''), { muted: true }),
        text(t?.action ?? '', { muted: true }),
        number(row.coverMm ?? t?.coverMm ?? null, FMT.mm),
        text(coverSourceText(row)),
        text(t?.measuredAlong ?? ''),
        text((t?.factsUsed ?? []).join(', '), { muted: true }),
      ),
    );
  }
  // THE INPUTS, AS THEY STOOD: every fact the rows read, with its source type,
  // version, source text and entity handles — the schedule's provenance
  // without the project record to hand.
  if (result.inputFacts?.length) {
    rows.push(line());
    rows.push(line(text('INPUT FACTS — what the rows above were computed from', { bold: true })));
    rows.push(
      pad(
        ['Fact', 'Member', 'Parameter', 'Value', 'Unit', 'Source type', 'Status', 'Version', 'Source text', 'Entity handles', 'Section', 'Drawing hash'].map((h) =>
          text(h, { bold: true, fill: HEADER_FILL }),
        ),
        width,
        { fill: HEADER_FILL },
      ),
    );
    for (const f of result.inputFacts) {
      rows.push(
        line(
          text(f.factId, { bold: f.sourceType === 'MISSING' || f.sourceType === 'UNREADABLE' }),
          text(f.memberId),
          text(f.parameter),
          typeof f.value === 'number' ? number(f.value, FMT.mm) : text(f.value === null ? '' : String(f.value)),
          text(f.unit ?? ''),
          text(f.sourceType, { bold: f.sourceType === 'ASSUMED' }),
          text(f.status),
          number(f.version, FMT.count),
          text(f.sourceText ?? (f.ask ? `OPEN — ${f.ask}` : ''), { muted: true }),
          text(f.sourceEntityHandles.join(', '), { muted: true }),
          text(f.sectionId ?? ''),
          text(f.drawingHash ?? '', { muted: true }),
        ),
      );
    }
  }

  return {
    name: 'Calculation trace',
    columns: [
      { width: 12 },
      { width: 10 },
      { width: 24 },
      { width: 24 },
      { width: 18 },
      { width: 40 },
      { width: 60 },
      { width: 44 },
      { width: 10 },
      { width: 26 },
      { width: 10 },
      { width: 40 },
    ],
    freezeHeaderRows: headerAt + 1,
    rows,
  };
}

/**
 * VALIDATION — calculated is not validated, and this sheet is where the
 * difference is written down. One row per bar: its engineering status, each
 * check by name, what it rests on, and what it waits for. Above them, the
 * four numbers and whether the schedule is FINAL.
 */
function validationSheet(input: BbsWorkbookInput): XlsxSheet {
  const { result } = input;
  const v = result.validation;
  const width = 7;
  const rows: XlsxRow[] = [];
  const line = (...cells: XlsxCell[]): XlsxRow => pad(cells, width);
  rows.push(line(text('ENGINEERING VALIDATION', { bold: true })));
  if (v) {
    rows.push(
      line(
        text(`Status: ${v.status}`, { bold: true }),
        text(v.final ? 'FINAL' : 'NOT FINAL', { bold: true }),
      ),
    );
    rows.push(
      line(
        text(`Calculated rows: ${v.counts.calculated}`),
        text(`Open rows: ${v.counts.open}`),
        text(`Assumed inputs: ${v.counts.assumedInputs}`),
        text(`Validation warnings: ${v.counts.warnings}`),
        text(`Validated: ${v.counts.validated}`),
        text(`Partially: ${v.counts.partiallyValidated}`),
        text(`Rejected: ${v.counts.rejected}`),
      ),
    );
    if (v.blockers.length) {
      rows.push(line());
      rows.push(line(text('WHY NOT FINAL', { bold: true })));
      for (const b of v.blockers) rows.push(line(text(b, { muted: true })));
    }
  } else {
    rows.push(line(text('No validation was recorded for this result.', { muted: true })));
  }
  rows.push(line());
  const headers = ['Mark', 'Member', 'Engineering', 'Check', 'OK', 'Note', 'Rests on / waits for'];
  const headerAt = rows.length;
  rows.push(pad(headers.map((h) => text(h, { bold: true, fill: HEADER_FILL })), width, { fill: HEADER_FILL }));
  for (const r of v?.rows ?? []) {
    const chat = result.rows.find((c) => c.barMark === r.barMark);
    const rests = [...r.assumed.map((a) => `assumes ${a}`), ...r.unresolved.map((u) => `waits for ${u}`)].join('; ');
    for (const [i, c] of r.checks.entries()) {
      rows.push(
        line(
          text(i === 0 ? r.barMark : ''),
          text(i === 0 ? chat?.memberMark ?? '' : ''),
          text(i === 0 ? r.status : '', { bold: i === 0 }),
          text(c.name),
          text(c.ok ? 'yes' : c.severity === 'blocking' ? 'NO — blocking' : c.severity === 'rejecting' ? 'NO — rejected' : 'no — assumed'),
          text(c.note ?? '', { muted: true }),
          text(i === 0 ? rests : '', { muted: true }),
        ),
      );
    }
  }
  return {
    name: 'Validation',
    columns: [{ width: 12 }, { width: 10 }, { width: 22 }, { width: 34 }, { width: 16 }, { width: 60 }, { width: 60 }],
    freezeHeaderRows: headerAt + 1,
    rows,
  };
}

/**
 * UNRESOLVED — what this schedule still needs, in one place: the open rows
 * and the fact each waits on, the questions still open, the assumptions
 * taken, the warnings raised, and any DRIFT between stored and recalculated
 * values. Nothing here is hidden in a cell comment.
 */
function unresolvedSheet(input: BbsWorkbookInput): XlsxSheet {
  const { result } = input;
  const width = 4;
  const rows: XlsxRow[] = [];
  const line = (...cells: XlsxCell[]): XlsxRow => pad(cells, width);
  const section = (title: string): void => {
    if (rows.length) rows.push(line());
    rows.push(line(text(title, { bold: true, fill: HEADER_FILL }), empty({ fill: HEADER_FILL }), empty({ fill: HEADER_FILL }), empty({ fill: HEADER_FILL })));
  };

  section('UNRESOLVED ROWS');
  const open = result.rows.filter(isBlocked);
  if (!open.length) rows.push(line(text('none — every row computed', { muted: true })));
  for (const r of open) {
    rows.push(line(text(r.barMark), text(r.memberMark), text(r.trace?.missingFact ?? ''), text(r.note ?? r.trace?.reason ?? '', { muted: true })));
  }

  section('OPEN QUESTIONS');
  const askable = (result.gaps ?? []).filter((g) => g.askable);
  if (!askable.length) rows.push(line(text('none', { muted: true })));
  for (const g of askable) rows.push(line(text(g.memberMark ?? ''), text(g.field ?? ''), text(g.message, { muted: true })));

  section('ASSUMPTIONS');
  const assumptions = [...(result.validation?.assumptions ?? []), ...(result.assumptions ?? []).map((a) => `${a.what} — ${a.why}`)];
  if (!assumptions.length) rows.push(line(text('none', { muted: true })));
  for (const a of assumptions) rows.push(line(text(a, { muted: true })));

  section('VALIDATION WARNINGS');
  const warned = result.rows.filter((r) => r.engineering === 'REJECTED' || (r.status === 'inferred' && r.note));
  if (!warned.length && !(result.warnings ?? []).length) rows.push(line(text('none', { muted: true })));
  for (const r of warned) rows.push(line(text(r.barMark), text(r.engineering ?? r.status), text(r.note ?? '', { muted: true })));
  for (const w of result.warnings ?? []) rows.push(line(text(w.memberMark ?? ''), text(''), text(w.message, { muted: true })));

  section('DRIFT — stored vs recalculated');
  const drift = result.rowDrift ?? [];
  if (!drift.length) rows.push(line(text('none — stored rows match a fresh pass of the pipeline', { muted: true })));
  for (const d of drift) rows.push(line(text(d.barMark), text(d.field), text(String(d.stored ?? '—')), text(String(d.recalculated ?? '—'))));

  return {
    name: 'Unresolved',
    columns: [{ width: 16 }, { width: 22 }, { width: 40 }, { width: 80 }],
    rows,
  };
}

/** The schedule, its steel summary and the calculation trace, as a workbook. Pure. */
export function buildBbsWorkbook(input: BbsWorkbookInput): XlsxWorkbook {
  return {
    sheets: [scheduleSheet(input), steelSheet(input), traceSheet(input), validationSheet(input), unresolvedSheet(input)],
  };
}

/** The bytes to hand a download. `new Blob([bytes], { type: XLSX_MIME })`. */
export function writeBbsXlsx(input: BbsWorkbookInput): Uint8Array {
  return writeXlsx(buildBbsWorkbook(input));
}

/**
 * The filename, from the DRAWING THIS WAS BUILT FROM and its revision.
 *
 *   Foundations drawings.dxf rev S  →  Foundations_drawings-RevS-BBS-v1.xlsx
 *
 * The stem is the source drawing's own file name (`drawingFile`), because that
 * is the name the person who ran it recognises — they built "the BBS of the
 * foundation drawing", not "the BBS of PCD-IND-B300-S-803-R0". The drawing
 * NUMBER still identifies the document, but it is metadata on the row and in
 * the workbook header, not the label a folder is read by. Number and title are
 * the fallbacks, in that order, for an artifact with no file name recorded.
 */
export function bbsFileName(
  provenance: BbsProvenance = {},
  options: { version?: number } = {},
): string {
  const safe = (v: string): string => v.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
  // A drawing's own extension has no business inside a workbook's name.
  const stem = (v: string): string => v.replace(/\.(dxf|dwg|pdf|xlsx|csv|json)$/i, '');
  const source =
    provenance.drawingFile || provenance.drawingNumber || provenance.drawingName || 'drawing';
  const base = safe(stem(source)) || 'drawing';
  const rev = provenance.revision ? `-Rev${safe(provenance.revision)}` : '';
  const version = options.version ? `-v${options.version}` : '';
  return `${base}${rev}-BBS${version}.xlsx`;
}
