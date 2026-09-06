// ============================================================
// Reading an electrical cable schedule
//
// A cable schedule is the quantity source for every cable line in an
// electrical BOQ — on the Oriental tender, 43 of 70 measurable rows. The sheet
// already contains a summary block, and the temptation is to just read it.
//
// This does not do that. It reads the DETAIL rows, computes the totals itself,
// and then compares its own figures against the summary the consultant typed.
// Agreement is evidence. Disagreement is reported, never silently resolved,
// because the summary block is a hand-maintained formula range and is exactly
// the thing that goes stale when a circuit is added late.
//
// The AI is not involved here at any point. Cable sizes are matched by pattern
// and every number is arithmetic on cells.
// ============================================================
// v1: src/io/spreadsheet not ported — trivial type shapes inlined verbatim.
export type CellValue = string | number | null;
export interface Sheet {
  name: string;
  rows: CellValue[][];
}

export interface CableRun {
  /** 0-based row in the source sheet, for click-through */
  row: number;
  from: string;
  to: string;
  /** normalised, so "3 x 240 Sq. mm." and "3C x 240 Sq.mm" are one size */
  size: string;
  sizeRaw: string;
  runs: number;
  lengthEach: number;
  totalLength: number;
  terminations: number;
}

export interface CableGroup {
  size: string;
  /** metres, summed from the detail rows */
  totalLength: number;
  terminations: number;
  /** how many schedule lines feed this size */
  circuits: number;
  runs: number;
  rows: number[];
}

export interface StatedTotal {
  row: number;
  size: string;
  totalLength: number;
  terminations: number;
}

export interface Discrepancy {
  size: string;
  field: 'length' | 'terminations';
  computed: number;
  stated: number;
}

/**
 * What the sheet calls itself, taken from the rows above the table.
 *
 * The boq-tender skill is emphatic about this: a schedule compared against the
 * wrong revision is worse than no comparison at all. So the provenance travels
 * with the numbers rather than being left behind in the file name.
 */
export interface ScheduleIdentity {
  title: string;
  project: string;
  revision: string;
  dated: string;
}

export interface CableScheduleReading {
  sheet: string;
  identity: ScheduleIdentity;
  headerRow: number;
  runs: CableRun[];
  groups: CableGroup[];
  /** the sheet's own summary block, if it has one */
  stated: StatedTotal[];
  discrepancies: Discrepancy[];
  warnings: string[];
}

const text = (v: CellValue): string => (v === null || v === undefined ? '' : String(v)).trim();

const num = (v: CellValue): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const cleaned = text(v).replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

const flat = (v: CellValue): string => text(v).toLowerCase().replace(/\s+/g, ' ');

/**
 * Reduce a written cable size to a comparable key.
 *
 * The same cable is written "3 x 240 Sq. mm." in the detail rows and
 * "3C x 240 Sq. mm." in the summary of the very same sheet; elsewhere
 * "3.5 x 240 Sqmm" and "3.5 x 240 Sq.mm". Grouping on the raw text splits one
 * cable into three, and each fragment then reconciles against nothing.
 */
export function normaliseCableSize(raw: string): string {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const m = /(\d+(?:\.\d+)?)\s*c?\s*[x×]\s*(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return raw.trim();
  const cores = Number(m[1]);
  const area = Number(m[2]);
  // trailing ".0" on a core count is noise; ".5" is not
  const coreLabel = Number.isInteger(cores) ? String(cores) : String(cores);
  return `${coreLabel}C x ${area} sq.mm`;
}

/** True when a cell looks like a cable size rather than a note or a blank. */
function looksLikeSize(v: CellValue): boolean {
  return /\d+(\.\d+)?\s*c?\s*[x×]\s*\d+/i.test(text(v));
}

interface Columns {
  from: number;
  to: number;
  size: number;
  runs: number;
  lengthEach: number;
  totalLength: number;
  terminations: number;
}

function findColumn(header: CellValue[], test: (s: string) => boolean): number {
  for (let i = 0; i < header.length; i += 1) {
    if (test(flat(header[i]))) return i;
  }
  return -1;
}

/**
 * Locate the detail header by content, not by row number.
 *
 * Every consultant puts a different number of title and logo rows above the
 * table. Hard-coding "row 4" works on one file.
 */
function findHeader(rows: CellValue[][]): { row: number; columns: Columns } | null {
  for (let r = 0; r < Math.min(rows.length, 60); r += 1) {
    const header = rows[r] ?? [];
    const size = findColumn(header, (s) => /cable size/.test(s));
    const runs = findColumn(header, (s) => /no\.? of runs|nos?\.? of runs/.test(s));
    if (size < 0 || runs < 0) continue;

    // "Total Length" must be tested before plain "Length", or the per-run
    // length is mistaken for the total and every quantity comes out short.
    const totalLength = findColumn(header, (s) => /total length/.test(s));
    const lengthEach = findColumn(
      header,
      (s) => /^length\b/.test(s) && !/total/.test(s),
    );
    const terminations = findColumn(header, (s) => /termi/.test(s));

    return {
      row: r,
      columns: {
        from: findColumn(header, (s) => /^from$/.test(s)),
        to: findColumn(header, (s) => /^to$/.test(s)),
        size,
        runs,
        lengthEach,
        totalLength,
        terminations,
      },
    };
  }
  return null;
}

/**
 * The consultant's own summary block, when present.
 *
 * Recognised by its header rather than its position. Note that "TOTAL LENGTH"
 * appears twice on the Oriental sheet — once as the real total and again after
 * a 5% wastage allowance — so the FIRST match is the one to read.
 */
function readStated(rows: CellValue[][], afterRow: number): StatedTotal[] {
  for (let r = afterRow; r < rows.length; r += 1) {
    const header = rows[r] ?? [];
    const sizeCol = findColumn(header, (s) => /cable size/.test(s));
    const lengthCol = findColumn(header, (s) => /total length/.test(s));
    const termCol = findColumn(header, (s) => /total termi|termi/.test(s));
    if (sizeCol < 0 || lengthCol < 0) continue;

    const out: StatedTotal[] = [];
    for (let i = r + 1; i < rows.length; i += 1) {
      const row = rows[i] ?? [];
      if (!looksLikeSize(row[sizeCol])) {
        // one blank row inside the block is formatting, several mean the end
        if (row.every((c) => text(c) === '')) continue;
        if (out.length) break;
        continue;
      }
      out.push({
        row: i,
        size: normaliseCableSize(text(row[sizeCol])),
        totalLength: num(row[lengthCol]),
        terminations: termCol >= 0 ? num(row[termCol]) : 0,
      });
    }
    return out;
  }
  return [];
}

/**
 * Read the title, project, revision and date from the rows above the table.
 *
 * Revisions appear as "(R0)" in a title, or as a bare "R1"/"Rev A" on its own
 * line. A date may be written "Dated:- 30 /07/2024" with stray spaces, or
 * arrive as an Excel serial, in which case it is left as the sheet showed it
 * rather than converted with a guessed epoch.
 */
export function readIdentity(rows: CellValue[][], headerRow: number): ScheduleIdentity {
  const above = rows.slice(0, headerRow < 0 ? Math.min(rows.length, 8) : headerRow);
  const lines = above.flatMap((r) => r.map(text).filter(Boolean));

  let title = '';
  let project = '';
  let revision = '';
  let dated = '';

  for (const line of lines) {
    if (!dated) {
      const d = /dated?\s*[:\-–]*\s*(.+)$/i.exec(line);
      if (d) dated = d[1].replace(/\s*\/\s*/g, '/').trim();
    }
    if (!revision) {
      const r =
        /\(\s*(R\d+[A-Z]?)\s*\)/i.exec(line) ??
        /\b(REV(?:ISION)?[\s.:-]*[A-Z0-9]+)\b/i.exec(line) ??
        /^\s*(R\d+[A-Z]?)\s*$/i.exec(line);
      if (r) revision = r[1].toUpperCase().replace(/\s+/g, ' ');
    }
    if (!title && /schedule|boq|bill of quant/i.test(line)) {
      title = line.replace(/["“”]/g, '').trim();
    }
    if (!project && /proposed|project|park|warehou?se/i.test(line) && !/schedule/i.test(line)) {
      // titles wrap across rows in these files; keep the first line only
      project = line.split(/\r?\n/)[0].trim();
    }
  }

  return { title, project, revision, dated };
}

/** Sheets are compared on rounded metres; a float tail is not a disagreement. */
const differs = (a: number, b: number): boolean => Math.abs(a - b) > 0.5;

export function readCableSchedule(sheet: Sheet): CableScheduleReading {
  const warnings: string[] = [];
  const found = findHeader(sheet.rows);
  if (!found) {
    return {
      sheet: sheet.name,
      identity: readIdentity(sheet.rows, -1),
      headerRow: -1,
      runs: [],
      groups: [],
      stated: [],
      discrepancies: [],
      warnings: [
        'No cable schedule table found — expected a header row naming "Cable Sizes" and "No. of Runs".',
      ],
    };
  }

  const { row: headerRow, columns: c } = found;
  if (c.totalLength < 0 && c.lengthEach < 0) {
    warnings.push('No length column found; lengths will read as zero.');
  }
  if (c.terminations < 0) {
    warnings.push('No termination column found; terminations are derived as runs × 2.');
  }

  // --- detail rows ---
  const runs: CableRun[] = [];
  for (let r = headerRow + 1; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] ?? [];
    if (!looksLikeSize(row[c.size])) continue;
    // the summary block also holds cable sizes; it starts once the From/To
    // columns stop being filled in
    const from = c.from >= 0 ? text(row[c.from]) : '';
    const to = c.to >= 0 ? text(row[c.to]) : '';
    if (!from && !to) break;

    const nRuns = c.runs >= 0 ? num(row[c.runs]) || 1 : 1;
    const each = c.lengthEach >= 0 ? num(row[c.lengthEach]) : 0;
    const total = c.totalLength >= 0 ? num(row[c.totalLength]) : each * nRuns;

    if (c.totalLength >= 0 && c.lengthEach >= 0 && each > 0 && differs(total, each * nRuns)) {
      warnings.push(
        `Row ${r + 1}: stated total ${total} m does not equal ${each} m × ${nRuns} runs.`,
      );
    }

    runs.push({
      row: r,
      from,
      to,
      size: normaliseCableSize(text(row[c.size])),
      sizeRaw: text(row[c.size]),
      runs: nRuns,
      lengthEach: each,
      totalLength: total,
      // two ends per run is the physical fact; the column, when present, wins
      terminations: c.terminations >= 0 ? num(row[c.terminations]) : nRuns * 2,
    });
  }

  // --- our own totals ---
  const bySize = new Map<string, CableGroup>();
  for (const run of runs) {
    const g = bySize.get(run.size) ?? {
      size: run.size,
      totalLength: 0,
      terminations: 0,
      circuits: 0,
      runs: 0,
      rows: [],
    };
    g.totalLength += run.totalLength;
    g.terminations += run.terminations;
    g.circuits += 1;
    g.runs += run.runs;
    g.rows.push(run.row);
    bySize.set(run.size, g);
  }
  const groups = [...bySize.values()].sort((a, b) => a.size.localeCompare(b.size));

  // --- reconcile against what the sheet claims ---
  const stated = readStated(sheet.rows, headerRow + 1);
  const discrepancies: Discrepancy[] = [];
  for (const s of stated) {
    const g = bySize.get(s.size);
    if (!g) {
      warnings.push(`Summary lists ${s.size}, which no detail row uses.`);
      continue;
    }
    if (differs(g.totalLength, s.totalLength)) {
      discrepancies.push({
        size: s.size,
        field: 'length',
        computed: g.totalLength,
        stated: s.totalLength,
      });
    }
    if (s.terminations > 0 && differs(g.terminations, s.terminations)) {
      discrepancies.push({
        size: s.size,
        field: 'terminations',
        computed: g.terminations,
        stated: s.terminations,
      });
    }
  }
  for (const g of groups) {
    if (stated.length && !stated.some((s) => s.size === g.size)) {
      warnings.push(`${g.size} is scheduled but missing from the summary block.`);
    }
  }

  return {
    sheet: sheet.name,
    identity: readIdentity(sheet.rows, headerRow),
    headerRow,
    runs,
    groups,
    stated,
    discrepancies,
    warnings,
  };
}
