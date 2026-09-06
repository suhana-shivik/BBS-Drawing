// MTEXT inline formatting.
//
// Case matters here. `\P` is a paragraph break, while `\p...;` sets paragraph
// properties and carries parameters. Treating them as one code strands the
// parameters as visible text — e.g. "xi1.5,a0.66667,sm1.07917;Warehouse
// Storage" printed across the drawing.

/** placeholder for an escaped backslash while the other codes are stripped */
const ESC = '';

/** Strip MTEXT inline formatting, keeping the text and its line breaks. */
export function cleanMText(s: string): string {
  return s
    .replace(/\\\\/g, ESC)
    .replace(/\\~/g, ' ')
    // stacked fractions: \S1^2;  \S1#2;  →  "1/2"
    .replace(/\\S([^;]*);/g, (_m, body: string) => body.replace(/[\^#]/g, '/'))
    // parameterised runs terminated by ';':
    //   \p paragraph properties, \f \F font, \H height, \W width,
    //   \C \c colour, \T tracking, \Q oblique, \A alignment
    .replace(/\\[pfFHWCcTQA][^;\\]*;/g, '')
    // paragraph break — uppercase only
    .replace(/\\P/g, '\n')
    // parameterless toggles: underline, overline, strike
    .replace(/\\[LlOoKk]/g, '')
    // grouping braces carry no content
    .replace(/[{}]/g, '')
    .split(ESC)
    .join('\\');
}
