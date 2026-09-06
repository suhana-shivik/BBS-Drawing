// EVERY read section, drawn on the drawing, immediately.
//
// The highlights are emitted INSIDE the sheet's own SVG, through the same
// `X()`/`Y()` closures as the CAD geometry. That is the whole design: a
// separate overlay has to reconstruct the drawing's mapping, and twice a
// reconstruction was wrong — once the transform was never applied to the
// overlay, once the sheet frame was miscalculated — while the arithmetic
// looked right both times and the marks were nowhere near the drawing.
//
// Rendering into the same coordinate space removes the failure mode instead of
// testing for it: a highlight is placed by the function that places the ink.

import { describe, expect, it } from 'vitest';
import { groupedSheetSvg, type SheetHighlight } from '../../src/studio/sheetSvg';
import type { DisplayList, DisplayOp, Vec2 } from '../../src/cad/types';

function path(points: Vec2[]): DisplayOp {
  return {
    kind: 'path',
    subpaths: [points],
    closed: false,
    stroke: '#fff',
    fill: null,
    lineweight: 0,
    dash: [],
    alpha: 1,
    handle: 'h',
    layer: 'CONC',
  };
}

/** A 1,000 × 1,000 unit drawing at the origin — easy arithmetic to check. */
function square(): DisplayList {
  const ops: DisplayOp[] = [];
  for (let i = 0; i <= 20; i += 1) {
    ops.push(path([{ x: i * 50, y: 0 }, { x: i * 50, y: 1000 }]));
    ops.push(path([{ x: 0, y: i * 50 }, { x: 1000, y: i * 50 }]));
  }
  return { ops, min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } };
}

const mark = (id: string, b: SheetHighlight['bounds'], kind: 'read' | 'gap' = 'read') =>
  ({ id, label: `${id} label`, bounds: b, kind }) as SheetHighlight;

/** Pull the outline rects back out of the emitted SVG. */
function marksIn(svg: string) {
  return [
    ...svg.matchAll(
      /<g class="(mark[^"]*)" data-section="([^"]+)"[^>]*><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
    ),
  ].map((m) => ({
    cls: m[1],
    id: m[2],
    x: +m[3],
    y: +m[4],
    w: +m[5],
    h: +m[6],
  }));
}

describe('read sections are drawn into the sheet SVG', () => {
  it('emits one highlight per section — all of them, with nothing hovered', () => {
    const highlights = [
      mark('REGION-01', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 }),
      mark('REGION-02', { xMin: 500, yMin: 500, xMax: 1000, yMax: 1000 }),
      mark('REGION-03', { xMin: 250, yMin: 250, xMax: 750, yMax: 750 }),
      mark('REGION-04', { xMin: 0, yMin: 500, xMax: 500, yMax: 1000 }),
      mark('REGION-05', { xMin: 500, yMin: 0, xMax: 1000, yMax: 500 }),
    ];
    const sheet = groupedSheetSvg(square(), { width: 2200, highlights, mmPerUnit: 1 });
    const marks = marksIn(sheet.svg);

    // 5 sections in, 5 highlights out. No hover, no selection, no filtering.
    expect(marks).toHaveLength(5);
    expect(marks.map((m) => m.id)).toEqual([
      'REGION-01',
      'REGION-02',
      'REGION-03',
      'REGION-04',
      'REGION-05',
    ]);
  });

  it('places them at the same coordinates the geometry is drawn at', () => {
    // The drawing is 1,000 units across into 2200px less a 20px margin either
    // side, so scale = 2160/1000 = 2.16 px per unit and X(0) = 20.
    const sheet = groupedSheetSvg(square(), {
      width: 2200,
      highlights: [mark('R', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 })],
      mmPerUnit: 1,
    });
    const [m] = marksIn(sheet.svg);
    expect(m.x).toBeCloseTo(20, 1); // X(0) = margin
    expect(m.w).toBeCloseTo(1080, 1); // 500 units x 2.16
    expect(m.h).toBeCloseTo(1080, 1);
    // y is up in model space: the box's TOP is yMax = 500, which is the
    // vertical middle of a 1,000-unit drawing.
    expect(m.y).toBeCloseTo(20 + 1080, 1);
  });

  it('converts millimetre bounds through the drawing unit scale exactly once', () => {
    // Same drawing, but each drawing unit is 10 mm. A section 5,000 mm wide is
    // 500 units — the same box as above, and it must land in the same place.
    const sheet = groupedSheetSvg(square(), {
      width: 2200,
      highlights: [mark('R', { xMin: 0, yMin: 0, xMax: 5000, yMax: 5000 })],
      mmPerUnit: 10,
    });
    const [m] = marksIn(sheet.svg);
    expect(m.x).toBeCloseTo(20, 1);
    expect(m.w).toBeCloseTo(1080, 1);
  });

  it('keeps a section that falls outside the sheet rather than dropping it', () => {
    const sheet = groupedSheetSvg(square(), {
      width: 2200,
      highlights: [
        mark('IN', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 }),
        mark('OUT', { xMin: 3000, yMin: 0, xMax: 3500, yMax: 500 }),
      ],
      mmPerUnit: 1,
    });
    const marks = marksIn(sheet.svg);
    expect(marks.map((m) => m.id)).toEqual(['IN', 'OUT']);
    // Off the right of the sheet, at its true coordinates — the svg is
    // overflow:visible, so it paints where it belongs and can be panned to.
    expect(marks[1].x).toBeGreaterThan(sheet.widthPx);
  });

  it('fills read sections in ONE group, and never fills a gap', () => {
    const sheet = groupedSheetSvg(square(), {
      width: 2200,
      highlights: [
        mark('REGION-01', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 }),
        mark('REGION-02', { xMin: 250, yMin: 250, xMax: 750, yMax: 750 }),
        mark('GAP-01', { xMin: 800, yMin: 800, xMax: 900, yMax: 900 }, 'gap'),
      ],
      mmPerUnit: 1,
    });
    // Two read fills in one composited group; the gap contributes none.
    const fills = /<g class="mark-fills"[^>]*>(.*?)<\/g>/s.exec(sheet.svg)![1];
    expect(fills.match(/<rect/g)).toHaveLength(2);
    expect(fills).not.toContain('GAP-01');

    // …and all three still get an outline, the gap marked as one.
    const marks = marksIn(sheet.svg);
    expect(marks).toHaveLength(3);
    expect(marks.find((m) => m.id === 'GAP-01')!.cls).toBe('mark gap');
    expect(marks.find((m) => m.id === 'REGION-01')!.cls).toBe('mark');
  });

  it('emits nothing at all when no section has been read', () => {
    const sheet = groupedSheetSvg(square(), { width: 2200 });
    expect(sheet.svg).not.toContain('sheet-marks');
    expect(marksIn(sheet.svg)).toHaveLength(0);
  });

  it('labels every mark with its id, so the drawing names what was read', () => {
    const sheet = groupedSheetSvg(square(), {
      width: 2200,
      highlights: [mark('REGION-07', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 })],
      mmPerUnit: 1,
    });
    expect(sheet.svg).toContain('REGION-07 · REGION-07 label');
  });
});

describe('a highlight is visible without any stylesheet', () => {
  // This overlay has failed silently three times, and each time the DOM was
  // right and the picture was blank. A selector that does not match looks
  // exactly like a mark that was never emitted, so the colours are presentation
  // attributes: the highlight is visible from the moment the string is in the
  // document, with no CSS in the path. The stylesheet still owns hover and the
  // strip's toggle — it is just no longer load-bearing for "can you see it".
  const svgFor = (kind: 'read' | 'gap') =>
    groupedSheetSvg(square(), {
      width: 2200,
      highlights: [mark('R', { xMin: 0, yMin: 0, xMax: 500, yMax: 500 }, kind)],
      mmPerUnit: 1,
    }).svg;

  it('carries the sky-blue fill and border inline', () => {
    const svg = svgFor('read');
    expect(svg).toContain('class="mark-fills" data-testid="mark-fills" opacity="0.3"');
    expect(svg).toContain('fill="#0ea5e9"');
    expect(svg).toContain('stroke="#38bdf8"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('vector-effect="non-scaling-stroke"');
  });

  it('carries the amber dashed outline inline for a gap, and no fill', () => {
    const svg = svgFor('gap');
    expect(svg).toContain('stroke="#fb923c"');
    expect(svg).toContain('stroke-dasharray="6 4"');
    // a gap is never washed in the colour that means "read"
    expect(svg).not.toContain('mark-fills');
    expect(svg).not.toContain('fill="#0ea5e9"');
  });
});
