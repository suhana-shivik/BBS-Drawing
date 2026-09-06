// Rebar callout grammar.
//
// This module reads what a callout SAYS. It never decides what the bar is for,
// never picks a shape code and never computes a length — a callout that reads
// "8 (2L)@100 C/C" yields `dia 8, legs 2, spacing 100` and nothing else. The
// AI pass decides which member it belongs to; the engine does the arithmetic.
//
// UNITS. Every number here comes out of drawing TEXT, and a detailer writes
// millimetres. These values are therefore already in millimetres and must NOT
// be multiplied by `CadDocument.unitScale` — that scale converts drawing
// GEOMETRY (coordinates, measured lengths) into millimetres. Scaling a written
// "16" by a lying $INSUNITS of inches would report a 406 mm bar.
import type { ExtractedCallout } from './types';

/**
 * Rolled bar sizes. IS 1786 stock plus the sizes that turn up on imported or
 * legacy drawings (5, 14, 18, 22).
 *
 * This set is the single thing that keeps "SECTION 1-1" and "Geotechnical
 * Report : BH_1-2" from being read as reinforcement: `n-φ` only parses when
 * the φ half is a diameter that exists. It is a spelling rule, not a guess
 * about meaning — a number that cannot be a bar size is simply not read as one.
 */
const DIAMETERS: ReadonlySet<number> = new Set([
  5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50,
]);

/** widest believable bar spacing, mm — beyond this the number is not a pitch */
const MAX_SPACING = 2000;
const MIN_SPACING = 25;
/** a bar count on one callout; "100-16" is a schedule total, still plausible */
const MAX_COUNT = 999;

const isDia = (n: number): boolean => DIAMETERS.has(n);
const isSpacing = (n: number): boolean => n >= MIN_SPACING && n <= MAX_SPACING;
const isCount = (n: number): boolean => n >= 1 && n <= MAX_COUNT;

/**
 * Fold the many ways a drawing writes "diameter" into one marker.
 *
 * `%%c` is the DXF escape, `Ø ø Φ φ ⌀` are the literal glyphs (upper-casing
 * already folds the lower-case pair), and plenty of offices just write "dia".
 * Whitespace is collapsed because "10- 20+14- 16" and "10-20+14-16" are the
 * same callout typed by two different detailers.
 */
export function normaliseCallout(raw: string): string {
  return raw
    .replace(/%%[cC]/g, 'Ø')
    .toUpperCase()
    .replace(/[Φ⌀ϴΘ]/g, 'Ø')
    .replace(/\bDIA\.?\b/g, 'Ø')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this text look like a rebar annotation at all?
 *
 * Deliberately loose: anything carrying a spacing marker, a diameter symbol or
 * a leg count is a callout even when the rest of it defeats the grammar, so an
 * unparsed string still reaches the AI pass with its `raw` intact. Shapes that
 * are only suggestive (`n-φ`) are left to `parseCallout` to confirm, because a
 * bare "1-1" is a section tag far more often than it is steel.
 */
export function hasCalloutMarker(raw: string): boolean {
  const s = normaliseCallout(raw);
  return (
    /@\s*\d/.test(s) ||
    /\d\s*(?:MM)?\s*(?:C\s*\/\s*C|CTS|CRS)\b/.test(s) ||
    /Ø\s*\d|\d\s*Ø/.test(s) ||
    /\(\s*\d\s*L[A-Z.]*\s*\)/.test(s) ||
    /\b\d\s*-?\s*LEG(?:GED|S)?\b/.test(s)
  );
}

/**
 * "ZONE A-8 @100C/C" → zone "ZONE A", remainder "-8 @100C/C"
 *
 * The label has to be SEPARATED from the word ZONE — by a space, a dash or a
 * colon. Without that the plural did it: "@100 c/c IN 300 END ZONES" matched
 * ZONE followed by the letter S, and the callout came back tagged "ZONE S" —
 * a zone that is on no drawing. An invented qualifier then travels as a real
 * one, and two spacings of one tie become two different bars.
 */
function takeZone(s: string): { zone?: string; rest: string } {
  const m = /\bZONE\s*[-:]\s*([A-Z0-9]{1,2})\b|\bZONE\s+([A-Z0-9]{1,2})\b/.exec(s);
  if (!m) return { rest: s };
  return {
    zone: `ZONE ${m[1] ?? m[2]}`,
    rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(),
  };
}

function takeLegs(s: string): number | undefined {
  const paren = /\(\s*(\d)\s*L[A-Z.]*\s*\)/.exec(s);
  if (paren) return Number(paren[1]);
  const word = /\b(\d)\s*-?\s*LEG(?:GED|S)?\b/.exec(s);
  if (word) return Number(word[1]);
  // "4L-8TOR@150C/C" — the leg count written as a bare prefix, no parentheses
  // and no word. Common on Indian tie-beam and column details. The trailing
  // boundary keeps it away from anything where L is part of a longer word.
  const prefix = /(?:^|[^A-Z0-9])(\d)\s*L(?=\s*[-–]|\s)/.exec(s);
  if (prefix) return Number(prefix[1]);
  return undefined;
}

function takeSpacing(s: string): number | undefined {
  // "@100", "@ 100 C/C", "@150c/c"
  const at = /@\s*(\d{2,4})/.exec(s);
  if (at && isSpacing(Number(at[1]))) return Number(at[1]);
  // "150 c/c", "150mm cts" — spacing written without an @
  const cc = /(\d{2,4})\s*(?:MM)?\s*(?:C\s*\/\s*C|CTS|CRS|CENTRES?|CENTERS?)\b/.exec(s);
  if (cc && isSpacing(Number(cc[1]))) return Number(cc[1]);
  return undefined;
}

interface Bars {
  diaMm?: number;
  count?: number;
  secondDiaMm?: number;
  secondCount?: number;
  /** spacing that only the diameter pattern knows about, e.g. T12-150 */
  spacingMm?: number;
}

/**
 * The diameter/count half of the grammar, tried most-specific first.
 *
 * Order is load-bearing: "10-20+14-16" must be read as a compound main before
 * the simple `n-φ` rule sees its first half, and "T12-150" must be read as
 * grade-φ-spacing before `n-φ` mistakes the 150 for a bar size.
 */
function takeBars(s: string): Bars {
  // 1. compound mains — "10-20+14-16", "REINF. 4-16 +4-12", and the same in
  //    the TOR dialect: "2-16TOR+2-12TOR". Without the optional grade word the
  //    first half matched rule 3 instead and the SECOND HALF WAS LOST — the
  //    GAMCO tie beam read as 2-16φ when it is 2-16φ plus 2-12φ, under-counting
  //    its mains by a third on every metre of the run.
  const compound =
    /(\d{1,3})\s*[-–]\s*(\d{1,2})\s*(?:TOR|TMT|CTD|HYSD|HCRM)?\s*\+\s*(\d{1,3})\s*[-–]\s*(\d{1,2})(?![\d.])/.exec(
      s,
    );
  if (compound) {
    const [c1, d1, c2, d2] = compound.slice(1).map(Number);
    if (isDia(d1) && isDia(d2) && isCount(c1) && isCount(c2)) {
      return { count: c1, diaMm: d1, secondCount: c2, secondDiaMm: d2 };
    }
  }

  // 2. grade-prefixed British form — "T12-150", "Y16@200", "H10"
  const grade = /(?:^|[^A-Z0-9])([TYHR])\s?(\d{1,2})(?![\d])/.exec(s);
  if (grade && isDia(Number(grade[2]))) {
    const out: Bars = { diaMm: Number(grade[2]) };
    const after = s.slice(grade.index + grade[0].length);
    const dash = /^\s*[-–]\s*(\d{2,4})(?![\d])/.exec(after);
    if (dash && isSpacing(Number(dash[1]))) out.spacingMm = Number(dash[1]);
    return out;
  }

  // 3. simple mains — "10-16", "3-12 ALTH.", "2-10 (EXT.)"
  const pair = /(?:^|[^\d.\-–])(\d{1,3})\s*[-–]\s*(\d{1,2})(?![\d.])/.exec(s);
  if (pair) {
    const c = Number(pair[1]);
    const d = Number(pair[2]);
    if (isDia(d) && isCount(c)) return { count: c, diaMm: d };
  }

  // 4. explicit diameter symbol — "Ø10", "12Ø", "10 DIA"
  const leading = /Ø\s*(\d{1,2})(?![\d])/.exec(s);
  const dsym = leading ?? /(?:^|[^\d.])(\d{1,2})\s*Ø/.exec(s);
  if (dsym && isDia(Number(dsym[1]))) {
    const out: Bars = { diaMm: Number(dsym[1]) };
    const nos = /(?:^|[^\d.])(\d{1,3})\s*(?:NOS?\.?)\b/.exec(s);
    if (nos && isCount(Number(nos[1]))) out.count = Number(nos[1]);
    // A COUNT WRITTEN IN FRONT OF THE DIAMETER — "20-DIA 16", "20 Ø16".
    //
    // The same shape as rule 3's "20-16" with the word DIA in the middle;
    // normalisation turns it into "20-Ø 16". Rule 3 cannot see it — what
    // follows the dash is not a digit — and this rule only looked for "NOS".
    // So "20-DIA 16 VERTICAL BARS" came back as a Ø16 bar with NO COUNT: a
    // pedestal's twenty verticals reduced to an unquantified callout, on one
    // of the commonest ways an Indian sheet writes a main-bar group.
    //
    // Only when the Ø comes BEFORE the size. In the other dialect the leading
    // number IS the diameter ("12Ø"), and reading that as a count would invent
    // twelve bars out of one bar's size.
    if (out.count === undefined && leading) {
      const before = /(?:^|[^\d.])(\d{1,3})\s*[-–\s]\s*Ø/.exec(s);
      if (before && before.index < leading.index && isCount(Number(before[1]))) {
        out.count = Number(before[1]);
      }
    }
    return out;
  }

  // 5. US bar designation — "#16"
  const hash = /#\s*(\d{1,2})(?![\d])/.exec(s);
  if (hash && isDia(Number(hash[1]))) return { diaMm: Number(hash[1]) };

  // 6. the number carrying the spacing — "8 (2L)@100 C/C", "10@100c/c",
  //    "-8 @100C/C" (what a stripped zone qualifier leaves behind), and the
  //    Indian deformed-bar dialect where the GRADE NAME sits between the size
  //    and the pitch: "10TOR@200C/C", "8TOR@200C/C(LINK)", "12TMT@100C/C".
  //
  //    TOR is how most Indian consultants still write a deformed bar, and on
  //    a sheet that uses it throughout this rule is the whole grammar. The
  //    GAMCO boundary wall lost 16 of its 34 callouts here — every link, every
  //    wall vertical and every footing bar — because "10" was not adjacent to
  //    "@". The diameter is read from the size, never from the grade word.
  const spaced =
    /(?:^|[^\d.])(\d{1,2})\s*Ø?\s*(?:TOR|TMT|CTD|HYSD|HCRM)?\s*(?:\([^)]*\)\s*)?(?:BARS?\s*)?(?:@|C\s*\/\s*C|CTS)/.exec(
      s,
    );
  if (spaced && isDia(Number(spaced[1]))) return { diaMm: Number(spaced[1]) };

  // 7. a bare stated count — "8 NOS"
  const nos = /(?:^|[^\d.])(\d{1,3})\s*(?:NOS?\.?)\b/.exec(s);
  if (nos && isCount(Number(nos[1]))) return { count: Number(nos[1]) };

  return {};
}

/**
 * Parse one callout into the pieces it actually states.
 *
 * Returns only what matched. A callout that yields nothing comes back as `{}`
 * — the caller keeps the verbatim string so the AI pass can look at what the
 * grammar could not, which is the whole reason nothing here guesses.
 *
 * All returned lengths are millimetres exactly as written on the drawing; see
 * the unit note at the top of this file.
 */
export function parseCallout(raw: string): Partial<ExtractedCallout> {
  const norm = normaliseCallout(raw);
  if (!norm) return {};

  const { zone, rest } = takeZone(norm);
  const out: Partial<ExtractedCallout> = {};
  if (zone) out.zone = zone;

  const legs = takeLegs(rest);
  if (legs !== undefined) out.legs = legs;

  const bars = takeBars(rest);
  if (bars.diaMm !== undefined) out.diaMm = bars.diaMm;
  if (bars.count !== undefined) out.count = bars.count;
  if (bars.secondDiaMm !== undefined) out.secondDiaMm = bars.secondDiaMm;
  if (bars.secondCount !== undefined) out.secondCount = bars.secondCount;

  const spacing = takeSpacing(rest) ?? bars.spacingMm;
  if (spacing !== undefined) out.spacingMm = spacing;

  return out;
}

/** true when the grammar recovered at least one fact from the string */
export function parsedAnything(p: Partial<ExtractedCallout>): boolean {
  return (
    p.diaMm !== undefined ||
    p.spacingMm !== undefined ||
    p.count !== undefined ||
    p.legs !== undefined ||
    p.secondDiaMm !== undefined
  );
}
