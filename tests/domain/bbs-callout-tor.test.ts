// The TOR dialect — how most Indian consultants write a deformed bar.
//
// "10TOR@200C/C" puts the GRADE NAME between the size and the pitch. The
// spacing rule in `takeBars` required the diameter to sit immediately before
// the "@", so every callout written this way came back with no diameter at
// all — and a bar whose diameter never parsed cannot be scheduled, weighed or
// ordered.
//
// On the GAMCO boundary wall sheet that was 16 of 34 callouts: every link,
// every wall vertical, every footing bar and every tie-beam stirrup. The panel
// reported "18 of 34 callouts read" and no schedule could be built from what
// survived. The dialect is documented in the project's own BBS skill; the
// grammar simply did not implement it.
import { describe, expect, it } from 'vitest';
import { parseCallout } from '../../src/cad/bbs/callout';

describe('the TOR / TMT deformed-bar dialect', () => {
  it('reads the diameter through the grade name', () => {
    expect(parseCallout('10TOR@200C/C')).toMatchObject({ diaMm: 10, spacingMm: 200 });
    expect(parseCallout('12TOR@100C/C')).toMatchObject({ diaMm: 12, spacingMm: 100 });
    expect(parseCallout('8TOR@200C/C(LINK)')).toMatchObject({ diaMm: 8, spacingMm: 200 });
  });

  it('handles the other grade names the same way', () => {
    expect(parseCallout('16TMT@150C/C')).toMatchObject({ diaMm: 16, spacingMm: 150 });
    expect(parseCallout('12CTD@200C/C')).toMatchObject({ diaMm: 12, spacingMm: 200 });
    expect(parseCallout('10HYSD@250C/C')).toMatchObject({ diaMm: 10, spacingMm: 250 });
  });

  it('reads a bare leg-count prefix — "4L-8TOR@150C/C"', () => {
    expect(parseCallout('4L-8TOR@150C/C')).toMatchObject({
      diaMm: 8,
      spacingMm: 150,
      legs: 4,
    });
    expect(parseCallout('2L-8TOR@200C/C')).toMatchObject({ diaMm: 8, legs: 2 });
  });

  it('leaves the forms that already worked alone', () => {
    expect(parseCallout('T8@200C/C')).toMatchObject({ diaMm: 8, spacingMm: 200 });
    expect(parseCallout('8-12TOR')).toMatchObject({ count: 8, diaMm: 12 });
    expect(parseCallout('2-16TOR+2-12TOR')).toMatchObject({
      count: 2,
      diaMm: 16,
      secondCount: 2,
      secondDiaMm: 12,
    });
    expect(parseCallout('8 (2L)@100 C/C')).toMatchObject({ diaMm: 8, legs: 2, spacingMm: 100 });
  });

  it('still refuses a size that is not a rolled bar', () => {
    // the whole point of the diameter whitelist: a section tag is not steel
    expect(parseCallout('11TOR@200C/C').diaMm).toBeUndefined();
    expect(parseCallout('SECTION 1-1').diaMm).toBeUndefined();
  });
});
