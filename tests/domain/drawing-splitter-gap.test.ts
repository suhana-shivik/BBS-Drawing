// ============================================================
// connectedEntitiesInBounds — a box can be geometrically correct and
// semantically wrong.
//
// THE BUG THIS FILE EXISTS TO PREVENT
//
// A live browser split of the real GAMCO sheet produced a section labelled
// "C/S OF TB-(350X400)" whose box ran from a tie-beam cross-section straight
// through 1.7 m of blank sheet into the caption of a NEIGHBOURING column
// detail ("C/S OF F.G.L TO +300 LVL." — that text belongs to the SC/C1
// column details, not TB). The user's own words: "look at this cut, it makes
// no sense at all." A screenshot showed a section that was half diagram, half
// dead white space.
//
// `boundsForHandles` did exactly what §1 asks: it measured faithfully from
// the handles it was given. The bug was upstream — the model's handle list
// mixed a detail's own callouts with one caption from a different detail.
// The box that comes out of measuring the WRONG handles faithfully is still
// wrong. Coverage checking (do the sections between them account for every
// entity?) would NOT have caught this — nothing was missing, two things were
// merged. This needed a check on what ends up INSIDE one box, not across all
// of them.
//
// THE FIX, validated empirically against the real drawing before being
// written (see the numbered investigation this file's own git history
// records): project the box's own selected entities onto each axis, exclude
// sheet-scaffolding first (a title-block border on the NAMEPLATE layer, 47 m
// wide, was the single entity that made every early version of this check
// useless — it bridges any gap on the sheet), and if the largest resulting
// gap exceeds 20% of that axis's extent, drop the minority side and retighten
// — never growing past what was already selected.
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import {
  boundsFromCorners,
  connectedEntitiesInBounds,
  entitiesInBounds,
} from '../../src/cad/understanding/bounds';
import { exportSection } from '../../src/cad/understanding/section';
import { line, makeDoc, polyline, resetHandles, text } from '../helpers/cadDoc';
import type { CadDocument } from '../../src/cad/types';

// ------------------------------------------------------------
// synthetic mechanics — fast, exact, no drawing needed
// ------------------------------------------------------------

/** a small dense cluster of entities around a centre, spanning `spread` mm */
function cluster(cx: number, cy: number, spread: number, prefix: string): ReturnType<typeof line>[] {
  return [
    line({ x: cx - spread / 2, y: cy }, { x: cx + spread / 2, y: cy }, 'STEEL', `${prefix}1`),
    text({ x: cx - spread / 3, y: cy + 20 }, `${prefix} mark`, 8, 'TEXT', `${prefix}2`),
    text({ x: cx + spread / 3, y: cy - 20 }, `${prefix} note`, 8, 'TEXT', `${prefix}3`),
  ];
}

describe('connectedEntitiesInBounds — synthetic mechanics', () => {
  it('leaves a single coherent cluster untouched', () => {
    resetHandles();
    const doc = makeDoc({ entities: cluster(0, 0, 300, 'A') });
    const box = boundsFromCorners(-500, -500, 500, 500);
    const result = connectedEntitiesInBounds(doc, box);
    expect(result.entities).toHaveLength(3);
    expect(result.bounds).toEqual(box); // untightened — nothing was dropped
    expect(result.limitations.some((l) => l.code === 'disjoint-cluster-dropped')).toBe(false);
  });

  it('drops a distant minority cluster and tightens to the majority', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        ...cluster(0, 0, 300, 'MAJ'),
        // a lone stray entity 6 metres away — a stray caption from a
        // neighbouring detail, exactly the GAMCO failure mode
        text({ x: 6000, y: 0 }, 'STRAY CAPTION', 8, 'TEXT', 'STRAY1'),
      ],
    });
    const box = boundsFromCorners(-1000, -1000, 7000, 1000);
    const result = connectedEntitiesInBounds(doc, box);

    expect(result.handles).not.toContain('STRAY1');
    expect(result.entities).toHaveLength(3); // the MAJ cluster, intact
    expect(result.bounds.xMax).toBeLessThan(1000); // tightened away from the stray
    const limit = result.limitations.find((l) => l.code === 'disjoint-cluster-dropped');
    expect(limit).toBeTruthy();
    expect(limit!.count).toBe(1);
    expect(limit!.message).toContain('STRAY CAPTION');
  });

  it('never grows the box past what was already selected', () => {
    // a long text label near the boundary can estimate a wide bounding box;
    // even so, retightening must never reach past the ORIGINAL query box
    resetHandles();
    const doc = makeDoc({
      entities: [
        ...cluster(0, 0, 300, 'A'),
        // a very long caption sitting just inside the box edge — its
        // ESTIMATED text width may want to extend past the box
        text({ x: 900, y: 0 }, 'A VERY LONG CAPTION THAT WOULD ESTIMATE WIDE', 40, 'TEXT', 'LONGTXT'),
        text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1'),
      ],
    });
    const box = boundsFromCorners(-1000, -1000, 1000, 1000);
    const result = connectedEntitiesInBounds(doc, box);
    expect(result.bounds.xMax).toBeLessThanOrEqual(box.xMax);
    expect(result.bounds.xMin).toBeGreaterThanOrEqual(box.xMin);
    expect(result.bounds.yMax).toBeLessThanOrEqual(box.yMax);
    expect(result.bounds.yMin).toBeGreaterThanOrEqual(box.yMin);
  });

  it('does not fire on a uniformly-spaced band — periodic gaps are not one big gap', () => {
    // a 20 m "layout band": columns every 2 m, exactly the shape of a real
    // repeating layout strip. No single gap should dominate.
    resetHandles();
    const entities = [];
    for (let i = 0; i < 10; i++) {
      const x = i * 2000;
      entities.push(line({ x, y: 0 }, { x, y: 300 }, 'STEEL', `COL${i}A`));
      entities.push(text({ x: x + 50, y: 350 }, `C${i}`, 10, 'TEXT', `COL${i}B`));
    }
    const doc = makeDoc({ entities });
    const box = boundsFromCorners(-200, -200, 18200, 600);
    const result = connectedEntitiesInBounds(doc, box);
    expect(result.entities).toHaveLength(20);
    expect(result.limitations.some((l) => l.code === 'disjoint-cluster-dropped')).toBe(false);
  });

  it('is not fooled by a sheet-spanning background entity bridging the gap', () => {
    // this is the EXACT real-world defeat: a huge frame/border polyline
    // spans both clusters and would bridge any naive gap-projection check.
    // The selection is deliberately realistic in SIZE, not just in shape —
    // every real GAMCO section that contained a background entity had at
    // least 18 items; excludeOutlierSized only trusts its own statistics
    // once there is enough content to have statistics at all (see
    // MIN_ITEMS_FOR_BACKGROUND_FILTER's own comment, and the dedicated test
    // below for what happens BELOW that floor).
    resetHandles();
    const richCluster = [
      ...cluster(0, 0, 300, 'A'),
      ...cluster(0, 300, 300, 'B'),
      ...cluster(300, 0, 300, 'C'),
      ...cluster(300, 300, 300, 'D'),
    ];
    const entities = [
      ...richCluster,
      text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1'),
      // a 50 m "title block border" spanning the whole selection
      polyline(
        [{ x: -20000, y: -5000 }, { x: 30000, y: -5000 }, { x: 30000, y: 5000 }, { x: -20000, y: 5000 }],
        true,
        'NAMEPLATE',
        'BORDER1',
      ),
    ];
    const doc = makeDoc({ entities });
    const box = boundsFromCorners(-1000, -1000, 7000, 1000);
    const result = connectedEntitiesInBounds(doc, box);
    // the border entity itself may or may not survive re-selection depending
    // on the tightened box, but the STRAY caption must be gone
    expect(result.handles).not.toContain('STRAY1');
    expect(result.bounds.xMax).toBeLessThan(1000);
  });

  it('KNOWN TRADE-OFF: a background entity in a very sparse selection is not filtered', () => {
    // Below MIN_ITEMS_FOR_BACKGROUND_FILTER there is not enough content to
    // tell "the one big legitimate thing here" apart from "scaffolding" —
    // both look identical: one item, much bigger than a couple of others.
    // Excluding it anyway (as an earlier version did, using a sample median)
    // reliably threw away genuine content instead: a single ordinary LINE
    // in a 4-item cluster got misread as a border on nothing more than
    // being the biggest of four things. This test documents the accepted
    // consequence — a real border entity in an ARTIFICIALLY sparse
    // selection can still bridge a gap — rather than leaving it as a silent
    // surprise. It has never been observed on the real drawing: every
    // GAMCO section that actually contained a background entity had 18+ items.
    resetHandles();
    const entities = [
      ...cluster(0, 0, 300, 'A'), // just 3 items — below the floor
      text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1'),
      polyline(
        [{ x: -20000, y: -5000 }, { x: 30000, y: -5000 }, { x: 30000, y: 5000 }, { x: -20000, y: 5000 }],
        true,
        'NAMEPLATE',
        'BORDER1',
      ),
    ];
    const doc = makeDoc({ entities });
    const box = boundsFromCorners(-1000, -1000, 7000, 1000);
    const result = connectedEntitiesInBounds(doc, box);
    // the border bridges the gap in this ultra-sparse case, so the check
    // cannot fire — documented, not silently swallowed
    expect(result.handles).toContain('STRAY1');
    expect(result.limitations.some((l) => l.code === 'disjoint-cluster-dropped')).toBe(false);
  });

  it('requires at least three items — cannot tell "empty" from "sparse"', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'A1'),
        text({ x: 5000, y: 0 }, 'FAR', 8, 'TEXT', 'A2'),
      ],
    });
    const box = boundsFromCorners(-100, -100, 5500, 100);
    const result = connectedEntitiesInBounds(doc, box);
    expect(result.entities).toHaveLength(2); // both kept — too few to judge
    expect(result.limitations.some((l) => l.code === 'disjoint-cluster-dropped')).toBe(false);
  });

  it('converges within the iteration cap when several strays exist', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        ...cluster(0, 0, 300, 'A'),
        text({ x: 6000, y: 0 }, 'STRAY LEFT', 8, 'TEXT', 'S1'),
        text({ x: -6000, y: 0 }, 'STRAY RIGHT', 8, 'TEXT', 'S2'),
      ],
    });
    const box = boundsFromCorners(-7000, -1000, 7000, 1000);
    const result = connectedEntitiesInBounds(doc, box);
    expect(result.handles).not.toContain('S1');
    expect(result.handles).not.toContain('S2');
    expect(result.entities).toHaveLength(3); // just cluster A survives
  });

  it('the dropped handles are still traceable in the limitation message', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [...cluster(0, 0, 300, 'A'), text({ x: 6000, y: 0 }, 'SC CAPTION TEXT', 8, 'TEXT', 'STRAY1')],
    });
    const box = boundsFromCorners(-1000, -1000, 7000, 1000);
    const result = connectedEntitiesInBounds(doc, box);
    const limit = result.limitations.find((l) => l.code === 'disjoint-cluster-dropped')!;
    expect(limit.message).toContain('SC CAPTION TEXT');
    expect(limit.message).toMatch(/tightened/i);
  });
});

// ------------------------------------------------------------
// exportSection integration — §8's invariant must survive the tightening
// ------------------------------------------------------------

describe('exportSection keeps PNG, DXF and bounds in agreement after tightening', () => {
  it('the returned bounds are the TIGHTENED box, not the requested one', async () => {
    resetHandles();
    const doc = makeDoc({
      entities: [...cluster(0, 0, 300, 'A'), text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1')],
    });
    const requested = boundsFromCorners(-1000, -1000, 7000, 1000);
    const section = await exportSection(
      doc,
      requested,
      { sectionId: 'REGION-01', label: 'A detail', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      { skipPng: true },
    );
    expect(section.bounds).not.toEqual(requested);
    expect(section.bounds.xMax).toBeLessThan(requested.xMax);
    expect(section.entityIds).not.toContain('STRAY1');
    expect(section.limitations.some((l) => l.code === 'disjoint-cluster-dropped')).toBe(true);
  });

  it('the DXF and the returned bounds describe the SAME region', async () => {
    resetHandles();
    const doc = makeDoc({
      entities: [...cluster(0, 0, 300, 'A'), text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1')],
    });
    const requested = boundsFromCorners(-1000, -1000, 7000, 1000);
    const section = await exportSection(
      doc,
      requested,
      { sectionId: 'REGION-01', label: 'A detail', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      { skipPng: true },
    );
    // re-selecting from the STORED bounds must reproduce exactly what was written
    const recut = entitiesInBounds(doc, section.bounds);
    expect(recut.handles.sort()).toEqual(section.entityIds.sort());
  });

  it('the renderer is called with the tightened box, not the original', async () => {
    resetHandles();
    const doc = makeDoc({
      entities: [...cluster(0, 0, 300, 'A'), text({ x: 6000, y: 0 }, 'STRAY', 8, 'TEXT', 'STRAY1')],
    });
    const requested = boundsFromCorners(-1000, -1000, 7000, 1000);
    const seen: { xMax: number }[] = [];
    await exportSection(
      doc,
      requested,
      { sectionId: 'REGION-01', label: 'A detail', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      { renderer: async (_d, bounds) => { seen.push({ xMax: bounds.xMax }); return 'data:image/png;base64,AAAA'; } },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].xMax).toBeLessThan(requested.xMax);
  });
});

// ------------------------------------------------------------
// the real GAMCO drawing — the exact bug, and a false-positive sweep
// ------------------------------------------------------------

const FILE = 'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf';
const DXF = join(process.cwd(), 'drawing example/BBS/BBS', FILE);
const PACKAGE = join(process.cwd(), 'split-output/gamco-live/drawing-understanding.json');
const haveDxf = existsSync(DXF);
const havePackage = existsSync(PACKAGE);

describe.skipIf(!haveDxf)('the real bug this file was written to fix', () => {
  let doc: CadDocument;
  beforeAll(() => {
    doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
  });

  // The exact box the browser produced (read from the section viewer's own
  // "Bounds" footer on the offending cut) — mixing the TB cross-section with
  // "C/S OF F.G.L TO +300 LVL.", a caption belonging to the SC/C1 details.
  const badBox = boundsFromCorners(10258751, -6274161, 10264122, -6269100);

  it('removes the stray column-detail caption from the tie-beam cut', () => {
    const before = entitiesInBounds(doc, badBox);
    expect(before.handles).toContain('79895'); // "C/S OF F.G.L TO +300 LVL." — confirms the fixture reproduces the bug

    const after = connectedEntitiesInBounds(doc, badBox);
    expect(after.handles).not.toContain('79895');
    const limit = after.limitations.find((l) => l.code === 'disjoint-cluster-dropped');
    expect(limit).toBeTruthy();
  });

  it('shrinks the box materially — the blank sheet is gone from the cut', () => {
    const after = connectedEntitiesInBounds(doc, badBox);
    const beforeHeight = badBox.yMax - badBox.yMin;
    const afterHeight = after.bounds.yMax - after.bounds.yMin;
    expect(afterHeight).toBeLessThan(beforeHeight * 0.85);
  });

  it('never grows past the box the model actually asked for', () => {
    const after = connectedEntitiesInBounds(doc, badBox);
    expect(after.bounds.xMin).toBeGreaterThanOrEqual(badBox.xMin);
    expect(after.bounds.xMax).toBeLessThanOrEqual(badBox.xMax);
    expect(after.bounds.yMin).toBeGreaterThanOrEqual(badBox.yMin);
    expect(after.bounds.yMax).toBeLessThanOrEqual(badBox.yMax);
  });

  it('what remains still parses back as a valid, non-empty DXF', async () => {
    const section = await exportSection(
      doc,
      badBox,
      { sectionId: 'REGION-07', label: 'C/S OF TB-(350X400)', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 0.5 },
      { skipPng: true },
    );
    expect(section.entityCount).toBeGreaterThan(0);
    const reparsed = parseDXF(section.dxf, 'x.dxf');
    expect(reparsed.entities.length).toBe(section.entityCount);
  });
});

describe.skipIf(!haveDxf || !havePackage)(
  'false-positive sweep — the threshold does not fire on real, correctly-cut sections',
  () => {
    // §8's fix must not turn into a NEW bug: it must leave a genuinely
    // single-subject section alone, including a 25 m layout band (the widest,
    // most gap-prone shape on this sheet) and the tallest narrow section.
    // This is the exact empirical basis the 20% threshold was chosen from —
    // if it ever regresses, this is where it will be caught.
    let doc: CadDocument;
    let sections: { sectionId: string; label: string; bounds: { xMin: number; yMin: number; xMax: number; yMax: number } }[];
    beforeAll(() => {
      doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
      sections = JSON.parse(readFileSync(PACKAGE, 'utf8')).sections;
    });

    it('flags no section from a clean, independently-produced run', () => {
      expect(sections.length).toBeGreaterThan(10); // sanity: the fixture package is real
      const flagged: string[] = [];
      for (const s of sections) {
        const result = connectedEntitiesInBounds(doc, s.bounds);
        if (result.limitations.some((l) => l.code === 'disjoint-cluster-dropped')) {
          flagged.push(`${s.sectionId} (${s.label})`);
        }
      }
      expect(flagged, `unexpected false positive(s): ${flagged.join(', ')}`).toEqual([]);
    });

    it('does not shrink any of them either — bounds are unchanged', () => {
      for (const s of sections) {
        const result = connectedEntitiesInBounds(doc, s.bounds);
        expect(result.bounds, `${s.sectionId} bounds changed unexpectedly`).toEqual({
          xMin: s.bounds.xMin, yMin: s.bounds.yMin, xMax: s.bounds.xMax, yMax: s.bounds.yMax,
        });
      }
    });
  },
);
