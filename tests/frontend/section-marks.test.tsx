// The read, drawn onto the drawing — the shell's half of it.
//
// The marks are no longer an overlay. They are emitted inside the sheet's own
// SVG by `groupedSheetSvg` (see tests/domain/section-highlights.test.ts for the
// coordinate arithmetic), and this file covers what the Viewport still owns:
// injecting that SVG, hiding the marks when the toggle is off, and lighting one
// on hover without re-injecting a multi-megabyte string.
//
// Two earlier architectures failed here and neither failure was visible in a
// test: an overlay whose transform was never applied, and an overlay whose
// viewBox was calibrated on a miscomputed frame. Both rendered the right DOM in
// the wrong place. Putting the marks in the drawing's own SVG removes that
// class of bug rather than testing around it.

import React, { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { Viewport } from '../../src/components/Viewport';
import { StudioDataContext, type StudioData, type StudioSheet } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

afterEach(cleanup);

/** A sheet SVG carrying its marks, exactly as `groupedSheetSvg` emits them. */
const SVG_WITH_MARKS =
  '<svg viewBox="0 0 1000 500">' +
  '<g data-layer="CONC"><path d="M10 10L20 20"/></g>' +
  '<g class="sheet-marks" data-testid="section-marks">' +
  '<g class="mark-fills" data-testid="mark-fills" opacity="0.3">' +
  '<rect x="100" y="100" width="200" height="100" data-section="REGION-01"/>' +
  '<rect x="400" y="150" width="150" height="120" data-section="REGION-02"/>' +
  '</g>' +
  '<g class="mark" data-section="REGION-01" data-mm="0,0,100,100">' +
  '<rect x="100" y="100" width="200" height="100"/><text>REGION-01</text></g>' +
  '<g class="mark" data-section="REGION-02" data-mm="0,0,100,100">' +
  '<rect x="400" y="150" width="150" height="120"/><text>REGION-02</text></g>' +
  '<g class="mark gap" data-section="GAP-01" data-mm="0,0,100,100">' +
  '<rect x="700" y="50" width="80" height="60"/><text>GAP-01</text></g>' +
  '</g></svg>';

const SHEET: StudioSheet = {
  id: 'sheet-1',
  tab: 'FOUND-01.dxf',
  title: 'Foundation layout',
  number: 'FOUND-01',
  rev: 'R1',
  discipline: 'Structural',
  entities: 3063,
  grounded: false,
  issues: 0,
  hasModel: false,
  panels: [],
  documentId: 'doc-1',
  model: { widthUnits: 1000, heightUnits: 500, mmPerUnit: 2, x0Mm: 10_000, y0Mm: 4_000 },
  svg: SVG_WITH_MARKS,
};

function mount() {
  const store = new StudioStore();
  store.openSheet('sheet-1');
  function Harness() {
    const data = useMemo<StudioData>(
      () => ({
        projectName: 'Marks',
        groups: [],
        sheets: { 'sheet-1': SHEET },
        scheduleRows: [],
        scheduleVersion: '—',
      }),
      [],
    );
    return (
      <StudioStoreContext.Provider value={store}>
        <StudioDataContext.Provider value={data}>
          <Viewport />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>
    );
  }
  render(<Harness />);
  return store;
}

const host = () => screen.getByTestId('sheet-host');

describe('the sheet SVG carries its own marks', () => {
  it('injects every mark into the drawing, with nothing hovered', () => {
    mount();
    const marks = host().querySelectorAll('.sheet-marks g[data-section]');
    expect(marks).toHaveLength(3); // two read sections and one gap
    expect([...marks].map((m) => (m as HTMLElement).dataset.section)).toEqual([
      'REGION-01',
      'REGION-02',
      'GAP-01',
    ]);
    // and they are INSIDE the drawing's own svg — not a sibling layer
    expect(host().querySelector('svg .sheet-marks')).toBeTruthy();
    expect(host().parentElement?.querySelector('.sheet.marks')).toBeNull();
  });

  it('read sections are filled, the gap is not', () => {
    mount();
    const fills = host().querySelectorAll('[data-testid="mark-fills"] rect');
    expect(fills).toHaveLength(2);
    expect([...fills].map((f) => (f as HTMLElement).dataset.section)).not.toContain('GAP-01');
  });

  it('the marks ride the sheet, because they ARE the sheet', () => {
    const store = mount();
    // One element carries the transform, so there is nothing to keep in step.
    act(() => store.setZoomPan(5.47, { x: -1200, y: -800 }));
    expect(host().style.transform).toBe('translate(-1200px, -800px) scale(5.47)');
    expect(host().querySelectorAll('.sheet-marks g[data-section]')).toHaveLength(3);
  });

  it('the overlay toggle hides them without touching the drawing', () => {
    const store = mount();
    const group = () => host().querySelector<SVGGElement>('.sheet-marks')!;
    // the group's OWN style carries the toggle — no selector to mismatch
    expect(group().style.display).toBe('');
    act(() => store.setSectionMarks(false));
    expect(group().style.display).toBe('none');
    // still in the DOM — CSS hides them, so turning it back on costs nothing
    expect(host().querySelectorAll('.sheet-marks g[data-section]')).toHaveLength(3);
    act(() => store.setSectionMarks(true));
    expect(group().style.display).toBe('');
  });

  it('hovering a section lights it and only it, without re-injecting the svg', () => {
    const store = mount();
    const svg = host().querySelector('svg');
    act(() => store.setHoverSection('REGION-01'));
    const heavier = [...host().querySelectorAll<SVGGElement>('.sheet-marks g[data-section]')].filter(
      (g) => g.querySelector('rect')?.getAttribute('stroke-width') === '4',
    );
    expect(heavier.map((g) => g.dataset.section)).toEqual(['REGION-01']);
    // the same svg element — a re-injection would replace it
    expect(host().querySelector('svg')).toBe(svg);

    act(() => store.setHoverSection(null));
    expect(
      [...host().querySelectorAll<SVGGElement>('.sheet-marks g[data-section]')].filter(
        (g) => g.querySelector('rect')?.getAttribute('stroke-width') === '4',
      ),
    ).toHaveLength(0);
  });
});

describe('a drawing that is open must be on screen', () => {
  // Framing is remembered per sheet. A drawing panned away while hunting for
  // something reopens exactly where it was left — off the pane, on a black
  // canvas — and the wheel cannot recover it, because zoom is about the
  // pointer. That is indistinguishable from a drawing that failed to load.
  function panePlacedAt(x: number, y: number, w = 800, h = 600) {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
      const isPane = (this as HTMLElement).classList?.contains('pane');
      const box = isPane
        ? { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }
        : // the sheet host, transformed far off to the left
          { x: -5000, y: -5000, left: -5000, top: -5000, right: -4000, bottom: -4000, width: 1000, height: 1000 };
      return { ...box, toJSON: () => ({}) } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  it('refits when the remembered framing leaves it off the pane', () => {
    const restore = panePlacedAt(0, 0);
    try {
      const store = new StudioStore();
      store.openSheet('sheet-1');
      // panned far away while hunting for something, then left there
      store.setZoomPan(4, { x: -9000, y: -9000 });
      expect(store.getState().view.zoom).toBe(4);

      function Harness() {
        const data = useMemo<StudioData>(
          () => ({
            projectName: 'Marks',
            groups: [],
            sheets: { 'sheet-1': SHEET },
            scheduleRows: [],
            scheduleVersion: '—',
          }),
          [],
        );
        return (
          <StudioStoreContext.Provider value={store}>
            <StudioDataContext.Provider value={data}>
              <Viewport />
            </StudioDataContext.Provider>
          </StudioStoreContext.Provider>
        );
      }
      render(<Harness />);
      // opening put it back where it can be seen
      expect(store.getState().view.zoom).toBe(1);
      expect(store.getState().view.pan).toEqual({ x: 0, y: 0 });
    } finally {
      restore();
    }
  });

  it('leaves a framing that still shows the drawing alone', () => {
    const store = mount(); // jsdom rects are 0x0 — nothing to refit against
    act(() => store.setZoomPan(2.5, { x: -40, y: -30 }));
    expect(store.getState().view.zoom).toBe(2.5);
    expect(store.getState().view.pan).toEqual({ x: -40, y: -30 });
  });
});

describe('picking one read area out of the drawing', () => {
  const marks = () => host().querySelector('.sheet-marks')!;
  /** Emphasis is INLINE now, not a class — the stylesheet colours nothing. */
  const lit = () =>
    [...marks().querySelectorAll<SVGGElement>('g[data-section]')].filter(
      (g) => g.querySelector('rect')?.getAttribute('stroke-width') === '4',
    );
  const dimmed = () =>
    [...marks().querySelectorAll<SVGGElement>('g[data-section]')].filter(
      (g) => g.style.opacity === '0.18',
    );

  it('a chosen section stays lit and dims the rest', () => {
    const store = mount();
    act(() => store.pinSection('REGION-01'));
    // the chosen one is heavier, and everything else is dimmed
    expect(lit().map((g) => g.dataset.section)).toEqual(['REGION-01']);
    expect(dimmed().map((g) => g.dataset.section)).toEqual(['REGION-02', 'GAP-01']);
    // every other mark is still THERE — dimmed by CSS, not removed, or the
    // coverage picture would be lost the moment you looked at one section
    expect(marks().querySelectorAll('g[data-section]')).toHaveLength(3);
  });

  it('a choice outlives the hover that led to it', () => {
    const store = mount();
    act(() => store.pinSection('REGION-02'));
    // moving the mouse off the row towards the drawing ends the hover
    act(() => store.setHoverSection(null));
    expect(lit().map((g) => g.dataset.section)).toEqual(['REGION-02']);
  });

  it('hovering previews a section while nothing is chosen', () => {
    const store = mount();
    act(() => store.setHoverSection('REGION-01'));
    expect(lit().map((g) => g.dataset.section)).toEqual(['REGION-01']);
    // a hover previews; it does not dim the others the way a choice does
    expect(dimmed()).toHaveLength(0);
    act(() => store.setHoverSection(null));
    expect(lit()).toHaveLength(0);
  });

  it('lights EVERY chosen section at once, dimming only the rest', () => {
    // Ticking two areas is how you see whether the splitter cut the same table
    // twice. Both have to be lit together — reading them one after the other
    // cannot answer a question about the pair.
    const store = mount();
    act(() => store.toggleSection('REGION-01'));
    act(() => store.toggleSection('GAP-01'));
    expect(lit().map((g) => g.dataset.section).sort()).toEqual(['GAP-01', 'REGION-01']);
    expect(dimmed().map((g) => g.dataset.section)).toEqual(['REGION-02']);
    // Fills follow the same rule — chosen at full strength, the rest receding.
    // GAP-01 has no fill to check: a gap is what the read did NOT reach, so
    // washing it in the colour that means "read" would say the opposite.
    const rects = [...marks().querySelectorAll<SVGRectElement>('[data-testid="mark-fills"] rect')];
    expect(rects.find((r) => r.dataset.section === 'REGION-01')!.style.opacity).toBe('1');
    expect(rects.find((r) => r.dataset.section === 'REGION-02')!.style.opacity).toBe('0.2');
  });

  it('unticking one leaves the others chosen', () => {
    const store = mount();
    act(() => store.toggleSection('REGION-01'));
    act(() => store.toggleSection('REGION-02'));
    act(() => store.toggleSection('REGION-01'));
    expect(lit().map((g) => g.dataset.section)).toEqual(['REGION-02']);
  });

  it('a choice still outranks a hover when several are chosen', () => {
    const store = mount();
    act(() => store.toggleSection('REGION-01'));
    act(() => store.toggleSection('REGION-02'));
    // hovering a third row must not quietly join it to the selection
    act(() => store.setHoverSection('GAP-01'));
    expect(lit().map((g) => g.dataset.section).sort()).toEqual(['REGION-01', 'REGION-02']);
  });

  it('deselect-all takes the colour off the drawing entirely', () => {
    // NOT "brings them all back". The outlines sit on the very lines you check
    // them against, so reading the geometry underneath is a real thing to want
    // — and it is what the button says. Putting every area back instead made
    // "Deselect all" do the opposite of its own label.
    const store = mount();
    act(() => store.toggleSection('REGION-01'));
    act(() => store.clearSections());
    expect((marks() as SVGGElement).style.display).toBe('none');
  });

  it('show-all is the way back from deselected, and is a different act', () => {
    const store = mount();
    act(() => store.clearSections());
    expect((marks() as SVGGElement).style.display).toBe('none');

    act(() => store.showAllSections());
    expect((marks() as SVGGElement).style.display).toBe('');
    // resting: every area outlined, none dimmed, none singled out
    expect(dimmed()).toHaveLength(0);
    expect(lit()).toHaveLength(0);
  });

  it('opens resting — outlined, not deselected', () => {
    // A drawing that has been read shows what was read. An empty selection is
    // reachable only by asking for it.
    const store = mount();
    expect(store.getState().view.pinnedSections).toBeNull();
    expect((marks() as SVGGElement).style.display).toBe('');
    expect(dimmed()).toHaveLength(0);
  });

  it('show-all clears the choice and brings every area back undimmed', () => {
    const store = mount();
    act(() => store.pinSection('REGION-01'));
    act(() => store.pinSection(null));
    expect(dimmed()).toHaveLength(0);
    expect(lit()).toHaveLength(0);
  });
});

describe('a chosen section is unmistakable', () => {
  const marksOf = () => host().querySelector('.sheet-marks')!;
  const fillsOf = () => marksOf().querySelector('[data-testid="mark-fills"]')!;

  it('holds the wash at the 0.3 the sheet was specified at, and dims the rest', () => {
    const store = mount();
    expect(fillsOf().getAttribute('opacity')).toBe('0.3');

    act(() => store.pinSection('REGION-01'));
    // choosing one does not brighten it past 0.3 — the others recede instead
    expect(fillsOf().getAttribute('opacity')).toBe('0.3');
    const rects = [...fillsOf().querySelectorAll<SVGRectElement>('rect')];
    expect(rects.find((r) => r.dataset.section === 'REGION-01')!.style.opacity).toBe('1');
    expect(rects.find((r) => r.dataset.section === 'REGION-02')!.style.opacity).toBe('0.2');

    act(() => store.pinSection(null));
    expect(rects.find((r) => r.dataset.section === 'REGION-02')!.style.opacity).toBe('1');
  });
});

describe('the canvas re-injects when the SVG string changes', () => {
  // THE ASYMMETRY THAT CAUSED THIS. The Details preview renders the same
  // `sheet.svg` through dangerouslySetInnerHTML, which React re-applies
  // whenever the STRING differs. The canvas re-injected only when the sheet
  // OBJECT changed — so a rebuild that produced new markup behind a reused
  // object left the canvas holding stale DOM while Details showed the new one.
  // That is exactly "the preview has highlights and the drawing does not".
  it('picks up new markup even when the sheet object is reused', () => {
    const store = new StudioStore();
    store.openSheet('sheet-1');

    // One object, mutated in place — the worst case for an identity dependency.
    const shared: StudioSheet = { ...SHEET, svg: '<svg viewBox="0 0 1000 500"></svg>' };
    function Harness({ svg }: { svg: string }) {
      shared.svg = svg;
      const data = useMemo<StudioData>(
        () => ({
          projectName: 'Marks',
          groups: [],
          sheets: { 'sheet-1': shared },
          scheduleRows: [],
          scheduleVersion: '—',
        }),
        [],
      );
      return (
        <StudioStoreContext.Provider value={store}>
          <StudioDataContext.Provider value={data}>
            <Viewport />
          </StudioDataContext.Provider>
        </StudioStoreContext.Provider>
      );
    }

    const { rerender } = render(<Harness svg={shared.svg} />);
    expect(host().querySelectorAll('.sheet-marks g[data-section]')).toHaveLength(0);

    // the read lands: same object, new markup
    rerender(<Harness svg={SVG_WITH_MARKS} />);
    expect(host().querySelectorAll('.sheet-marks g[data-section]')).toHaveLength(3);
  });
});

describe('a drawing that is open must also be LEGIBLE', () => {
  // The sheet can fill the pane while the DRAWING is a speck inside it. The
  // viewBox frames whatever `framedBounds` decided the content is, and on a
  // drawing whose strays it cannot separate that box runs a couple of hundred
  // times the ink — so the drawing opens as a few pixels in the middle of an
  // empty canvas, which reads as a failed load. The only way out was to scroll
  // to 3,700% by hand.
  //
  // Rects are faked because jsdom has no layout: this is entirely a question
  // about measured pixels, and measuring is the thing under test.
  function layout(inkSize: number, paneW = 800, paneH = 600) {
    const original = Element.prototype.getBoundingClientRect;
    const box = (x: number, y: number, w: number, h: number) =>
      ({
        x,
        y,
        left: x,
        top: y,
        right: x + w,
        bottom: y + h,
        width: w,
        height: h,
        toJSON: () => ({}),
      }) as DOMRect;
    Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
      const el = this as HTMLElement;
      if (el.classList?.contains('pane')) return box(0, 0, paneW, paneH);
      // the ink layers, centred in the pane at whatever size the case wants
      if (el.getAttribute?.('data-layer')) {
        return box((paneW - inkSize) / 2, (paneH - inkSize) / 2, inkSize, inkSize);
      }
      // the sheet host fills the pane — the viewBox does, even when the ink
      // inside it does not, which is the whole point
      return box(0, 0, paneW, paneH);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  function open(store: StudioStore) {
    function Harness() {
      const data = useMemo<StudioData>(
        () => ({
          projectName: 'Marks',
          groups: [],
          sheets: { 'sheet-1': { ...SHEET, svg: SVG_WITH_MARKS } },
          scheduleRows: [],
          scheduleVersion: '—',
        }),
        [],
      );
      return (
        <StudioStoreContext.Provider value={store}>
          <StudioDataContext.Provider value={data}>
            <Viewport />
          </StudioDataContext.Provider>
        </StudioStoreContext.Provider>
      );
    }
    render(<Harness />);
  }

  it('fits a drawing that would otherwise open as a speck', () => {
    const restore = layout(8); // 8px of ink in an 800px pane
    try {
      const store = new StudioStore();
      store.openSheet('sheet-1');
      open(store);
      // 8px of ink asked to fill 90% of 600px — it zooms in by ~67x rather
      // than leaving the reader to find it by hand.
      expect(store.getState().view.zoom).toBeGreaterThan(50);
    } finally {
      restore();
    }
  });

  it('leaves a well-framed drawing exactly as it was', () => {
    // Fitting is only worth doing when it changes something. A drawing that
    // already fills the pane must not be nudged on every open — that would
    // move the camera on every tab switch for no reason.
    const restore = layout(700); // ink already fills the pane
    try {
      const store = new StudioStore();
      store.openSheet('sheet-1');
      open(store);
      expect(store.getState().view.zoom).toBe(1);
      expect(store.getState().view.pan).toEqual({ x: 0, y: 0 });
    } finally {
      restore();
    }
  });

  it('Zoom to fit frames the ink even when nothing is wrong', () => {
    // The rescue above is conditional; pressing Fit is not. It is an explicit
    // request and must always frame the drawing.
    const restore = layout(200);
    try {
      const store = new StudioStore();
      store.openSheet('sheet-1');
      open(store);
      expect(store.getState().view.zoom).toBe(1); // no rescue: 200 of 800
      act(() => store.zoomFit());
      // 200px of ink into 90% of a 600px pane
      expect(store.getState().view.zoom).toBeCloseTo(2.7, 1);
    } finally {
      restore();
    }
  });

  it('resets rather than leaving a blank sheet at a wild zoom', () => {
    const restore = layout(0); // nothing painted
    try {
      const store = new StudioStore();
      store.openSheet('sheet-1');
      open(store);
      act(() => store.setZoomPan(37, { x: -100, y: -100 }));
      act(() => store.zoomFit());
      expect(store.getState().view.zoom).toBe(1);
      expect(store.getState().view.pan).toEqual({ x: 0, y: 0 });
    } finally {
      restore();
    }
  });
});
