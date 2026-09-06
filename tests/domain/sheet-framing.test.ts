// A drawing that is open must be ON SCREEN.
//
// The bug: `groupedSheetSvg` framed the display list's RAW extents, so one
// entity left at the origin of a drawing that sits at x = 10,240,531 — the
// single most common defect in a real DXF — put the whole drawing in a corner
// of a sheet millions of units wide. Measured on the GAMCO boundary-wall
// fixture, one origin stray took a 47,328-unit drawing down to 0.4% of the
// sheet width and 40 px of sheet height: a speck on a black canvas, which
// reads as "the drawing did not load".
//
// The CAD viewer never had this problem — `cadBounds()` has trimmed strays
// since it was written. The studio's sheet render path simply never got the
// same rule. Both now read `framedBounds`.

import { describe, expect, it } from 'vitest';
import { framedBounds } from '../../src/cad/bounds';
import { groupedSheetSvg, modelMapFor } from '../../src/studio/sheetSvg';
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

/** A drawing sitting far from the origin, as a surveyed drawing does. */
function drawing(ops: DisplayOp[]): DisplayList {
  const xs: number[] = [];
  const ys: number[] = [];
  ops.forEach((op) => {
    if (op.kind === 'text') {
      xs.push(op.position.x);
      ys.push(op.position.y);
    } else {
      op.subpaths.forEach((s) => s.forEach((p) => { xs.push(p.x); ys.push(p.y); }));
    }
  });
  return {
    ops,
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/** A 40 × 30 grid of real geometry, 10 million units from the origin. */
function realDrawing(): DisplayOp[] {
  const ops: DisplayOp[] = [];
  for (let i = 0; i <= 40; i += 1) {
    ops.push(path([{ x: 10_000_000 + i * 10, y: 6_000_000 }, { x: 10_000_000 + i * 10, y: 6_000_300 }]));
  }
  for (let j = 0; j <= 30; j += 1) {
    ops.push(path([{ x: 10_000_000, y: 6_000_000 + j * 10 }, { x: 10_000_400, y: 6_000_000 + j * 10 }]));
  }
  return ops;
}

/** The px box the emitted ink actually lands in, read out of the SVG. */
function inkBox(svg: string): { w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const m of svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
    xs.push(Number(m[1]));
    ys.push(Number(m[2]));
  }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

describe('a sheet frames the drawing, not the strays around it', () => {
  it('one entity left at the origin does not shrink the drawing', () => {
    const clean = drawing(realDrawing());
    const strayed = drawing([...realDrawing(), path([{ x: 0, y: 0 }, { x: 1, y: 1 }])]);

    // The raw extents differ by four orders of magnitude...
    expect(strayed.max.x - strayed.min.x).toBeGreaterThan(10_000_000);
    expect(clean.max.x - clean.min.x).toBe(400);

    // ...and the rendered sheet does not notice.
    const a = groupedSheetSvg(clean, { width: 2200 });
    const b = groupedSheetSvg(strayed, { width: 2200 });
    expect(b.heightPx).toBe(a.heightPx);
    expect(b.scale).toBeCloseTo(a.scale, 6);

    // The drawing fills the sheet in both — it used to fill 0.4% of one.
    const inkA = inkBox(a.svg);
    const inkB = inkBox(b.svg);
    expect(inkA.w / a.widthPx).toBeGreaterThan(0.9);
    expect(inkB.w / b.widthPx).toBeGreaterThan(0.9);
  });

  it('the stray is still drawn — framing decides the camera, never what exists', () => {
    const stray = path([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const sheet = groupedSheetSvg(drawing([...realDrawing(), stray]), { width: 2200 });
    // Every op is emitted; the stray simply lands outside the viewBox, at a
    // hugely negative coordinate, which `overflow: visible` keeps painting.
    const paths = sheet.svg.match(/<path /g) ?? [];
    expect(paths).toHaveLength(73); // 41 + 31 grid lines, plus the stray
    expect(sheet.svg).toContain('overflow="visible"');
    expect(inkBox(sheet.svg).w).toBeGreaterThan(sheet.widthPx * 10);
  });

  it('a legitimately spread-out drawing keeps its own edges', () => {
    // Nothing here is a stray: the frame must not trim a real drawing.
    const spread = drawing(realDrawing());
    const frame = framedBounds(spread)!;
    expect(frame.min.x).toBe(spread.min.x);
    expect(frame.max.x).toBe(spread.max.x);
    expect(frame.min.y).toBe(spread.min.y);
    expect(frame.max.y).toBe(spread.max.y);
  });

  it('the millimetre map follows the frame, so the readout is not off by the stray', () => {
    const strayed = drawing([...realDrawing(), path([{ x: 0, y: 0 }, { x: 1, y: 1 }])]);
    const sheet = groupedSheetSvg(strayed, { width: 2200 });
    const map = modelMapFor(strayed, sheet, 1);

    // x0Mm is the model x at viewBox x = 0: the frame's left edge less the
    // margin — NOT the origin the stray dragged the extents down to.
    const mmPerPx = 1 / sheet.scale;
    expect(map.x0Mm).toBeCloseTo(10_000_000 - sheet.marginPx * mmPerPx, 3);
    expect(map.y0Mm).toBeCloseTo(6_000_000 - sheet.marginPx * mmPerPx, 3);

    // And the inverse the status bar uses lands back on the drawing's corner.
    const xAtLeft = map.x0Mm + sheet.marginPx * map.mmPerUnit;
    expect(xAtLeft).toBeCloseTo(10_000_000, 3);
  });

  it('framedBounds is null on an empty list and total on a tiny one', () => {
    expect(framedBounds({ ops: [], min: { x: 0, y: 0 }, max: { x: 0, y: 0 } })).toBeNull();
    // Too few points to take a percentile of — the extents are the answer.
    const tiny = drawing([path([{ x: 5, y: 5 }, { x: 9, y: 9 }])]);
    expect(framedBounds(tiny)).toEqual({ min: { x: 5, y: 5 }, max: { x: 9, y: 9 } });
  });
});

describe('the frame trims strays — never the drawing', () => {
  // The IQR fence assumes the middle 50% of points is representative. It is
  // not, when a drawing has one DENSE cluster and sparse content around it: a
  // schedule table or a grid of footings can put both quartiles inside a few
  // hundred millimetres, and twenty of those is still a tiny window. The frame
  // then excludes most of the drawing.
  //
  // The sheet still LOOKS fine (overflow:visible keeps painting outside the
  // viewBox) — but every mm↔viewBox conversion calibrated on that frame is
  // wrong, which is the status-bar readout and every section highlight.
  function denseClusterPlusSpread(): DisplayList {
    const ops: DisplayOp[] = [];
    // 600 points packed into 200 units — a schedule table
    for (let i = 0; i < 600; i += 1) {
      const x = 10_000 + (i % 20) * 10;
      const y = 5_000 + Math.floor(i / 20) * 6;
      ops.push(path([{ x, y }, { x: x + 2, y: y + 2 }]));
    }
    // 120 points spread over 40,000 units — the layout plan itself
    for (let i = 0; i < 120; i += 1) {
      const x = 10_000 + i * 330;
      ops.push(path([{ x, y: 4_000 }, { x, y: 9_000 }]));
    }
    return drawing(ops);
  }

  it('keeps a drawing whose middle 50% is one dense cluster', () => {
    const list = denseClusterPlusSpread();
    const frame = framedBounds(list)!;
    const rawW = list.max.x - list.min.x;
    const frameW = frame.max.x - frame.min.x;
    // The frame must still cover the drawing — not collapse onto the table.
    expect(frameW / rawW).toBeGreaterThan(0.9);
  });

  it('still drops a stray that is orders of magnitude away', () => {
    // The case the trimming exists for: the drawing sits far from the origin
    // and one entity was left behind at it. The gap is ~100% of the span.
    const far = denseClusterPlusSpread().ops.map((op) =>
      op.kind === 'path'
        ? { ...op, subpaths: op.subpaths.map((sp) => sp.map((q) => ({ x: q.x + 10_000_000, y: q.y }))) }
        : op,
    );
    const withStray = drawing([...far, path([{ x: 0, y: 0 }, { x: 1, y: 1 }])]);
    const frame = framedBounds(withStray)!;
    expect(frame.min.x).toBeGreaterThan(9_000_000);
  });
});

describe('a second plan area is not a stray', () => {
  // The real case: a foundation sheet whose main layout is ~228,000 mm wide,
  // with a second plan area 870,000 mm to the west. A rule measuring the gap
  // against the whole SPAN called that 79% and cut it, taking a third of the
  // drawing off the sheet. Measured against the CONTENT it is 3.8x — close,
  // for a drawing that is 228,000 mm across.
  function twoPlanAreas(): DisplayList {
    const ops: DisplayOp[] = [];
    // main layout: 11,239,358 .. 11,467,306
    for (let i = 0; i < 400; i += 1) {
      const x = 11_239_358 + (i / 399) * 227_948;
      ops.push(path([{ x, y: 0 }, { x, y: 100_000 }]));
    }
    // a smaller plan area to the west, sparse — under the 2% trim budget
    for (let i = 0; i < 6; i += 1) {
      const x = 10_371_701 + i * 2_000;
      ops.push(path([{ x, y: 0 }, { x, y: 50_000 }]));
    }
    return drawing(ops);
  }

  it('keeps a sparse second plan area inside the frame', () => {
    const frame = framedBounds(twoPlanAreas())!;
    expect(frame.min.x).toBeLessThan(10_400_000);
    expect(frame.max.x).toBeGreaterThan(11_460_000);
  });

  // THE CASE THAT BROKE THE DISTANCE RULE. Here the stray is 9.5x the content
  // away — nearer, in ratio, than the plan area is on other drawings — so no
  // distance threshold could drop it without also dropping real geometry
  // elsewhere. Its EXTENT gives it away: one point, two millimetres wide,
  // against a drawing 1,095,605 mm across.
  it('drops a stray that is close in ratio but has no size of its own', () => {
    const withStray = drawing([...twoPlanAreas().ops, path([{ x: 0, y: 0 }, { x: 1, y: 1 }])]);
    const frame = framedBounds(withStray)!;
    expect(frame.min.x).toBeGreaterThan(10_000_000);
    // ...and the sparse western plan area is still inside it
    expect(frame.min.x).toBeLessThan(10_400_000);
  });

  it('and a tighter drawing still cuts the same stray', () => {
    // content 228,000 wide at 11.2m: gap/content is 49x, far past FAR.
    const ops: DisplayOp[] = [];
    for (let i = 0; i < 400; i += 1) {
      const x = 11_239_358 + (i / 399) * 227_948;
      ops.push(path([{ x, y: 0 }, { x, y: 100_000 }]));
    }
    ops.push(path([{ x: 0, y: 0 }, { x: 1, y: 1 }]));
    expect(framedBounds(drawing(ops))!.min.x).toBeGreaterThan(11_000_000);
  });
});

describe('a drawing with MORE THAN ONE stray', () => {
  // THE SECOND-STRAY BUG, and it was the expensive one.
  //
  // `outlier` — "how big is the group I am about to cut" — was measured back
  // to the ORIGINAL first point rather than to the running boundary. So once
  // the first stray had been trimmed, the next candidate's span still included
  // the distance to the stray already thrown away. That is an enormous number,
  // it fails the TINY test every time, and the frame stayed pinned wherever
  // the first cut left it.
  //
  // A real sheet arrived framed at roughly two hundred times its own ink, and
  // BOTH symptoms reported came from that one number: the drawing rendered as
  // a speck, and — because `groupedSheetSvg` floors stroke widths in viewBox
  // units — its hairlines came out around five per cent of its own width,
  // slabs of colour bleeding into each other. Nothing about the stroke code
  // was wrong; it was always the frame.

  /**
   * A dense 400 × 300 drawing ten million units out.
   *
   * Dense on purpose: the trim budget is 2% of the sampled points, so a
   * fixture with 144 points can only ever cut two of them and would pass this
   * test for the wrong reason.
   */
  function denseDrawing(): DisplayOp[] {
    const ops: DisplayOp[] = [];
    for (let i = 0; i <= 100; i += 1) {
      ops.push(path([{ x: 10_000_000 + i * 4, y: 6_000_000 }, { x: 10_000_000 + i * 4, y: 6_000_300 }]));
    }
    for (let j = 0; j <= 100; j += 1) {
      ops.push(path([{ x: 10_000_000, y: 6_000_000 + j * 3 }, { x: 10_000_400, y: 6_000_000 + j * 3 }]));
    }
    return ops;
  }

  /** A speck: two adjacent points and nothing else. */
  const speck = (x: number, y: number): DisplayOp => path([{ x, y }, { x: x + 1, y: y + 1 }]);

  it('cuts a SECOND stray, not just the first', () => {
    // Two specks on the low side, at different distances. The first is cut by
    // either version; only measuring from the running boundary cuts the second.
    const list = drawing([speck(0, 0), speck(6_000_000, 3_600_000), ...denseDrawing()]);
    const f = framedBounds(list)!;
    expect(f.max.x - f.min.x).toBeCloseTo(400, 0);
    expect(f.max.y - f.min.y).toBeCloseTo(300, 0);
  });

  it('cuts strays on both sides at once', () => {
    const list = drawing([
      speck(0, 0),
      speck(6_000_000, 3_600_000),
      ...denseDrawing(),
      speck(14_000_000, 8_400_000),
      speck(20_000_000, 12_000_000),
    ]);
    const f = framedBounds(list)!;
    expect(f.max.x - f.min.x).toBeCloseTo(400, 0);
    expect(f.max.y - f.min.y).toBeCloseTo(300, 0);
  });

  it('so the ink FILLS the sheet instead of being a speck in it', () => {
    // The symptom, measured where it was seen: the emitted ink against the
    // viewBox it was emitted into.
    const list = drawing([speck(0, 0), speck(6_000_000, 3_600_000), ...denseDrawing()]);
    const sheet = groupedSheetSvg(list, { width: 2000 });
    expect(inkBox(sheet.svg).w / sheet.widthPx).toBeGreaterThan(0.9);
  });

  it('so a hairline is a hairline, not a slab', () => {
    const list = drawing([speck(0, 0), speck(6_000_000, 3_600_000), ...denseDrawing()]);
    const sheet = groupedSheetSvg(list, { width: 2000 });
    const widths = [...sheet.svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThan(inkBox(sheet.svg).w * 0.01);
  });

  it('still refuses to cut a second REAL area', () => {
    // The correction must not become a licence to trim. A detached plan area
    // is thousands of units wide and is not a stray however far off it sits —
    // cutting it would frame half the sheet and silently hide the rest.
    const second = denseDrawing().map((op) =>
      op.kind === 'path'
        ? { ...op, subpaths: op.subpaths.map((sp) => sp.map((q) => ({ x: q.x + 3_000_000, y: q.y }))) }
        : op,
    );
    const list = drawing([speck(0, 0), ...denseDrawing(), ...second]);
    const f = framedBounds(list)!;
    expect(f.min.x).toBeGreaterThan(1_000_000); // the speck went
    expect(f.max.x - f.min.x).toBeGreaterThan(3_000_000); // both areas stayed
  });
});
