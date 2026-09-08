// R3 — sections as files, from the committed gamco split package: the
// Sections/ folder projection (§3.2), the drawing's split status + coverage
// honesty report on Details (§3.1/§3.4) and the section detail panel (§3.3).

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { StudioShell } from '../../src/components/StudioShell';
import {
  StudioDataContext,
  type SectionDetailData,
  type SheetSectionsInfo,
  type StudioData,
  type StudioSheet,
} from '../../src/studio/data';
import {
  coverageLineFor,
  hasUnexplainedGap,
  residualFor,
  sectionsFolderFor,
  sectionsFolderMeta,
  sectionSheetId,
} from '../../src/studio/sections';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding';
import type { GapClusterData } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

afterEach(cleanup);

const FIXTURE = join(process.cwd(), 'fixtures/understanding/gamco-package.json');
const pkg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DrawingUnderstandingPackage;

const MODEL = { widthUnits: 800, heightUnits: 600, mmPerUnit: 10, x0Mm: 0, y0Mm: 0 };

function sheetOf(partial: Partial<StudioSheet> & { id: string }): StudioSheet {
  return {
    tab: partial.id,
    title: partial.id,
    number: partial.id,
    rev: 'R0',
    discipline: 'Structural',
    entities: 100,
    grounded: false,
    issues: 0,
    hasModel: false,
    panels: [],
    model: MODEL,
    svg: '<svg></svg>',
    ...partial,
  } as StudioSheet;
}

function buildData(): {
  data: StudioData;
  runSplit: ReturnType<typeof vi.fn>;
  readResiduals: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
} {
  const docId = pkg.documentId;
  const first = pkg.sections[0];
  const detail: SectionDetailData = {
    sectionId: first.sectionId,
    label: first.label,
    kind: first.kind,
    memberHints: [{ mark: 'TB', basis: 'visible label in region' }],
    calloutHints: ['8 (2L)@150 C/C'],
    bounds: { ...first.bounds },
    widthMm: first.bounds.xMax - first.bounds.xMin,
    heightMm: first.bounds.yMax - first.bounds.yMin,
    entityCount: first.entityCount ?? 0,
    evidenceIds: [],
    confidence: first.confidence ?? 0,
    limitations: (first.limitations ?? []).map((l) => ({
      code: l.code,
      message: l.message,
      count: l.count,
    })),
    orchestratorStep: 3,
    parentSheetId: 'sh1',
    parentName: pkg.sourceDrawing,
  };

  const info: SheetSectionsInfo = {
    status: 'split',
    statusLine: `read — ${pkg.sections.length} sections`,
    costLine: '3 model calls · $0.0042 · 84s',
    error: null,
    progressTail: [],
    count: pkg.sections.length,
    coverageLine: coverageLineFor(pkg.coverage),
    residual: residualFor(pkg),
    unexplainedGap: hasUnexplainedGap(pkg),
    gaps: [],
    logicalSections: [],
    sections: pkg.sections.map((s) => ({
      sheetId: sectionSheetId(docId, s.sectionId),
      sectionId: s.sectionId,
      label: s.label,
      kind: s.kind,
      entityCount: s.entityCount ?? 0,
      bounds: { ...s.bounds },
      renderable: s.entityCount ?? 0,
      hidden: 0,
    })),
  };

  const runSplit = vi.fn();
  const readResiduals = vi.fn();
  const validate = vi.fn();
  const data: StudioData = {
    projectName: 'GAMCO Boundary Wall',
    groups: [
      {
        id: 'g-drawings',
        name: 'Drawings',
        folders: [
          {
            kind: 'folder',
            id: 'f-disc-structural',
            name: 'Structural',
            children: [
              {
                kind: 'file',
                id: 'drw-1',
                name: 'GAMCO-STR-001 boundary wall',
                rev: 'R0',
                current: true,
                state: 'ok',
                sheetId: 'sh1',
                discipline: 'Structural',
              },
              sectionsFolderFor(pkg, 'GAMCO-STR-001 boundary wall'),
            ],
          },
        ],
      },
    ],
    sheets: {
      sh1: sheetOf({ id: 'sh1', documentId: docId }),
      sec1: sheetOf({ id: 'sec1', documentId: docId, section: detail }),
    },
    scheduleRows: [],
    scheduleVersion: '—',
    split: {
      blocked: null,
      run: runSplit,
      runAll: vi.fn(),
      pendingAll: 0,
      readResiduals: readResiduals,
      validate: validate,
    },
    sectionsByDoc: { [docId]: info },
  };
  return { data, runSplit, readResiduals, validate };
}

function mount(data: StudioData, prepare?: (store: StudioStore) => void) {
  const store = new StudioStore();
  store.openProject('proj-gamco');
  prepare?.(store);
  render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <StudioShell />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  return store;
}

describe('Sections/ folder (§3.2)', () => {
  it('projects the package into a folder whose meta carries the coverage', () => {
    const folder = sectionsFolderFor(pkg, 'GAMCO-STR-001 boundary wall');
    // `section-<drawing>` — named with its parent drawing because two section
    // folders from different drawings sort next to each other (folders lead)
    // and must stay tellable apart (`compareNodes` in src/studio/browse.ts).
    expect(folder.name).toBe('section-GAMCO-STR-001 boundary wall');
    expect(folder.children).toHaveLength(pkg.sections.length);
    expect(sectionsFolderMeta(pkg)).toBe('12 items · 99.3% covered');
    const first = folder.children[0];
    expect(first.kind).toBe('file');
    if (first.kind === 'file') {
      expect(first.name).toContain(pkg.sections[0].sectionId);
      expect(first.meta).toContain('entities');
    }
  });

  it('shows the folder in the register with one child per section', async () => {
    const { data } = buildData();
    mount(data);
    const tree = screen.getByRole('tree', { name: 'Register tree' });
    expect(within(tree).getByText('section-GAMCO-STR-001 boundary wall')).toBeTruthy();
    expect(screen.getByTestId(`count-f-sections-${pkg.documentId}`).textContent).toBe('12');
  });
});

describe('split status + coverage on the drawing Details (§3.1/§3.4)', () => {
  it('states the split, its honest cost and the coverage with residual layers explained', async () => {
    const { data } = buildData();
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('sections-block'));
    expect(screen.getByTestId('split-status').textContent).toContain('read — 12 sections');
    expect(screen.getByText('3 model calls · $0.0042 · 84s')).toBeTruthy();
    const coverage = screen.getByTestId('coverage-block');
    expect(coverage.textContent).toContain('99.3% of 1,335 entities');
    // the gamco residual: ASHADE, named by the splitter's own accounting
    expect(coverage.textContent).toContain('ASHADE');
    expect(coverage.textContent).toContain('explained, not lost');
    expect(screen.queryByTestId('coverage-gap')).toBeNull();
  });

  it('lists every section as a row: REGION-NN label [kind] entities', async () => {
    const { data } = buildData();
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const list = screen.getByTestId('section-list');
    const rows = list.querySelectorAll('.section-pick');
    expect(rows).toHaveLength(pkg.sections.length);
    expect(rows[0].textContent).toContain(pkg.sections[0].sectionId);
    expect(rows[0].textContent).toContain(`[${pkg.sections[0].kind}]`);
  });

  it('a row picks the section out on the drawing; a separate control opens it', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const list = screen.getByTestId('section-list');
    const first = pkg.sections[0].sectionId;

    // CLICKING THE ROW SINGLES IT OUT — it does not navigate away. Finding a
    // section on the drawing you are looking at and opening it as its own
    // sheet are different acts, and one click cannot mean both.
    fireEvent.click(list.querySelectorAll('.section-pick')[0]);
    expect(store.getState().view.pinnedSections).toEqual([first]);
    expect(store.getState().sheets.active).toBe('sh1');

    // the way back to every read area, which is what shows the coverage
    fireEvent.click(screen.getByTestId('show-all-sections'));
    expect(store.getState().view.pinnedSections).toBeNull();

    // clicking the same row twice also shows them all again
    fireEvent.click(list.querySelectorAll('.section-pick')[0]);
    fireEvent.click(list.querySelectorAll('.section-pick')[0]);
    expect(store.getState().view.pinnedSections).toBeNull();

    // and opening it as a sheet is its own control
    fireEvent.click(list.querySelectorAll('.section-open')[0]);
    expect(store.getState().sheets.active).toBe(sectionSheetId(pkg.documentId, first));
  });

  it('while the model has the sheet it shows a loader, not a dead button', async () => {
    const { data } = buildData();
    const docId = pkg.documentId;
    const reading: StudioData = {
      ...data,
      sectionsByDoc: {
        [docId]: {
          ...data.sectionsByDoc![docId],
          status: 'splitting',
          statusLine: 'reading the drawing…',
          count: null,
          coverageLine: null,
          sections: [],
        },
      },
    };
    mount(reading, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('sections-block'));
    expect(screen.getByTestId('reading-loader').textContent).toContain('Reading drawing…');
    // Nothing to press while it reads, and nothing called "split" to press later.
    expect(screen.queryByRole('button', { name: /split/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Read/ })).toBeNull();
  });

  it('Read again runs the explicit split action for this document', async () => {
    const { data, runSplit } = buildData();
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('sections-block'));
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    expect(runSplit).toHaveBeenCalledWith(pkg.documentId);
  });
});

describe('section detail panel (§3.3)', () => {
  it('shows label verbatim, kind as a hint, members with how-it-knows, size, confidence and limitations', async () => {
    const { data } = buildData();
    mount(data, (s) => s.openSheet('sec1'));
    await waitFor(() => screen.getByTestId('section-detail'));
    const panel = screen.getByTestId('section-detail');
    expect(panel.textContent).toContain(pkg.sections[0].label);
    expect(panel.textContent).toContain('a hint, never an assignment');
    expect(panel.textContent).toContain('TB');
    expect(panel.textContent).toContain('visible label in region');
    expect(panel.textContent).toContain('8 (2L)@150 C/C');
    expect(panel.textContent).toContain('Entities');
    expect(panel.textContent).toContain('orchestrator step 3');
    // §3.3 — limitations are SHOWN, not hidden
    const limitations = screen.getByTestId('section-limitations');
    expect(limitations.textContent).toContain(pkg.sections[0].limitations![0].code);
  });

  it('"Show on the sheet" opens the parent zoomed to the section bounds', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sec1'));
    await waitFor(() => screen.getByTestId('show-on-sheet'));
    fireEvent.click(screen.getByTestId('show-on-sheet'));
    // the parent sheet is now active; the focus request carried the mm bounds
    expect(store.getState().sheets.active).toBe('sh1');
  });
});

describe('clicking a section takes you to it', () => {
  it('pins it AND frames the drawing on its bounds', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    // The Viewport CONSUMES a focus request (it frames, then clears it), so
    // the call is what there is to observe — not a leftover in the state.
    const framed = vi.spyOn(store, 'focusOn');
    const list = screen.getByTestId('section-list');

    fireEvent.click(list.querySelectorAll('.section-pick')[0]);
    // Outlining alone is not enough: fitted to a pane, a section of a 47 m
    // sheet can be fifteen pixels across. The camera has to go there.
    expect(framed).toHaveBeenCalledWith('sh1', pkg.sections[0].bounds);
    expect(store.getState().view.pinnedSections).toEqual([pkg.sections[0].sectionId]);
  });

  it('un-picking shows everything again without moving the camera', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const list = screen.getByTestId('section-list');

    fireEvent.click(list.querySelectorAll('.section-pick')[0]);
    const framed = vi.spyOn(store, 'focusOn');
    fireEvent.click(list.querySelectorAll('.section-pick')[0]); // the same row
    expect(store.getState().view.pinnedSections).toBeNull();
    expect(framed).not.toHaveBeenCalled();
  });
});

describe('several read areas at once', () => {
  // "Ye jo section region read hue h" — the question that needs more than one
  // is "did the splitter cut the SAME table twice?". REGION-01, -05 and -07
  // carry identical bounds on the columns drawing, and you cannot see that by
  // looking at them one after another: the comparison IS the answer, so the
  // areas have to be lit together.
  const boxes = (store: StudioStore) => store.getState().view.pinnedSections;

  it('ticks several areas and keeps the earlier ones lit', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const checks = screen
      .getByTestId('section-list')
      .querySelectorAll<HTMLInputElement>('.section-check');
    expect(checks.length).toBeGreaterThan(1);

    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    // BOTH, in the order they were chosen — the second does not replace the
    // first, which is the whole difference from clicking the row.
    expect(boxes(store)).toEqual([pkg.sections[0].sectionId, pkg.sections[1].sectionId]);
    expect(checks[0].checked).toBe(true);
    expect(checks[1].checked).toBe(true);
  });

  it('unticks one without disturbing the rest', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const checks = screen
      .getByTestId('section-list')
      .querySelectorAll<HTMLInputElement>('.section-check');

    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    fireEvent.click(checks[0]);
    expect(boxes(store)).toEqual([pkg.sections[1].sectionId]);
  });

  it('frames the union of what is ticked, not whichever was ticked last', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const checks = screen
      .getByTestId('section-list')
      .querySelectorAll<HTMLInputElement>('.section-check');

    fireEvent.click(checks[0]);
    const framed = vi.spyOn(store, 'focusOn');
    fireEvent.click(checks[1]);

    // Choosing a second area is asking to see it BESIDE the first. Jumping the
    // camera onto the newest one would put the comparison off screen.
    const a = pkg.sections[0].bounds;
    const b = pkg.sections[1].bounds;
    expect(framed).toHaveBeenCalledWith('sh1', {
      xMin: Math.min(a.xMin, b.xMin),
      yMin: Math.min(a.yMin, b.yMin),
      xMax: Math.max(a.xMax, b.xMax),
      yMax: Math.max(a.yMax, b.yMax),
    });
  });

  it('leaves the framing alone when the last tick comes off', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const checks = screen
      .getByTestId('section-list')
      .querySelectorAll<HTMLInputElement>('.section-check');

    fireEvent.click(checks[0]);
    const framed = vi.spyOn(store, 'focusOn');
    fireEvent.click(checks[0]);
    // Nothing is chosen, so there is nothing to frame — and snapping back to
    // fit would throw away a view the reader is still using.
    expect(boxes(store)).toEqual([]);
    // and an EMPTY selection is "deselected", not "resting": the drawing goes
    // plain rather than every area coming back outlined.
    expect(framed).not.toHaveBeenCalled();
  });

  it('deselects every area with one button', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const list = screen.getByTestId('section-list');
    const checks = list.querySelectorAll<HTMLInputElement>('.section-check');

    // Offered from the start: resting means every area is outlined, so taking
    // the colour off is as useful here as it is mid-selection.
    expect(screen.getByTestId('clear-sections')).toBeInTheDocument();

    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    expect(screen.getByTestId('section-showing').textContent).toContain('Showing');

    // DESELECT takes the colour off — the plain drawing, nothing over it.
    fireEvent.click(screen.getByTestId('clear-sections'));
    expect(boxes(store)).toEqual([]);
    expect(list.querySelectorAll<HTMLInputElement>('.section-check')[0].checked).toBe(false);
    expect(screen.getByTestId('marks-cleared')).toBeInTheDocument();

    // and "Show all" is the way back to outlining every area — a DIFFERENT
    // button, because "I have chosen nothing" and "I have not chosen" are
    // different answers and one control cannot mean both.
    fireEvent.click(screen.getByTestId('show-all-sections'));
    expect(boxes(store)).toBeNull();
    expect(screen.getByTestId('section-showing').textContent).not.toContain('Showing');
  });

  it('says how many are chosen once there is more than one', async () => {
    const { data } = buildData();
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const checks = screen
      .getByTestId('section-list')
      .querySelectorAll<HTMLInputElement>('.section-check');

    fireEvent.click(checks[0]);
    // One chosen still names it — "Showing REGION-01 only" is more use than a
    // count when the count is one.
    expect(screen.getByTestId('section-showing').textContent).toContain(pkg.sections[0].sectionId);

    fireEvent.click(checks[1]);
    expect(screen.getByTestId('section-showing').textContent).toMatch(/Showing\s*2\s*of/);
  });

  it('clicking a row still singles it out, replacing a multi-selection', async () => {
    const { data } = buildData();
    const store = mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    const list = screen.getByTestId('section-list');
    const checks = list.querySelectorAll<HTMLInputElement>('.section-check');

    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    // The row button answers a DIFFERENT question — "where is this one?" — so
    // it replaces the set rather than adding to it.
    fireEvent.click(list.querySelectorAll('.section-pick')[2]);
    expect(boxes(store)).toEqual([pkg.sections[2].sectionId]);
  });
});

describe('the second pass, reported on the unread parts', () => {
  // The panel's job here is to stop an unread part looking like an accounted-for
  // one. Three states have to be distinguishable at a glance: read and
  // attached, read and genuinely on its own, and not read at all.
  const gap = (over: Partial<GapClusterData> = {}): GapClusterData => ({
    id: 'GAP-01',
    bounds: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 },
    entityCount: 3,
    layers: [{ layer: 'COLS', count: 3 }],
    touches: [],
    nearest: { sectionId: 'REGION-09', distanceMm: 363 },
    callouts: [],
    sampleText: ['C1'],
    bbs: 'unknown',
    bbsBasis: 'no bar callout could be read here',
    ...over,
  });

  function withGaps(gaps: GapClusterData[]) {
    const { data, readResiduals } = buildData();
    const docId = pkg.documentId;
    return {
      data: { ...data, sectionsByDoc: { [docId]: { ...data.sectionsByDoc![docId], gaps } } },
      readResiduals,
    };
  }

  it('shows the relationship the second pass established, not a distance', async () => {
    // "nearest REGION-09, 363 mm away" is a DISTANCE. It was standing in for a
    // relationship it cannot supply, and the second pass replaces it with one.
    const { data } = withGaps([
      gap({
        second: {
          link: 'CONNECTED',
          connectedRegions: ['REGION-02'],
          uniqueEntities: 3,
          linkedTo: 'REGION-02',
          status: 'read',
          kind: 'callout',
          summary: 'The reinforcement note for the column detail.',
          relation: 'annotation',
          note: null,
          action: 'attach',
          resolvedTo: 'REGION-02',
          why: 'annotation of REGION-02',
        },
      }),
    ]);
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('gap-list'));

    expect(screen.getByTestId('gap-link-GAP-01').textContent).toBe('CONNECTED → REGION-02');
    expect(screen.getByTestId('gap-second-GAP-01').textContent).toContain('SECOND PASS → READ');
    expect(screen.getByTestId('gap-second-GAP-01').textContent).toContain('reinforcement note');
    // the first pass's distance guess is gone — two claims, one of them wrong
    expect(screen.getByTestId('gap-GAP-01').textContent).not.toContain('363');
  });

  it('says NEAR_CONNECTED distinctly from CONNECTED', () => {
    // They rest on different evidence: one is geometry alone, the other needed
    // a reading as well. Showing them the same way would hide that.
    const { data } = withGaps([
      gap({
        second: {
          link: 'NEAR_CONNECTED',
          connectedRegions: ['REGION-03'],
          uniqueEntities: 3,
          linkedTo: 'REGION-03',
          status: 'read',
          kind: 'detail',
          summary: 'A continuation of the layout plan.',
          relation: 'continuation',
          note: null,
          action: 'attach',
          resolvedTo: 'REGION-03',
          why: 'continuation of REGION-03',
        },
      }),
    ]);
    mount(data, (s) => s.openSheet('sh1'));
    const el = screen.getByTestId('gap-link-GAP-01');
    expect(el.textContent).toBe('NEAR_CONNECTED → REGION-03');
    expect(el.className).toContain('link-near-connected');
  });

  it('says a part was NOT READ rather than leaving it blank', () => {
    // The whole point of the stage: a piece nobody read must not look like a
    // piece that was read and found to be nothing.
    const { data } = withGaps([
      gap({
        second: {
          link: 'INDEPENDENT',
          connectedRegions: [],
          uniqueEntities: 3,
          linkedTo: null,
          status: 'unread',
          kind: null,
          summary: null,
          relation: null,
          note: 'not read — the second pass reads the 12 largest pieces',
          action: 'unresolved',
          resolvedTo: null,
          why: 'not read — the second pass reads the 12 largest pieces',
        },
      }),
    ]);
    mount(data, (s) => s.openSheet('sh1'));
    const el = screen.getByTestId('gap-second-GAP-01');
    expect(el.textContent).toContain('SECOND PASS → NOT READ');
    expect(el.textContent).toContain('12 largest');
    expect(el.className).toContain('unread');
  });

  it('falls back to the first-pass distance until the second pass has run', () => {
    // `undefined` is "has not run", which is a different statement from a part
    // that was read and turned out independent.
    const { data } = withGaps([gap()]);
    mount(data, (s) => s.openSheet('sh1'));
    expect(screen.queryByTestId('gap-link-GAP-01')).toBeNull();
    expect(screen.queryByTestId('gap-second-GAP-01')).toBeNull();
    expect(screen.getByTestId('gap-GAP-01').textContent).toContain('363');
  });

  it('runs the pass only when asked, on the drawing being looked at', () => {
    // It spends model calls, so nothing fires on its own.
    const { data, readResiduals } = withGaps([gap()]);
    mount(data, (s) => s.openSheet('sh1'));
    expect(readResiduals).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('read-residuals'));
    expect(readResiduals).toHaveBeenCalledWith(pkg.documentId);
  });
});

describe('finalisation — resolved parts stop being unread', () => {
  const gapWith = (
    id: string,
    action: 'attach' | 'explained' | 'unresolved',
    to: string | null,
  ): GapClusterData => ({
    id,
    bounds: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 },
    entityCount: 3,
    layers: [{ layer: 'COLS', count: 3 }],
    touches: [],
    nearest: null,
    callouts: [],
    sampleText: [],
    bbs: 'unknown',
    bbsBasis: 'no bar callout could be read here',
    second: {
      link: action === 'attach' ? 'CONNECTED' : 'INDEPENDENT',
      connectedRegions: to ? [to] : [],
      uniqueEntities: 3,
      linkedTo: to,
      status: action === 'attach' ? 'read' : 'failed',
      kind: action === 'attach' ? 'callout' : null,
      summary: action === 'attach' ? 'A reinforcement note.' : null,
      relation: action === 'attach' ? 'annotation' : null,
      note: action === 'attach' ? null : '429 rate limited',
      action,
      resolvedTo: to,
      why: action === 'attach' ? `annotation of ${to}` : '429 rate limited',
    },
  });

  function withGaps(gaps: GapClusterData[]) {
    const { data } = buildData();
    const docId = pkg.documentId;
    return { ...data, sectionsByDoc: { [docId]: { ...data.sectionsByDoc![docId], gaps } } };
  }

  it('counts only what is still unread, not what was folded into a region', async () => {
    // THE BUG. Four parts read and attached still read as "4 unread parts",
    // and the canvas agreed with the wrong number by keeping four orange boxes.
    const data = withGaps([
      gapWith('GAP-01', 'attach', 'REGION-13'),
      gapWith('GAP-02', 'attach', 'REGION-11'),
      gapWith('GAP-03', 'attach', 'REGION-10'),
      gapWith('GAP-04', 'attach', 'REGION-10'),
    ]);
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('gap-list'));

    const head = screen.getByTestId('gap-list').querySelector('.gap-head')!;
    expect(head.textContent).toContain('every unread part accounted for');
    expect(head.textContent).not.toMatch(/\d+ unread parts/);
  });

  it('keeps a genuinely unresolved part counted and marked', () => {
    // The fix must NOT be "hide all the orange".
    const data = withGaps([gapWith('GAP-01', 'attach', 'REGION-13'), gapWith('GAP-05', 'unresolved', null)]);
    mount(data, (s) => s.openSheet('sh1'));

    expect(screen.getByTestId('gap-list').querySelector('.gap-head')!.textContent).toContain(
      '1 unread part',
    );
    // the resolved one is still there as history, but not as a warning
    expect(screen.getByTestId('gap-GAP-01').className).toContain('resolved');
    expect(screen.getByTestId('gap-GAP-05').className).not.toContain('resolved');
  });

  it('says where an attached part went', () => {
    const data = withGaps([gapWith('GAP-03', 'attach', 'REGION-10')]);
    mount(data, (s) => s.openSheet('sh1'));
    expect(screen.getByTestId('gap-action-GAP-03').textContent).toContain('ATTACHED → REGION-10');
  });

  it('puts the still-unread parts first, so the review list reads top-down', () => {
    const data = withGaps([gapWith('GAP-01', 'attach', 'REGION-13'), gapWith('GAP-05', 'unresolved', null)]);
    mount(data, (s) => s.openSheet('sh1'));
    const ids = [...screen.getByTestId('gap-list').querySelectorAll('.gap-row')].map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['gap-GAP-05', 'gap-GAP-01']);
  });
});

describe('a part that was read and explained is not an alert', () => {
  // GAP-05 on the columns drawing: one GRID entity, zero-width, read as "a
  // sliver of a grid line". It was looked at and understood. Showing it in
  // amber under "1 UNREAD PART" with "Unknown / Needs Review" beneath sends
  // the reader to check something that has already been checked — and made a
  // fully-read drawing look like it still had something wrong with it.
  const explained: GapClusterData = {
    id: 'GAP-05',
    bounds: { xMin: 4600, yMin: 2620, xMax: 4600, yMax: 3400 },
    entityCount: 1,
    layers: [{ layer: 'GRID', count: 1 }],
    touches: [],
    nearest: null,
    callouts: [],
    sampleText: [],
    bbs: 'unknown',
    bbsBasis: 'no bar callout could be read here',
    second: {
      link: 'INDEPENDENT',
      connectedRegions: [],
      uniqueEntities: 3,
      linkedTo: null,
      status: 'read',
      kind: 'grid-line',
      summary: 'A single vertical GRID layer line fragment with no text.',
      relation: 'independent',
      note: null,
      action: 'explained',
      resolvedTo: null,
      why: 'A single vertical GRID layer line fragment with no text.',
    },
  };

  function mountWith(gaps: GapClusterData[]) {
    const { data } = buildData();
    const docId = pkg.documentId;
    mount({ ...data, sectionsByDoc: { [docId]: { ...data.sectionsByDoc![docId], gaps } } }, (s) =>
      s.openSheet('sh1'),
    );
  }

  it('is not counted as unread', async () => {
    mountWith([explained]);
    await waitFor(() => screen.getByTestId('gap-list'));
    const head = screen.getByTestId('gap-list').querySelector('.gap-head')!;
    expect(head.textContent).toContain('every unread part accounted for');
    expect(head.textContent).not.toContain('1 unread part');
  });

  it('reads as resolved, and drops the review prompt', () => {
    mountWith([explained]);
    expect(screen.getByTestId('gap-GAP-05').className).toContain('resolved');
    expect(screen.getByTestId('gap-action-GAP-05').textContent).toContain('EXPLAINED');
    // "Unknown / Needs Review" is a REVIEW PROMPT — there is nothing left to
    // review here, so it is not shown.
    expect(screen.getByTestId('gap-bbs-GAP-05')).not.toBeVisible();
  });

  it('still shows the prompt on a part that really is unresolved', () => {
    // The fix must not be "hide all the amber".
    mountWith([{ ...explained, id: 'GAP-09', second: undefined }]);
    expect(screen.getByTestId('gap-list').querySelector('.gap-head')!.textContent).toContain(
      '1 unread part',
    );
    expect(screen.getByTestId('gap-bbs-GAP-09')).toBeVisible();
  });
});

describe('the panel reports geometry, never the reading, for connectivity', () => {
  // The screenshot that started this: a residual whose entities overlap a
  // region, labelled INDEPENDENT because that is what the model said. An
  // overlap is not a matter of opinion, and the model was not asked.
  it('shows CONNECTED even when the reading called it independent', async () => {
    const { data } = buildData();
    const docId = pkg.documentId;
    const gap: GapClusterData = {
      id: 'GAP-01',
      bounds: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 },
      entityCount: 82,
      layers: [{ layer: 'S LINE', count: 29 }],
      touches: [],
      nearest: null,
      callouts: [],
      sampleText: [],
      bbs: 'unknown',
      bbsBasis: 'no bar callout could be read here',
      second: {
        // geometry says CONNECTED …
        link: 'CONNECTED',
        connectedRegions: ['REGION-01'],
        uniqueEntities: 82,
        linkedTo: 'REGION-01',
        status: 'read',
        kind: 'detail',
        // … while the reading says the opposite
        summary: 'A separate stair detail.',
        relation: 'independent',
        note: null,
        action: 'attach',
        resolvedTo: 'REGION-01',
        why: 'part-of of REGION-01',
      },
    };
    mount({ ...data, sectionsByDoc: { [docId]: { ...data.sectionsByDoc![docId], gaps: [gap] } } }, (s) =>
      s.openSheet('sh1'),
    );
    await waitFor(() => screen.getByTestId('gap-list'));

    expect(screen.getByTestId('gap-link-GAP-01').textContent).toBe('CONNECTED → REGION-01');
    expect(screen.getByTestId('gap-GAP-01').textContent).not.toContain('INDEPENDENT');
    // and the UNIQUE count, not the raw cluster size
    expect(screen.getByTestId('gap-GAP-01').textContent).toContain('82 entities');
  });

  it('names every region the geometry reaches, not just one', () => {
    const { data } = buildData();
    const docId = pkg.documentId;
    const gap: GapClusterData = {
      id: 'GAP-02',
      bounds: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 },
      entityCount: 4,
      layers: [],
      touches: [],
      nearest: null,
      callouts: [],
      sampleText: [],
      bbs: 'unknown',
      bbsBasis: '—',
      second: {
        link: 'CONNECTED',
        connectedRegions: ['REGION-01', 'REGION-03'],
        uniqueEntities: 4,
        linkedTo: 'REGION-01',
        status: 'read',
        kind: 'callout',
        summary: 'A shared callout.',
        relation: 'annotation',
        note: null,
        action: 'attach',
        resolvedTo: 'REGION-01',
        why: 'annotation of REGION-01',
      },
    };
    mount({ ...data, sectionsByDoc: { [docId]: { ...data.sectionsByDoc![docId], gaps: [gap] } } }, (s) =>
      s.openSheet('sh1'),
    );
    expect(screen.getByTestId('gap-link-GAP-02').textContent).toBe(
      'CONNECTED → REGION-01, REGION-03',
    );
    // it still went into ONE of them — connectivity and ownership are
    // different questions and the card answers both
    expect(screen.getByTestId('gap-action-GAP-02').textContent).toContain('ATTACHED → REGION-01');
  });
});

describe('step 8 — the section check, reported on the rows', () => {
  // A verdict has three states and "unchecked" is a fourth. A section nobody
  // has verified must not read as a verified one, so an absent verdict shows
  // nothing at all rather than a reassuring badge.
  type Verdict = { status: 'PASS' | 'WARNING' | 'FAIL'; confidence: number; reasons: string[] };

  function withVerdicts(verdicts: Record<string, Verdict>) {
    const { data, validate } = buildData();
    const docId = pkg.documentId;
    const info = data.sectionsByDoc![docId];
    return {
      validate,
      data: {
        ...data,
        sectionsByDoc: {
          [docId]: {
            ...info,
            sections: info.sections.map((s) => ({ ...s, verdict: verdicts[s.sectionId] })),
          },
        },
      },
    };
  }

  it('shows nothing on a section that has not been checked', async () => {
    const { data } = withVerdicts({});
    mount(data, (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-list'));
    expect(screen.queryByTestId(`section-verdict-${pkg.sections[0].sectionId}`)).toBeNull();
  });

  it('marks a failing section, and carries the reason in its tooltip', () => {
    const id = pkg.sections[0].sectionId;
    const { data } = withVerdicts({
      [id]: { status: 'FAIL', confidence: 0.71, reasons: ['text: text inside the section area is not in the section'] },
    });
    mount(data, (s) => s.openSheet('sh1'));
    const chip = screen.getByTestId(`section-verdict-${id}`);
    expect(chip.textContent).toBe('FAIL');
    expect(chip.className).toContain('fail');
    expect(chip.getAttribute('title')).toContain('not in the section');
  });

  it('runs the check only when asked, on the drawing being looked at', () => {
    const { data, validate } = withVerdicts({});
    mount(data, (s) => s.openSheet('sh1'));
    expect(validate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('validate-sections'));
    expect(validate).toHaveBeenCalledWith(pkg.documentId);
  });

  it('offers a re-check once a verdict is in', () => {
    const id = pkg.sections[0].sectionId;
    const { data } = withVerdicts({ [id]: { status: 'PASS', confidence: 1, reasons: [] } });
    mount(data, (s) => s.openSheet('sh1'));
    expect(screen.getByTestId('validate-sections').textContent).toBe('Check again');
  });
});

// ============================================================
// THE PANEL LISTS DETAILS, NOT INK CLUSTERS
// ============================================================
//
// A pedestal drawn as a plan, a section and its bar callouts is THREE read
// areas and ONE engineering detail. Listed flat, it read as three unrelated
// things — the very complaint this grouping answers.
describe('read areas are listed under the detail they belong to', () => {
  const withGroups = (over: Partial<SheetSectionsInfo> = {}) => {
    const { data } = buildData();
    const docId = Object.keys(data.sectionsByDoc!)[0];
    const base = data.sectionsByDoc![docId];
    const one = base.sections[0];
    const info: SheetSectionsInfo = {
      ...base,
      sections: [
        { ...one, sectionId: 'REGION-01', label: 'PLAN - PEDESTAL P1' },
        { ...one, sectionId: 'REGION-02', label: 'SECTION A-A - PEDESTAL P1' },
        { ...one, sectionId: 'REGION-03', label: '20-16 vertical bars' },
        { ...one, sectionId: 'REGION-04', label: 'PLAN - PEDESTAL P2' },
      ],
      logicalSections: [
        {
          id: 'SECTION-01',
          title: 'PLAN - PEDESTAL P1',
          kind: 'plan',
          marks: ['P1'],
          regionIds: ['REGION-01', 'REGION-02', 'REGION-03'],
          relation: 'CONFIRMED',
          basis: ['REGION-01 and REGION-02 are two views of PEDESTAL P1 [100]'],
        },
        {
          id: 'SECTION-02',
          title: 'PLAN - PEDESTAL P2',
          kind: 'plan',
          marks: ['P2'],
          regionIds: ['REGION-04'],
          relation: 'POSSIBLE_CONTINUATION',
          basis: ['REGION-04 stands alone'],
        },
      ],
      ...over,
    };
    return { ...data, sectionsByDoc: { [docId]: info } };
  };

  it('shows one heading per detail, with its read areas under it', async () => {
    mount(withGroups(), (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-group-SECTION-01'));

    const p1 = screen.getByTestId('section-group-SECTION-01');
    expect(p1.textContent).toMatch(/P1/);
    expect(p1.textContent).toMatch(/3 read areas/);
    for (const id of ['REGION-01', 'REGION-02', 'REGION-03']) {
      expect(p1.textContent, id).toContain(id);
    }
    // the unrelated pedestal is its own detail, not folded in
    const p2 = screen.getByTestId('section-group-SECTION-02');
    expect(p2.textContent).toMatch(/P2/);
    expect(p2.textContent).toContain('REGION-04');
    expect(p1.textContent).not.toContain('REGION-04');
  });

  it('flags a grouping that rests on proximity alone', async () => {
    mount(withGroups(), (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-group-SECTION-02'));
    expect(screen.getByTestId('section-group-SECTION-02').textContent).toMatch(/check grouping/);
    expect(screen.getByTestId('section-group-SECTION-01').textContent).not.toMatch(/check grouping/);
  });

  it('an area the grouping did not place is still listed, not lost', async () => {
    const data = withGroups();
    const docId = Object.keys(data.sectionsByDoc!)[0];
    const info = data.sectionsByDoc![docId];
    mount(
      {
        ...data,
        sectionsByDoc: {
          [docId]: { ...info, sections: [...info.sections, { ...info.sections[0], sectionId: 'REGION-09' }] },
        },
      },
      (s) => s.openSheet('sh1'),
    );
    await waitFor(() => screen.getByTestId('section-group-ungrouped'));
    expect(screen.getByTestId('section-group-ungrouped').textContent).toContain('REGION-09');
  });

  it('with no grouping at all it lists the areas as before', async () => {
    mount(withGroups({ logicalSections: [] }), (s) => s.openSheet('sh1'));
    await waitFor(() => screen.getByTestId('section-group-all'));
    expect(screen.getByTestId('section-group-all').textContent).toContain('REGION-01');
  });
});
