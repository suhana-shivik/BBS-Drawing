// ============================================================
// What the DRAWING ITSELF says it is not going to tell you.
//
// A detail sheet is not always a complete statement of the steel. A pedestal
// template draws the bar, gives its diameter and its ties, and then writes
// "CUTTING LENGTH — INPUT" and "ENTER DESIGN LENGTH / QTY" in the schedule
// block: the sheet is saying, in as many words, that this figure is a design
// decision it does not carry. The foundation embedment and the starter
// projection that would fix the vertical bar's length are simply not on it.
//
// Nothing read those words. The engine went looking for a length anyway, found
// the only dimension the member had — its height — cut a bar from it, and the
// IS 456 anchorage gate refused the result. The row then blocked with a
// sentence about development length, which is true and is not the point: the
// drawing had already said the number was an input, and the one correct
// response was to ask for it.
//
// So this reads those declarations. It is deliberately narrow — it only
// believes a cell that says nothing BUT "input" (or its kin), never a cell
// that happens to contain the word — because a false design input would ask a
// person for a figure the sheet has already given them, which is the fastest
// way to teach someone the tool cannot read.
// ============================================================
import type { DrawingExtract, ExtractedTable } from './types';

export interface DesignInputDeclaration {
  /** the row's mark, when the row names one — "P1-V1" */
  mark?: string;
  /** the member that mark belongs to — "P1-V1" → "P1" */
  memberMark?: string;
  /**
   * The bar diameter the same row states, when it states one.
   *
   * This is the bridge to the engine's own rows, and it is deliberately a
   * value the SHEET wrote rather than an inference about naming. The engine
   * marks bars `P1-M1` / `P1-T1` from the member and the bar family; the sheet
   * marks them `P1-V1` / `P1-T1` in its own convention. Reading "V means
   * vertical means a main bar" would be this file guessing at one office's
   * habit. The diameter on the row is not a guess: a Ø16 row is about the Ø16
   * bars of that member, whatever either side calls them.
   */
  diaMm?: number;
  /** the column left open, normalised — "cutting_length" */
  field: string;
  /** the column as the sheet heads it — "CUTTING LENGTH" */
  fieldLabel: string;
  /** the sheet's own words in the cell, verbatim */
  saidAs: string;
  /** where it was read, for the audit trail */
  where: string;
}

/**
 * A cell that is a REFUSAL to state a value, and nothing else.
 *
 * Anchored at both ends on purpose. "INPUT" alone is a declaration; "INPUT
 * 2300" is a value with a label and must not be read as a gap.
 */
const DECLARES_INPUT =
  /^(?:input|user\s*input|design\s*input|enter|to\s*enter|tbd|t\.b\.d\.?|to\s+be\s+(?:decided|advised|confirmed|determined)|by\s+(?:designer|others|structural\s+engineer)|as\s+per\s+design|refer\s+design|per\s+design|design)$/i;

/** "CUTTING LENGTH" → "cutting_length" — the shape a fact id takes. */
export function fieldKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\bno\.?\s*\/\s*member\b/, 'bars per member')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * A bar or member mark: "P1-V1", "F4-M2", "P1". Deliberately not a general
 * identifier — a row whose first cell is "TOTAL" or a bare number names no
 * member and its open cells belong to no mark.
 */
const MARK = /^[A-Z]{1,4}\d{1,3}(?:-[A-Z]{1,3}\d{0,3})?$/;

function markOfRow(row: readonly string[]): string | undefined {
  for (const cell of row) {
    const t = cell.trim().toUpperCase();
    if (MARK.test(t)) return t;
  }
  return undefined;
}

/** "P1-V1" → "P1"; a mark with no bar suffix is its own member. */
export function memberOfMark(mark: string): string {
  const dash = mark.indexOf('-');
  return dash === -1 ? mark : mark.slice(0, dash);
}

/** The diameter the row states, read from the column headed DIA. */
function diaOfRow(header: readonly string[], row: readonly string[]): number | undefined {
  const i = header.findIndex((h) => /\b(?:dia|diameter)\b|^[øφ]/i.test(h.trim()));
  if (i < 0) return undefined;
  const m = /(\d{1,2}(?:\.\d+)?)/.exec((row[i] ?? '').trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function fromTable(table: ExtractedTable): DesignInputDeclaration[] {
  const out: DesignInputDeclaration[] = [];
  // Without a header there is no way to say WHICH figure the sheet is leaving
  // open, and "something on this row is an input" is not a question anybody
  // can answer. A headerless table is left alone rather than guessed at.
  if (!table.header.length) return out;
  for (const row of table.rows) {
    const mark = markOfRow(row);
    const dia = diaOfRow(table.header, row);
    row.forEach((cell, i) => {
      const said = cell.trim();
      if (!DECLARES_INPUT.test(said)) return;
      const label = (table.header[i] ?? '').trim();
      if (!label) return;
      const field = fieldKey(label);
      if (!field) return;
      out.push({
        ...(mark ? { mark, memberMark: memberOfMark(mark) } : {}),
        ...(dia !== undefined ? { diaMm: dia } : {}),
        field,
        fieldLabel: label,
        saidAs: said,
        where: table.title ? `${table.title} — the ${label} column` : `the ${label} column`,
      });
    });
  }
  return out;
}

/**
 * Every field this drawing declares to be a design input rather than stating.
 *
 * Deduplicated by mark+field: a template that writes "INPUT" down a whole
 * column is making ONE statement about that column, and asking a person the
 * same question once per row is how an interview becomes a form.
 */
export function designInputsFrom(extract: DrawingExtract): DesignInputDeclaration[] {
  const seen = new Set<string>();
  const out: DesignInputDeclaration[] = [];
  for (const table of extract.tables) {
    for (const found of fromTable(table)) {
      const key = `${found.mark ?? '-'}:${found.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(found);
    }
  }
  return out;
}

/** The ledger id an answer to one of these lands under. */
export function factIdForDesignInput(d: DesignInputDeclaration): string {
  return d.mark ? `${d.mark}.${d.field}` : `settings.${d.field}`;
}

/**
 * The question, in the sheet's own terms.
 *
 * It quotes the drawing because that is what makes it answerable and what
 * proves the tool read the sheet rather than failed on it: a person told "the
 * drawing says INPUT here" knows immediately that this is theirs to supply,
 * and does not go hunting the sheet for a number that was never on it.
 */
export function askForDesignInput(d: DesignInputDeclaration): string {
  const subject = d.mark ? `${d.mark}'s ${d.fieldLabel.toLowerCase()}` : d.fieldLabel.toLowerCase();
  return (
    `What is ${subject}? This drawing does not state it — ${d.where} reads "${d.saidAs}", ` +
    'so the sheet is saying the figure is a design decision it does not carry. ' +
    'Give the number and this row computes; nothing will be derived for it.'
  );
}

/**
 * The declaration that governs one engine row's cutting length, if any.
 *
 * Two ways to match, both of them things somebody wrote down:
 *
 *   the mark, exactly — when the model took the bar mark off the schedule row
 *   the member AND the diameter — when it did not
 *
 * There is deliberately no third. A declaration naming a bar this build has no
 * row for is left unmatched rather than spread across the member's other bars:
 * holding a tie open because a vertical was declared an input would block a row
 * the sheet fully states, which is the same disease in the other direction.
 */
export function cuttingLengthInputFor(
  declared: readonly DesignInputDeclaration[],
  bar: { mark: string; memberMark: string; diaMm?: number },
): DesignInputDeclaration | null {
  const wanted = declared.filter((d) => d.field === 'cutting_length');
  const exact = wanted.find((d) => d.mark?.toUpperCase() === bar.mark.toUpperCase());
  if (exact) return exact;
  if (bar.diaMm === undefined) return null;
  return (
    wanted.find(
      (d) =>
        d.memberMark?.toUpperCase() === bar.memberMark.toUpperCase() && d.diaMm === bar.diaMm,
    ) ?? null
  );
}
