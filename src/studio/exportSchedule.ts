// ============================================================
// The schedule, downloaded — STUDIO_DESIGN §6.2's last rule.
//
//   "Export mirrors the screen. CSV and XLSX carry exactly the visible columns
//    in the visible order. A schedule that exports differently from how it was
//    checked is a different document."
//
// So nothing here chooses a column. The caller hands over the set the table is
// showing — `deriveColumns(rows)` from schedule.ts returns that shape already —
// and the workbook writes it. `defaultColumns` exists in the workbook for a
// caller with no table on screen; this module never reaches for it.
//
// ONE GRID, TWO RENDERINGS
//
// The CSV is not built from the result a second time. It is the SAME grid
// `buildBbsWorkbook` produced, serialised as text — which is the whole reason
// src/cad/bbs/sheet.ts exists in the shape it does ("The screen and the CSV
// were built by separate code from the same result"). Two builders drift; one
// grid cannot. Everything the workbook does for honesty — a blocked row's
// quantity cells left EMPTY rather than zero, a total over nothing printing no
// figure — is therefore true of the CSV for free.
//
// AND THE CLOCK IS THE CALLER'S. `bbsWorkbook` never reads one; `exportedAt`
// is supplied here, at the moment the person clicked, so a re-export of an old
// artifact is stamped when it was exported and not when it was computed.
// ============================================================
import {
  bbsFileName,
  buildBbsWorkbook,
  writeBbsXlsx,
  XLSX_MIME,
  type BbsExportColumn,
  type BbsProvenance,
  type BbsWorkbookInput,
} from '../io/bbsWorkbook';
import type { XlsxValue } from '../io/xlsx';
import type { ScheduleColumn } from './schedule';

export { XLSX_MIME, bbsFileName };
export type { BbsProvenance, BbsWorkbookInput };

export const CSV_MIME = 'text/csv;charset=utf-8';

export type ExportGroupBy = 'member' | 'dia' | 'shape';

/**
 * The workbook groups by member or by diameter. A screen grouped by SHAPE
 * exports in the schedule's own member order rather than inventing a third
 * grouping the export has never been checked against — the rows and the
 * columns are still exactly the visible ones.
 */
export const workbookGroup = (group: ExportGroupBy): 'member' | 'dia' =>
  group === 'dia' ? 'dia' : 'member';

/**
 * The on-screen column set, as the workbook takes it. `ScheduleColumn` and
 * `BbsExportColumn` are structurally identical on purpose, so this is a copy
 * and never a translation — there is no opportunity for the two to disagree.
 */
export const exportColumns = (columns: readonly ScheduleColumn[]): BbsExportColumn[] =>
  columns.map((c) => ({ id: c.id, label: c.label, numeric: c.numeric }));

// ------------------------------------------------------------
// CSV, off the workbook's own grid
// ------------------------------------------------------------

function csvCell(v: XlsxValue): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trailing padding is layout, not data — it does not travel into the CSV. */
function trimTrailing(cells: readonly XlsxValue[]): XlsxValue[] {
  const out = [...cells];
  while (out.length && (out[out.length - 1] === null || out[out.length - 1] === '')) out.pop();
  return out;
}

export function scheduleCsv(input: BbsWorkbookInput): string {
  const sheet = buildBbsWorkbook(input).sheets[0];
  return sheet.rows
    .map((row) => trimTrailing(row.map((c) => c.v)).map(csvCell).join(','))
    .join('\r\n');
}

// ------------------------------------------------------------
// the download itself
// ------------------------------------------------------------

/**
 * Hand the browser some bytes under a name.
 *
 * The object URL is revoked as soon as the click has been dispatched — an
 * un-revoked blob URL pins the whole workbook in memory for the life of the
 * document, and a schedule is not small.
 */
export function downloadBytes(
  bytes: Uint8Array | string,
  filename: string,
  mime: string,
): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ScheduleDownloadInput extends BbsWorkbookInput {
  /** the artifact version, when this schedule is a filed one — v7, v8 … */
  version?: number;
}

/** .xlsx of exactly what is on screen. Returns the filename it used. */
export function downloadScheduleXlsx(input: ScheduleDownloadInput): string {
  const { version, ...workbook } = input;
  const name = bbsFileName(workbook.provenance, version ? { version } : {});
  downloadBytes(writeBbsXlsx(workbook), name, XLSX_MIME);
  return name;
}

/** .csv of the same grid, same columns, same order. */
export function downloadScheduleCsv(input: ScheduleDownloadInput): string {
  const { version, ...workbook } = input;
  const name = bbsFileName(workbook.provenance, version ? { version } : {}).replace(
    /\.xlsx$/,
    '.csv',
  );
  downloadBytes(scheduleCsv(workbook), name, CSV_MIME);
  return name;
}
