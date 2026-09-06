// ============================================================
// What to call a bar
//
// "F1-M1" is a key, not a description. A schedule a site engineer can check
// names each run the way the trade names it — "Long Bar T10 @ 150c/c (Btm)" —
// so a row can be matched against the drawing without decoding a mark.
//
// Every part of the name is read off the bar itself: the diameter, the
// spacing, which mat it belongs to, and which plan dimension it spans. Nothing
// here invents anything; it is the same facts the row already carries, said in
// words.
//
// ON "LONG" AND "SHORT"
//
// A bar is called long or short by the span it actually crosses — the longer
// of the member's two plan dimensions is the Long Bar. Note that an office's
// own schedule may use the opposite sense, naming bars after the column its
// spreadsheet happens to put a dimension in rather than after the bar's
// length. Where the two disagree the row's own a/b/c figures settle it, which
// is why they are printed beside the name.
// ============================================================
import type { BbsBar, BbsMember } from './types';

const LINK_WORD: Partial<Record<BbsBar['barType'], string>> = {
  TIE: 'Tie',
  STIRRUP: 'Stirrup',
  RING: 'Ring',
};

/** the plan dimension this run crosses, given the axis it repeats along */
function spanMm(bar: BbsBar, member: BbsMember): number | undefined {
  const along = bar.distributionAxis ?? 'H';
  if (along === 'H') return member.heightMm;
  return along === 'L' ? member.widthMm : member.lengthMm;
}

function layerWord(bar: BbsBar): string {
  if (bar.barType === 'TOP') return ' (Top)';
  if (bar.barType === 'BOTTOM') return ' (Btm)';
  return '';
}

/** "@ 150c/c" when spaced, "- 5 nos" when the drawing states a number */
function pitchWord(bar: BbsBar): string {
  if (bar.spacingMm && bar.spacingMm > 0) return ` @ ${Math.round(bar.spacingMm)}c/c`;
  if (bar.manualCount && bar.manualCount > 0) return ` - ${bar.manualCount} nos`;
  return '';
}

/**
 * A trade-readable name for one bar run.
 *
 * Deterministic: the same bar always produces the same name, so two runs of
 * the schedule can be diffed line by line.
 */
export function describeBar(bar: BbsBar, member: BbsMember | undefined): string {
  const dia = `T${bar.diaMm}`;
  const alt = bar.alternate ? '-Alt.' : '';

  const link = LINK_WORD[bar.barType];
  if (link) return `${link} ${dia}${pitchWord(bar)}`;

  if (bar.barType === 'EXTRA') return `Chair ${dia}${pitchWord(bar)}`;
  if (bar.barType === 'CRANK') return `Bent-up Bar ${dia}${pitchWord(bar)}`;

  const along = bar.distributionAxis ?? 'H';
  if (along === 'H') {
    // a pedestal or column main: it runs up the member, not across a plan
    return `Vertical ${dia}${pitchWord(bar)}${alt}`;
  }

  // a mat bar: long or short by the span it crosses
  const span = member ? spanMm(bar, member) : undefined;
  const other =
    member && span !== undefined
      ? span === member.lengthMm
        ? member.widthMm
        : member.lengthMm
      : undefined;
  const word =
    span === undefined || other === undefined
      ? 'Bar'
      : span >= other
        ? 'Long Bar'
        : 'Short Bar';

  return `${word} ${dia}${pitchWord(bar)}${layerWord(bar)}${alt}`;
}
