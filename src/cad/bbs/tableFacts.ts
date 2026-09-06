// ============================================================
// What a schedule TABLE states about its members — read deterministically.
//
// DRAWING-READER LAYER. This is the only place a schedule table's cells are
// turned into facts, and nothing here computes a bar: it reads "F8 | 3200 |
// 3500 | 575" under "W SIZE | L | DEPTH D" and says F8.width = 3200 mm,
// DRAWING_READ, from the FOOTING SCHEDULE, row F8, column "W SIZE".
//
// WHY THIS EXISTS
//
// The foundations sheet carries a FOOTING SCHEDULE with every plan size and
// depth for F1–F9 in machine-readable cells, and the last run still asked the
// user for F8's L × W ("the numeric cells are not machine-readable"), read F3's
// W as 200 mm off a stray dimension, and computed F1's bars from a length the
// table contradicts. The extractor had read the table (extract.tables) — no
// consumer ever grounded a member dimension from it. The model was pointing at
// dimension strings while the answer sat in a cell that names the member.
//
// FACT PRIORITY (the rule the schedule resolves inputs by):
//   1. the latest validated DRAWING_READ fact — a table cell that names the
//      member is the strongest reading a sheet offers;
//   2. the latest USER_INPUT fact;
//   3. a DERIVED fact;
//   4. otherwise MISSING / UNREADABLE — and a question.
//
// Nothing is guessed. A header that cannot be classified yields no fact; a
// cell that is not a plain number yields no fact; a callout that cannot be
// matched to exactly one cell is left to the model's ownership reading.
// ============================================================
import type { DrawingExtract, ExtractedCallout, ExtractedTable } from './types';

export type TableAxis = 'L' | 'W' | 'H';

/** One member dimension a schedule table states. */
export interface TableMemberFact {
  mark: string;
  axis: TableAxis;
  mm: number;
  /** "F8.width" — the ledger id this fact lands under */
  factId: string;
  /** the table's own title, e.g. "FOOTING SCHEDULE :" */
  table: string;
  /** 0-based row within the table's body */
  rowIndex: number;
  /** the header text of the column the value was read from */
  column: string;
  /** the cell as printed */
  saidAs: string;
  /** entity handles of the table's text — the evidence chain */
  handles: string[];
  /** one line for a fact sheet / dimension source */
  source: string;
}

/** One reinforcement cell of a schedule table, tied to the callout in it. */
export interface TableBarCell {
  mark: string;
  rowIndex: number;
  colIndex: number;
  column: string;
  text: string;
  diaMm: number;
  spacingMm?: number;
  /**
   * The member axis the bar RUNS along, when the column header states it:
   * "a(LONG BAR)" runs along L, "b(SHORT BAR)" along W. The axis it is SPACED
   * along is the perpendicular — see `distributionAxisFor`.
   */
  runsAlong?: 'L' | 'W';
  /** the layer, when the header states it ("BOTTOM REINFORCEMENT …") */
  layer?: 'TOP' | 'BOTTOM';
  /**
   * The bar type the column header states, in the engine's own vocabulary:
   * STIRRUPS / LINKS → STIRRUP, TIES → TIE, TOP → TOP, BOTTOM → BOTTOM,
   * MAIN / VERTICAL → MAIN, DIST → DISTRIBUTION. Absent when the header only
   * names the bar's direction ("a(LONG BAR)").
   */
  barType?: 'STIRRUP' | 'TIE' | 'TOP' | 'BOTTOM' | 'MAIN' | 'DISTRIBUTION';
  /** the callout entity this cell holds */
  handle: string;
  source: string;
}

/** A schedule column nobody consumes — X/Y end figures — recorded, not spent. */
export interface TableExtraFact {
  mark: string;
  name: string;
  value: string;
  column: string;
  table: string;
  rowIndex: number;
  source: string;
}

export interface TableFacts {
  dims: TableMemberFact[];
  bars: TableBarCell[];
  extras: TableExtraFact[];
  /** what could not be read — never silent */
  notes: string[];
}

const AXIS_NAME: Record<TableAxis, string> = { L: 'length', W: 'width', H: 'height' };

/** The ledger id for a table dimension — the same shape bbsFacts.ts translates. */
export function tableFactId(mark: string, axis: TableAxis): string {
  return `${mark}.${AXIS_NAME[axis]}`;
}

// ------------------------------------------------------------
// header classification
// ------------------------------------------------------------

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toUpperCase();

/** A header cell that names the member column. */
function isMarkHeader(h: string): boolean {
  const t = norm(h);
  return /\b(MKD|MARK|MEMBER|FOOT(?:ING)?|COL(?:UMN)?|BEAM|PED(?:ESTAL)?|DESIGNATION|TYPE)\b/.test(t) && !/@/.test(t);
}

/** Which member axis a header cell names, when it names one. */
export function axisOfHeader(h: string): TableAxis | null {
  const t = norm(h).replace(/\(.*?\)/g, ' ').replace(/\bSIZE\b|\bMM\b|\bIN\b/g, ' ').trim();
  if (!t) return null;
  if (/\b(DEPTH|THK|THICK(?:NESS)?|HEIGHT|HT)\b/.test(t)) return 'H';
  if (/\b(LENGTH|SPAN)\b/.test(t)) return 'L';
  if (/\b(WIDTH|BREADTH)\b/.test(t)) return 'W';
  // bare letters — "L", "W SIZE", "DEPTH D", "B", "D", "H"
  const letters = t.split(/[^A-Z]+/).filter(Boolean);
  if (letters.length === 1 || letters.every((l) => l === letters[0])) {
    switch (letters[0]) {
      case 'L':
        return 'L';
      case 'W':
      case 'B':
        return 'W';
      case 'D':
      case 'H':
        return 'H';
      default:
        return null;
    }
  }
  return null;
}

/** A header cell that heads a reinforcement column. */
function isBarHeader(h: string): boolean {
  const t = norm(h);
  return /\b(BAR|BARS|REINF|REINFORCEMENT|STEEL|MAIN|DIST(?:RIBUTION)?|TOP|BOTTOM|LINKS?|STIRRUPS?|TIES?)\b/.test(t) || /@/.test(t);
}

function runsAlongOf(h: string): 'L' | 'W' | undefined {
  const t = norm(h);
  if (/\bLONG\b/.test(t)) return 'L';
  if (/\bSHORT\b/.test(t)) return 'W';
  return undefined;
}

function layerOf(h: string): 'TOP' | 'BOTTOM' | undefined {
  const t = norm(h);
  if (/\bBOTTOM\b/.test(t)) return 'BOTTOM';
  if (/\bTOP\b/.test(t)) return 'TOP';
  return undefined;
}

/** The bar type a column header states, when it states one. */
export function barTypeOfHeader(h: string): TableBarCell['barType'] {
  const t = norm(h);
  if (/\b(STIRRUPS?|LINKS?|HOOPS?)\b/.test(t)) return 'STIRRUP';
  if (/\bTIES?\b/.test(t)) return 'TIE';
  if (/\bBOTTOM\b|\bBOT\b/.test(t)) return 'BOTTOM';
  if (/\bTOP\b/.test(t)) return 'TOP';
  if (/\bDIST(?:RIBUTION)?\b/.test(t)) return 'DISTRIBUTION';
  if (/\b(MAIN|VERTICALS?|LONGITUDINAL)\b/.test(t)) return 'MAIN';
  return undefined;
}

/** "X", "(MM) X", "Y" — an end figure the sketch defines and the header does not. */
function extraNameOf(h: string): string | null {
  const t = norm(h).replace(/\(.*?\)/g, ' ').replace(/\bMM\b/g, ' ').trim();
  return /^[XYZ]$/.test(t) ? t.toLowerCase() : null;
}

const numberCell = (cell: string): number | null => {
  const t = cell.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** "0 10@150c/c", "Ø12@100 c/c", "T10@200" — the bar a cell states. */
export function barCellOf(cell: string): { diaMm: number; spacingMm?: number } | null {
  const t = cell.replace(/\s+/g, ' ').trim();
  if (!t || t === '-' || t === '—') return null;
  const m = /(?:^|[^\d])(\d{1,2})\s*(?:MM|Ø|Φ|φ|TOR|T|Y)?\s*@\s*(\d{2,4})\s*(?:MM)?\s*(?:C\/C|C\.C|CC)?/i.exec(t);
  if (m) {
    const dia = Number(m[1]);
    const sp = Number(m[2]);
    if (dia >= 6 && dia <= 40 && sp >= 25 && sp <= 600) return { diaMm: dia, spacingMm: sp };
  }
  return null;
}

// ------------------------------------------------------------
// reading one table
// ------------------------------------------------------------

function markCell(cell: string): string | null {
  const t = cell.trim().toUpperCase();
  return /^[A-Z]{1,3}[0-9]{1,3}[A-Z]?$/.test(t) ? t : null;
}

function readTable(table: ExtractedTable, tableIndex: number, out: TableFacts): void {
  const header = table.header ?? [];
  if (!header.length || !table.rows?.length) return;
  const title = table.title?.trim() || `table ${tableIndex + 1}`;

  let markCol = header.findIndex(isMarkHeader);
  if (markCol === -1) {
    // no header names the mark column — the column whose cells are all marks is it
    for (let c = 0; c < header.length && markCol === -1; c++) {
      const cells = table.rows.map((r) => r[c] ?? '').filter((x) => x.trim());
      if (cells.length && cells.every((x) => markCell(x) !== null)) markCol = c;
    }
  }
  if (markCol === -1) {
    out.notes.push(`${title}: no column names the member, so no dimension was read from it.`);
    return;
  }

  const axisCols: { col: number; axis: TableAxis; header: string }[] = [];
  const barCols: {
    col: number;
    header: string;
    runsAlong?: 'L' | 'W';
    layer?: 'TOP' | 'BOTTOM';
    barType?: TableBarCell['barType'];
  }[] = [];
  const extraCols: { col: number; header: string; name: string }[] = [];
  // Axis headers are assigned in two passes: a header that names the axis in
  // a WORD (WIDTH, DEPTH, SPAN, HEIGHT) is a statement and goes first; a bare
  // letter (B, D, L) fills what is left. "SIZE B | SIZE D | HEIGHT" then
  // reads B → W, HEIGHT → H, and D — its H taken — falls to the free plan
  // axis L, which is what a column schedule's second size is.
  const axisCandidates: { col: number; axis: TableAxis; header: string; word: boolean }[] = [];
  for (let c = 0; c < header.length; c++) {
    if (c === markCol) continue;
    const h = header[c] ?? '';
    if (isBarHeader(h)) {
      barCols.push({ col: c, header: h, runsAlong: runsAlongOf(h), layer: layerOf(h), barType: barTypeOfHeader(h) });
      continue;
    }
    const axis = axisOfHeader(h);
    if (axis) {
      axisCandidates.push({ col: c, axis, header: h, word: /[A-Z]{3,}/.test(norm(h).replace(/\bSIZE\b|\bMM\b|\(.*?\)/g, '')) });
      continue;
    }
    const extra = extraNameOf(h);
    if (extra) extraCols.push({ col: c, header: h, name: extra });
  }
  for (const cand of [...axisCandidates.filter((a) => a.word), ...axisCandidates.filter((a) => !a.word)]) {
    let axis: TableAxis | null = cand.axis;
    if (axisCols.some((a) => a.axis === axis)) {
      // a bare letter whose axis is already stated in words takes the free plan axis
      axis = cand.word ? null : (['L', 'W', 'H'] as TableAxis[]).find((a) => a !== 'H' && !axisCols.some((x) => x.axis === a)) ?? null;
    }
    if (axis) axisCols.push({ col: cand.col, axis, header: cand.header });
  }
  axisCols.sort((a, b) => a.col - b.col);

  table.rows.forEach((row, rowIndex) => {
    const mark = markCell(row[markCol] ?? '');
    if (!mark) return;
    const where = `${title} row ${mark}`;
    for (const a of axisCols) {
      const raw = row[a.col] ?? '';
      const mm = numberCell(raw);
      if (mm === null) {
        if (raw.trim() && raw.trim() !== '-') {
          out.notes.push(`${where}, column "${a.header}": "${raw}" is not a plain figure — not read as ${mark}.${AXIS_NAME[a.axis]}.`);
        }
        continue;
      }
      out.dims.push({
        mark,
        axis: a.axis,
        mm,
        factId: tableFactId(mark, a.axis),
        table: title,
        rowIndex,
        column: a.header,
        saidAs: raw.trim(),
        handles: table.handles ?? [],
        source: `${where}, column "${a.header}" = ${raw.trim()} (schedule table, read deterministically)`,
      });
    }
    for (const b of barCols) {
      const raw = row[b.col] ?? '';
      const bar = barCellOf(raw);
      if (!bar) continue;
      out.bars.push({
        mark,
        rowIndex,
        colIndex: b.col,
        column: b.header,
        text: raw.trim(),
        diaMm: bar.diaMm,
        spacingMm: bar.spacingMm,
        runsAlong: b.runsAlong,
        layer: b.layer,
        ...(b.barType ? { barType: b.barType } : {}),
        handle: '',
        source: `${where}, column "${b.header}" = ${raw.trim()}`,
      });
    }
    for (const e of extraCols) {
      const raw = (row[e.col] ?? '').trim();
      if (!raw || raw === '-') continue;
      out.extras.push({
        mark,
        name: e.name,
        value: raw,
        column: e.header,
        table: title,
        rowIndex,
        source: `${where}, column "${e.header}" = ${raw}`,
      });
    }
  });
}

/**
 * Every member dimension, bar cell and unconsumed figure the sheet's schedule
 * tables state. Pure; reads only what the extractor already harvested.
 */
export function memberFactsFromTables(extract: Pick<DrawingExtract, 'tables'>): TableFacts {
  const out: TableFacts = { dims: [], bars: [], extras: [], notes: [] };
  (extract.tables ?? []).forEach((t, i) => readTable(t, i, out));
  return out;
}

// ------------------------------------------------------------
// callouts ⇄ cells
// ------------------------------------------------------------

const inside = (c: ExtractedCallout, t: ExtractedTable): boolean =>
  c.position.x >= t.min.x && c.position.x <= t.max.x && c.position.y >= t.min.y && c.position.y <= t.max.y;

const sameBar = (cell: string, callout: string): boolean => {
  const a = norm(cell).replace(/[^A-Z0-9@\/]/g, '');
  const b = norm(callout).replace(/[^A-Z0-9@\/]/g, '');
  return a === b || a.endsWith(b) || a.includes(b);
};

/**
 * Which schedule cell each callout sits in — by position, checked by text.
 *
 * The extractor keeps the table as text and bounds only, so a callout is
 * placed by clustering the callouts inside the table into rows (by y) and
 * zipping each row's callouts, left to right, onto that table row's bar
 * cells in column order. Every zip is checked: the counts must agree and
 * each callout's text must be the cell's. A table that fails either check
 * contributes no mapping — the model's ownership reading stands for it.
 */
export function tableCellsForCallouts(
  extract: Pick<DrawingExtract, 'tables' | 'callouts'>,
  facts: TableFacts = memberFactsFromTables(extract),
): Map<string, TableBarCell> {
  const out = new Map<string, TableBarCell>();
  (extract.tables ?? []).forEach((table, tableIndex) => {
    const title = table.title?.trim() || `table ${tableIndex + 1}`;
    const cells = facts.bars.filter((b) => b.source.startsWith(`${title} row `));
    if (!cells.length) return;
    const inTable = (extract.callouts ?? []).filter((c) => inside(c, table));
    if (!inTable.length) return;

    // rows of callouts, top to bottom
    const sorted = [...inTable].sort((a, b) => b.position.y - a.position.y);
    const bodyRows = new Set(cells.map((c) => c.rowIndex)).size;
    const height = table.max.y - table.min.y;
    const tol = Math.max(1, (height / (bodyRows + 2)) * 0.4);
    const clusters: ExtractedCallout[][] = [];
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last[0].position.y - c.position.y) <= tol) last.push(c);
      else clusters.push([c]);
    }
    const rowIndexes = [...new Set(cells.map((c) => c.rowIndex))].sort((a, b) => a - b);
    if (clusters.length !== rowIndexes.length) {
      facts.notes.push(
        `${title}: ${clusters.length} row(s) of callouts inside the table against ${rowIndexes.length} row(s) with bar cells — ` +
          'the callouts were not tied to cells.',
      );
      return;
    }
    const staged: [string, TableBarCell][] = [];
    for (let i = 0; i < clusters.length; i++) {
      const rowCells = cells.filter((c) => c.rowIndex === rowIndexes[i]).sort((a, b) => a.colIndex - b.colIndex);
      const rowCallouts = [...clusters[i]].sort((a, b) => a.position.x - b.position.x);
      if (rowCells.length !== rowCallouts.length) {
        facts.notes.push(
          `${title} row ${rowCells[0]?.mark ?? i + 1}: ${rowCallouts.length} callout(s) against ${rowCells.length} bar cell(s) — not tied.`,
        );
        return;
      }
      for (let k = 0; k < rowCells.length; k++) {
        if (!sameBar(rowCells[k].text, rowCallouts[k].raw)) {
          facts.notes.push(
            `${title} row ${rowCells[k].mark}: callout "${rowCallouts[k].raw}" does not read as cell "${rowCells[k].text}" — not tied.`,
          );
          return;
        }
        staged.push([rowCallouts[k].handle, { ...rowCells[k], handle: rowCallouts[k].handle }]);
      }
    }
    for (const [handle, cell] of staged) out.set(handle, cell);
  });
  return out;
}

/** The axis a bar is SPACED along, from the axis it runs along. */
export function distributionAxisFor(runsAlong: 'L' | 'W'): 'L' | 'W' {
  return runsAlong === 'L' ? 'W' : 'L';
}

/** Dimension facts by member mark and axis — the shape `buildOnce` resolves from. */
export function tableDimsByMark(facts: TableFacts): Map<string, Partial<Record<TableAxis, TableMemberFact>>> {
  const out = new Map<string, Partial<Record<TableAxis, TableMemberFact>>>();
  for (const d of facts.dims) {
    const cur = out.get(d.mark) ?? {};
    // the first statement of an axis governs; a second table restating it is
    // recorded in notes by the caller if it disagrees
    if (!cur[d.axis]) cur[d.axis] = d;
    out.set(d.mark, cur);
  }
  return out;
}
