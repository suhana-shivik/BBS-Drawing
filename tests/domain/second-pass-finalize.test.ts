// ONE OWNER PER ENTITY, AND GEOMETRY DECIDES CONNECTIVITY.
//
// Two failures made this file necessary, and both were silent — everything
// still rendered, just wrong:
//
//   A 3,063-entity drawing reported 4,783. Sections overlap (the first pass
//   cuts boxes, not a partition), so the same entity was counted by every
//   region that covered it. Any coverage figure built on that is fiction.
//
//   A residual reported itself as joining all seven regions of a sheet. Its
//   bounding BOX overlapped them; not one of its entities did. And a reading
//   of "independent" was being displayed over geometry that plainly overlapped
//   a region — the model answering a question it was never asked.
//
// So the contract here is arithmetic, not taste:
//
//   the four ownership states sum to the total entity count
//   duplicate ownerships === 0
//   connectivity comes from ENTITY boxes, and no reading can overturn it
import { describe, expect, it } from 'vitest';
import type { CadDocument, CadEntity } from '../../src/cad/types';
import {
  connectivityOf,
  entityIdOf,
  finalizationReport,
  finalizeSecondPass,
  outcomeFor,
  type Relationship,
} from '../../src/cad/understanding/finalize';
import type { ResidualResult } from '../../src/cad/understanding/residual';
import type { DrawingSection, SectionBounds } from '../../src/cad/understanding/types';

// --- fixtures ---------------------------------------------------------------

const box = (xMin: number, yMin: number, xMax: number, yMax: number): SectionBounds => ({
  xMin,
  yMin,
  xMax,
  yMax,
});

/** A 10 × 10 line at (x, y) carrying the given handle. */
function ent(handle: string, x: number, y: number): CadEntity {
  return {
    type: 'line',
    a: { x, y },
    b: { x: x + 10, y: y + 10 },
    style: {
      layer: 'COLS',
      color: { kind: 'aci', index: 7 },
      lineweight: -1,
      linetype: 'CONTINUOUS',
      linetypeScale: 1,
      transparency: 0,
      normal: null,
      handle,
    },
  } as CadEntity;
}

const docOf = (entities: CadEntity[], extent = 4000): CadDocument =>
  ({
    id: 'd',
    name: 'd',
    sourceFile: 'd.dxf',
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities,
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: { min: { x: 0, y: 0 }, max: { x: extent, y: extent } },
  }) as unknown as CadDocument;

function section(sectionId: string, b: SectionBounds): DrawingSection {
  return {
    sectionId,
    label: `${sectionId} label`,
    kind: 'detail',
    sourceDrawing: 'd.dxf',
    sourceDrawingHash: 'h',
    bounds: b,
    png: '',
    dxf: '',
    // Left empty on purpose. Ownership is derived from the DRAWING, never from
    // the splitter's own lists — those over-claim, which is the bug.
    entityIds: [],
    evidenceIds: [],
    memberHints: [],
    calloutHints: [],
    orchestratorStep: 1,
    confidence: 0.9,
    entityCount: 0,
    limitations: [],
  };
}

const reading = (over: Partial<NonNullable<ResidualResult['reading']>> = {}) => ({
  kind: 'callout',
  summary: 'a reinforcement note',
  callouts: [],
  belongsTo: null,
  relation: 'annotation' as const,
  basis: 'text',
  confidence: 0.9,
  ...over,
});

function residual(over: Partial<ResidualResult> & { gapId: string }): ResidualResult {
  return {
    bounds: box(0, 0, 10, 10),
    entityCount: 3,
    entityTypes: [],
    layers: [],
    text: ['C1'],
    entityIds: [],
    geometry: { overlaps: [], touches: [], near: [] },
    link: 'independent',
    linkedTo: null,
    reading: reading(),
    status: 'read',
    ...over,
  } as ResidualResult;
}

// ---------------------------------------------------------------------------

describe('every entity has exactly one owner', () => {
  it('does not count an entity once per region that covers it', () => {
    // THE 3,063 → 4,783 BUG, in miniature. Three regions all cover the same
    // three entities; the drawing still has three of them.
    const doc = docOf([ent('a', 100, 100), ent('b', 110, 110), ent('c', 120, 120)]);
    const f = finalizeSecondPass(
      doc,
      [
        section('REGION-01', box(0, 0, 500, 500)),
        section('REGION-02', box(50, 50, 600, 600)),
        section('REGION-03', box(90, 90, 700, 700)),
      ],
      [],
    );
    expect(f.regions.reduce((n, r) => n + r.entityIds.length, 0)).toBe(3);
    expect(f.accounting.totalEntities).toBe(3);
    expect(f.accounting.initialRegionUnique).toBe(3);
    // deterministic: each went to the FIRST region that covers it
    expect([...f.regions[0].entityIds].sort()).toEqual(['a', 'b', 'c']);
    expect(f.regions[1].entityIds).toEqual([]);
  });

  it('the four states sum to the drawing, and nothing is owned twice', () => {
    const doc = docOf([
      ent('in', 100, 100), // cut by REGION-01
      ent('att', 520, 100), // a residual attached to REGION-01
      ent('own', 3000, 3000), // a residual that earns its own region
      ent('tiny', 3500, 100), // read, too small to need one
      ent('lost', 100, 3500), // never read
    ]);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(520, 100, 530, 110),
          entityIds: ['att'],
          reading: reading({ relation: 'annotation' }),
        }),
        residual({
          gapId: 'GAP-02',
          bounds: box(3000, 3000, 3010, 3010),
          entityIds: ['own'],
          text: ['COLUMN LAYOUT PLAN'],
          reading: reading({ kind: 'layout', relation: 'independent' }),
        }),
        residual({
          gapId: 'GAP-03',
          bounds: box(3500, 100, 3510, 110),
          entityIds: ['tiny'],
          text: [],
          entityCount: 1,
          reading: reading({ relation: 'independent' }),
        }),
        residual({
          gapId: 'GAP-04',
          bounds: box(100, 3500, 110, 3510),
          entityIds: ['lost'],
          status: 'failed',
          reading: null,
          note: '429',
        }),
      ],
    );
    const a = f.accounting;
    expect(a.totalEntities).toBe(5);
    expect(
      a.initialRegionUnique + a.secondPassUnique + a.explainedResidualUnique + a.stillUnreadUnique,
    ).toBe(a.totalEntities);
    expect(a.duplicateEntityOwnerships).toBe(0);
    expect(a.pass).toBe(true);

    expect(f.ownership.get('in')).toEqual({ state: 'INITIAL_REGION', owner: 'REGION-01' });
    expect(f.ownership.get('att')).toEqual({ state: 'SECOND_PASS_REGION', owner: 'REGION-01' });
    expect(f.ownership.get('own')!.state).toBe('SECOND_PASS_REGION');
    expect(f.ownership.get('tiny')).toEqual({ state: 'EXPLAINED_RESIDUAL', owner: 'GAP-03' });
    expect(f.ownership.get('lost')).toEqual({ state: 'STILL_UNREAD', owner: 'GAP-04' });
  });

  it('gives a handle-less entity an id of its own instead of losing it', () => {
    // Otherwise every handle-less entity collides on the empty string and the
    // map silently keeps one of them.
    const blank = ent('', 100, 100);
    expect(entityIdOf(blank, 0)).toBe('#0');
    const f = finalizeSecondPass(
      docOf([blank, ent('', 200, 200)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [],
    );
    expect(f.accounting.totalEntities).toBe(2);
    expect(f.accounting.initialRegionUnique).toBe(2);
    expect(f.accounting.pass).toBe(true);
  });

  it('reports a duplicate id rather than silently overwriting it', () => {
    // Two entities on one handle means the id is not stable, and every count
    // built on it is suspect. Say so instead of averaging over it.
    const f = finalizeSecondPass(
      docOf([ent('same', 100, 100), ent('same', 200, 200)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [],
    );
    expect(f.conflicts).toEqual(['same']);
    expect(f.accounting.duplicateEntityOwnerships).toBe(1);
    expect(f.accounting.pass).toBe(false);
  });
});

describe('connectivity is geometry, and the model cannot overturn it', () => {
  const regions = [
    { sectionId: 'REGION-01', bounds: box(0, 0, 100, 100) },
    { sectionId: 'REGION-02', bounds: box(3000, 3000, 3100, 3100) },
  ];
  const SHEET = box(0, 0, 4000, 4000);

  it('measures from ENTITY boxes, not from the cluster bounding box', () => {
    // A residual with one entity beside REGION-01 and one out in the middle
    // has a BOX spanning half the sheet. That box overlaps things none of its
    // entities go near — which is how a residual came to report itself as
    // joining all seven regions of a drawing.
    const perEntity = connectivityOf(
      [box(105, 0, 115, 10), box(2000, 2000, 2010, 2010)],
      regions,
      SHEET,
    );
    expect(perEntity.relationship).toBe('CONNECTED');
    expect(perEntity.connectedRegions).toEqual(['REGION-01']);

    // the same residual judged by one box claims both
    expect(connectivityOf([box(105, 0, 3010, 3010)], regions, SHEET).connectedRegions).toEqual([
      'REGION-01',
      'REGION-02',
    ]);
  });

  it('separates CONNECTED, NEAR_CONNECTED and INDEPENDENT', () => {
    expect(connectivityOf([box(105, 0, 115, 10)], regions, SHEET).relationship).toBe('CONNECTED');
    expect(connectivityOf([box(400, 0, 410, 10)], regions, SHEET).relationship).toBe(
      'NEAR_CONNECTED',
    );
    expect(connectivityOf([box(1500, 1500, 1510, 1510)], regions, SHEET).relationship).toBe(
      'INDEPENDENT',
    );
  });

  it('refuses a reading of "independent" over geometry that says CONNECTED', () => {
    // THE CONTRADICTION THE PANEL WAS SHOWING. An overlap is not a matter of
    // opinion, and the model was not asked about it.
    const o = outcomeFor(
      residual({ gapId: 'GAP-01', reading: reading({ relation: 'annotation' }) }),
      'CONNECTED',
      ['REGION-01'],
      5,
    );
    expect(o.relationship).toBe('CONNECTED');
    expect(o.action).toBe('attach');
    expect(o.regionId).toBe('REGION-01');
  });

  it('lets the reading choose only among the regions it actually touches', () => {
    const touching = ['REGION-01', 'REGION-02'];
    expect(
      outcomeFor(residual({ gapId: 'G', linkedTo: 'REGION-02' }), 'CONNECTED', touching, 3).regionId,
    ).toBe('REGION-02');
    // naming one it does not touch does not move it there
    expect(
      outcomeFor(residual({ gapId: 'G', linkedTo: 'REGION-09' }), 'CONNECTED', touching, 3).regionId,
    ).toBe('REGION-01');
  });

  it('carries the authoritative relationship through for the UI to read', () => {
    for (const rel of ['CONNECTED', 'NEAR_CONNECTED', 'INDEPENDENT'] as Relationship[]) {
      const o = outcomeFor(residual({ gapId: 'G' }), rel, rel === 'INDEPENDENT' ? [] : ['R'], 1);
      expect(o.relationship).toBe(rel);
    }
  });
});

describe('a successful read is not a new region', () => {
  it('attaches connected content and creates nothing', () => {
    const f = finalizeSecondPass(
      docOf([ent('r', 100, 100), ent('g', 520, 100)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(520, 100, 530, 110),
          entityIds: ['g'],
          reading: reading({ relation: 'part-of' }),
        }),
      ],
    );
    expect(f.regions).toHaveLength(1);
    expect(f.regions[0].source).toBe('initial + residual-second-pass');
    expect(f.regions[0].status).toBe('attached');
    expect(f.regions[0].attached).toEqual(['GAP-01']);
    expect(f.unresolved).toEqual([]);
    // grown around the entity it took, and only that entity
    expect(f.regions[0].bounds.xMax).toBeGreaterThanOrEqual(530);
  });

  it('creates a region for genuinely independent, meaningful content', () => {
    const f = finalizeSecondPass(
      docOf([ent('r', 100, 100), ent('g', 3000, 3000)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(3000, 3000, 3010, 3010),
          entityIds: ['g'],
          text: ['COLUMN LAYOUT PLAN'],
          reading: reading({ kind: 'layout', relation: 'independent' }),
        }),
      ],
    );
    const fresh = f.regions.filter((r) => r.source === 'residual-second-pass');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].sectionId).toBe('REGION-02'); // numbered on from the first pass
    expect(fresh[0].status).toBe('read');
    expect(fresh[0].entityIds).toEqual(['g']);
  });

  it('explains a fragment: no region, and no warning either', () => {
    const f = finalizeSecondPass(
      docOf([ent('r', 100, 100), ent('g', 3000, 3000)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(3000, 3000, 3010, 3010),
          entityIds: ['g'],
          text: [],
          entityCount: 1,
          reading: reading({ relation: 'independent' }),
        }),
      ],
    );
    expect(f.regions).toHaveLength(1);
    expect(f.unresolved).toEqual([]);
    expect(f.outcomes[0].action).toBe('explained');
  });

  it('keeps an unread or failed piece orange', () => {
    const f = finalizeSecondPass(
      docOf([ent('g', 3000, 3000)]),
      [],
      [residual({ gapId: 'GAP-01', entityIds: ['g'], status: 'failed', reading: null, note: '429' })],
    );
    expect(f.unresolved.map((r) => r.gapId)).toEqual(['GAP-01']);
    expect(f.outcomes[0].secondPass).toBe('FAILED');
  });
});

describe('one box per area', () => {
  const SAME = box(200, 2620, 1560, 3400);

  it('folds identical-bounds regions into the first of them', () => {
    const f = finalizeSecondPass(
      docOf([ent('a', 300, 2700)]),
      [
        section('REGION-01', SAME),
        section('REGION-02', box(0, 0, 50, 50)),
        section('REGION-05', SAME),
      ],
      [],
    );
    expect(f.regions.map((r) => r.sectionId)).toEqual(['REGION-01', 'REGION-02']);
    expect(f.regions[0].mergedFrom).toEqual(['REGION-05']);
  });

  it('redirects an attachment that named one of the copies', () => {
    const f = finalizeSecondPass(
      docOf([ent('a', 300, 2700), ent('g', 1600, 2700)]),
      [section('REGION-01', SAME), section('REGION-05', SAME)],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(1600, 2700, 1610, 2710),
          entityIds: ['g'],
          linkedTo: 'REGION-05',
          reading: reading({ relation: 'annotation' }),
        }),
      ],
    );
    expect(f.regions).toHaveLength(1);
    expect(f.regions[0].sectionId).toBe('REGION-01');
    expect(f.regions[0].attached).toEqual(['GAP-01']);
    expect(f.accounting.pass).toBe(true);
  });
});

describe('the acceptance report', () => {
  it('prints the totals in the form asked for', () => {
    const f = finalizeSecondPass(
      docOf([ent('in', 100, 100), ent('g', 3000, 3000)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(3000, 3000, 3010, 3010),
          entityIds: ['g'],
          text: ['COLUMN LAYOUT PLAN'],
          reading: reading({ kind: 'layout', relation: 'independent' }),
        }),
      ],
    );
    const out = finalizationReport(f).join('\n');
    expect(out).toContain('TOTAL ENTITIES: 2');
    expect(out).toContain('INITIAL REGION UNIQUE: 1');
    expect(out).toContain('SECOND PASS UNIQUE: 1');
    expect(out).toContain('EXPLAINED RESIDUAL UNIQUE: 0');
    expect(out).toContain('STILL UNREAD UNIQUE: 0');
    expect(out).toContain('DUPLICATE ENTITY OWNERSHIPS: 0');
    expect(out).toContain('ACCOUNTING CHECK: PASS');
  });

  it('prints every GAP with its relationship and final status', () => {
    const f = finalizeSecondPass(
      docOf([ent('in', 100, 100), ent('g', 520, 100)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(520, 100, 530, 110),
          entityIds: ['g'],
          reading: reading({ relation: 'part-of' }),
        }),
      ],
    );
    const out = finalizationReport(f).join('\n');
    expect(out).toContain('relationship: CONNECTED');
    expect(out).toContain('connectedRegions: REGION-01');
    expect(out).toContain('uniqueEntities: 1');
    expect(out).toContain('secondPass: READ');
    expect(out).toContain('finalStatus: ATTACHED → REGION-01');
  });
});

describe('a package written by an older build still loads', () => {
  // PACKAGES OUTLIVE THE CODE THAT WROTE THEM. They live in IndexedDB keyed by
  // the drawing's hash, so one saved by an earlier build is loaded by a later
  // one as a matter of course. A residual with no `entityIds` crashed the
  // studio on boot, with no way for the user past it.
  const legacy = (over: Record<string, unknown> = {}): ResidualResult =>
    ({
      gapId: 'GAP-01',
      bounds: box(520, 100, 530, 110),
      entityCount: 3,
      entityTypes: [],
      layers: [],
      text: ['C1'],
      geometry: { overlaps: [], touches: ['REGION-01'], near: [] },
      link: 'connected',
      linkedTo: 'REGION-01',
      reading: reading({ relation: 'annotation' }),
      status: 'read',
      ...over,
    }) as unknown as ResidualResult;

  it('does not throw, and still attaches', () => {
    const f = finalizeSecondPass(
      docOf([ent('in', 100, 100)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [legacy()],
    );
    // no entity ids to place, so connectivity falls back to its own box
    expect(f.outcomes[0].relationship).toBe('CONNECTED');
    expect(f.outcomes[0].action).toBe('attach');
    expect(f.accounting.pass).toBe(true);
  });

  it('survives missing text and a missing entity count', () => {
    const f = finalizeSecondPass(
      docOf([ent('in', 100, 100)]),
      [section('REGION-01', box(0, 0, 500, 500))],
      [legacy({ text: undefined, entityCount: undefined, bounds: box(3000, 3000, 3010, 3010) })],
    );
    expect(f.outcomes[0].action).toBe('explained');
    expect(f.accounting.pass).toBe(true);
  });
});

describe('a highlight is not an ownership list', () => {
  // THE FULL-SHEET BLUE WASH.
  //
  // GAP-01 on the foundations sheet is 82 entities scattered across the whole
  // drawing. Attaching them to a region and unioning every one of them in made
  // that region's box the sheet: a translucent blue rectangle over the entire
  // drawing, with the actual read areas invisible underneath it.
  //
  // Unioning the residual's bounding box did it, and so does unioning its
  // entities one at a time — the entities ARE the sheet. A region can own an
  // entity without its blue box having to reach that entity, and keeping those
  // two separate is what stops one from wrecking the other.
  const SHEET = 4000;

  /** A region in the corner, and a residual sprayed across the drawing. */
  function scattered() {
    const scatter = Array.from({ length: 12 }, (_, i) =>
      ent(`s${i}`, 100 + i * 300, 100 + i * 300),
    );
    return {
      doc: docOf([ent('r', 100, 100), ...scatter], SHEET),
      residual: residual({
        gapId: 'GAP-01',
        // the cluster box IS the sheet, which is the trap
        bounds: box(100, 100, 3400, 3400),
        entityIds: scatter.map((e) => e.style.handle),
        text: ['S LINE'],
        reading: reading({ relation: 'annotation' }),
      }),
    };
  }

  it('does not stretch a region across the sheet to reach what it owns', () => {
    const { doc, residual: r } = scattered();
    const f = finalizeSecondPass(doc, [section('REGION-01', box(0, 0, 500, 500))], [r]);
    const region = f.regions[0];
    const w = region.bounds.xMax - region.bounds.xMin;
    const h = region.bounds.yMax - region.bounds.yMin;
    // it may grow a little, around the entities that actually abut it
    expect((w * h) / (SHEET * SHEET)).toBeLessThan(0.25);
  });

  it('still owns every one of them, and the books still balance', () => {
    // The fix is to the HIGHLIGHT, not to ownership: nothing is disowned to
    // make the rectangle smaller.
    const { doc, residual: r } = scattered();
    const f = finalizeSecondPass(doc, [section('REGION-01', box(0, 0, 500, 500))], [r]);
    expect(f.accounting.totalEntities).toBe(13);
    expect(f.accounting.pass).toBe(true);
    expect(f.accounting.stillUnreadUnique).toBe(0);
    expect(f.regions[0].entityIds).toHaveLength(13);
  });

  it('still grows around a leftover that genuinely abuts the region', () => {
    // The cap must not become "never grow". A callout just outside the box its
    // detail was cut to is exactly what attachment is for.
    const doc = docOf([ent('r', 100, 100), ent('g', 505, 100)], SHEET);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(505, 100, 515, 110),
          entityIds: ['g'],
          reading: reading({ relation: 'annotation' }),
        }),
      ],
    );
    expect(f.regions[0].bounds.xMax).toBeGreaterThanOrEqual(515);
  });

  it('leaves a region nothing attached to exactly as the splitter cut it', () => {
    const doc = docOf([ent('r', 100, 100)], SHEET);
    const f = finalizeSecondPass(doc, [section('REGION-01', box(0, 0, 500, 500))], []);
    expect(f.regions[0].bounds).toEqual(box(0, 0, 500, 500));
  });
});

describe('a new region is framed by what it owns, not by its cluster', () => {
  // THE SAME WASH BY A DIFFERENT DOOR. A region promoted from a residual
  // started life with the residual's CLUSTER box — and a cluster's box is not
  // the cluster. Two ways that box is wrong:
  //
  //   entities inside it may belong to a first-pass region (they had
  //   priority), so the box covers ground this region does not own;
  //   and a scattered leftover's box is simply the sheet.
  const SHEET = 4000;

  it('excludes ground the first pass had already taken', () => {
    // The cluster spans from inside REGION-01 out to the far corner. Only the
    // far entity ends up owned by the new region, so only it should be framed.
    const doc = docOf([ent('mine', 100, 100), ent('far', 3000, 3000)], SHEET);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(100, 100, 3010, 3010), // the cluster box, spanning both
          entityIds: ['mine', 'far'],
          text: ['COLUMN LAYOUT PLAN'],
          reading: reading({ kind: 'layout', relation: 'independent' }),
        }),
      ],
    );
    const fresh = f.regions.find((r) => r.source === 'residual-second-pass')!;
    // 'mine' was already cut by REGION-01 and keeps that owner
    expect(f.ownership.get('mine')!.owner).toBe('REGION-01');
    expect(fresh.entityIds).toEqual(['far']);
    // so the new region is framed on 'far' alone, not on the cluster
    expect(fresh.bounds.xMin).toBeGreaterThanOrEqual(3000);
    expect((fresh.bounds.xMax - fresh.bounds.xMin) / SHEET).toBeLessThan(0.1);
  });

  it('keeps the books balanced while doing it', () => {
    const doc = docOf([ent('mine', 100, 100), ent('far', 3000, 3000)], SHEET);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-01', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(100, 100, 3010, 3010),
          entityIds: ['mine', 'far'],
          text: ['COLUMN LAYOUT PLAN'],
          reading: reading({ kind: 'layout', relation: 'independent' }),
        }),
      ],
    );
    expect(f.accounting.totalEntities).toBe(2);
    expect(f.accounting.initialRegionUnique).toBe(1);
    expect(f.accounting.secondPassUnique).toBe(1);
    expect(f.accounting.pass).toBe(true);
  });
});

describe('owned geometry is always drawn somewhere', () => {
  // THE FOUR COLUMN MARKS. A layout plan carries four C1 marks; two fell
  // inside first-pass regions and two arrived as residuals, were read, and
  // were attached — to regions eight hundred millimetres away.
  //
  // Ownership was right and the accounting balanced, and both of those marks
  // were invisible: the growth cap refused to stretch their region to reach
  // them (correctly — that is what washed a whole sheet blue) and nothing
  // else drew them. On screen, read-and-owned looked identical to never-seen.
  //
  // A region can own geometry its box does not reach. What it may not do is
  // own geometry that nothing draws.
  const SHEET = 4000;

  /** A region in the corner and a mark far away that gets attached to it. */
  function farAttachment() {
    return {
      doc: docOf([ent('r', 100, 100), ent('far', 800, 100)], SHEET),
      residual: residual({
        gapId: 'GAP-01',
        bounds: box(800, 100, 810, 110),
        entityIds: ['far'],
        reading: reading({ relation: 'part-of' }),
      }),
    };
  }

  it('gives owned-but-distant geometry its own box', () => {
    const { doc, residual: r } = farAttachment();
    const f = finalizeSecondPass(doc, [section('REGION-03', box(0, 0, 500, 500))], [r]);
    const region = f.regions[0];

    // it is owned …
    expect(f.ownership.get('far')).toEqual({ state: 'SECOND_PASS_REGION', owner: 'REGION-03' });
    expect(region.entityIds).toContain('far');
    // … the region did NOT stretch to reach it …
    expect(region.bounds).toEqual(box(0, 0, 500, 500));
    // … and it is drawn where it actually is.
    expect(region.detached).toHaveLength(1);
    expect(region.detached[0].gapId).toBe('GAP-01');
    expect(region.detached[0].bounds.xMin).toBeGreaterThanOrEqual(800);
  });

  it('draws ONE box per residual, not one per entity', () => {
    // The four lines and the label of a column mark are one thing on the
    // drawing, and four boxes stacked on one mark is four labels over it.
    const marks = ['a', 'b', 'c', 'd'].map((h, i) => ent(h, 800 + i, 100 + i));
    const doc = docOf([ent('r', 100, 100), ...marks], SHEET);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-03', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(800, 100, 820, 120),
          entityIds: ['a', 'b', 'c', 'd'],
          reading: reading({ relation: 'part-of' }),
        }),
      ],
    );
    expect(f.regions[0].detached).toHaveLength(1);
    // and that one box covers all four
    const b = f.regions[0].detached[0].bounds;
    expect(b.xMin).toBeLessThanOrEqual(800);
    expect(b.xMax).toBeGreaterThanOrEqual(813);
  });

  it('adds nothing for a leftover that ABUTS its region', () => {
    // That one grew the box, which is the right answer for it — a second
    // outline beside the first would be drawing the same thing twice.
    const doc = docOf([ent('r', 100, 100), ent('near', 505, 100)], SHEET);
    const f = finalizeSecondPass(
      doc,
      [section('REGION-03', box(0, 0, 500, 500))],
      [
        residual({
          gapId: 'GAP-01',
          bounds: box(505, 100, 515, 110),
          entityIds: ['near'],
          reading: reading({ relation: 'annotation' }),
        }),
      ],
    );
    expect(f.regions[0].detached).toEqual([]);
    expect(f.regions[0].bounds.xMax).toBeGreaterThanOrEqual(515);
  });

  it('leaves the accounting exactly as it was', () => {
    // This is a DRAWING fix. Ownership, counts and the balance are untouched.
    const { doc, residual: r } = farAttachment();
    const f = finalizeSecondPass(doc, [section('REGION-03', box(0, 0, 500, 500))], [r]);
    expect(f.accounting.totalEntities).toBe(2);
    expect(f.accounting.initialRegionUnique).toBe(1);
    expect(f.accounting.secondPassUnique).toBe(1);
    expect(f.accounting.stillUnreadUnique).toBe(0);
    expect(f.accounting.pass).toBe(true);
  });

  it('every entity a region owns is inside one of its boxes', () => {
    // The invariant the hole broke. Stated once, so it cannot come back.
    const { doc, residual: r } = farAttachment();
    const f = finalizeSecondPass(doc, [section('REGION-03', box(0, 0, 500, 500))], [r]);
    const boxes = [f.regions[0].bounds, ...f.regions[0].detached.map((d) => d.bounds)];
    for (const id of f.regions[0].entityIds) {
      const e = doc.entities.find((x, i) => (x.style.handle || `#${i}`) === id)!;
      if (e.type !== 'line') continue;
      const b: SectionBounds = { xMin: e.a.x, yMin: e.a.y, xMax: e.b.x, yMax: e.b.y };
      expect(boxes.some((box2) => boundsOverlap(box2, b))).toBe(true);
    }
  });
});

/** local, so the test does not depend on the module under test for its own maths */
function boundsOverlap(a: SectionBounds, b: SectionBounds): boolean {
  return a.xMin <= b.xMax && a.xMax >= b.xMin && a.yMin <= b.yMax && a.yMax >= b.yMin;
}
