// Sheet strip — the stage's 35px header band: Files tab, one tab per open
// sheet, and the sheet tools. Nothing here needs a model the sheet has not got
// (STUDIO_DESIGN §4.4); the Model control only renders when hasModel.
//
// EVERY tab in the strip drags. Files and the Specification used to sit
// outside the list as fixed furniture, which made the strip two things: two
// tabs that could not move and a row of drawings that could not pass them.
// They are all in one list now, ordered by `tabOrderOf`, and dropping one
// rewrites `sheets.open` to match — so the order the eye reads is the order
// "Close the others" and the next-active pick walk.

import React, { useRef, useState } from 'react';
import { useStudioData } from '../studio/data';
import { FILES_TAB, layersFor, SPEC_TAB, tabOrderOf, useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { Menu, Popover, useMenuAnchor } from './Menu';
import { toast } from './Toasts';
import './SheetStrip.css';

/** Named stops in the zoom menu — a shortcut list, never a range. */
const ZOOM_STOPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 50];

/**
 * The zoom badge, readable at every scale the wheel can reach.
 *
 * `Math.round(zoom * 100)` read "0%" for everything below half a percent, so
 * zooming out past a site plan looked like the badge had broken. Precision
 * grows as the number shrinks.
 */
export function zoomLabel(zoom: number): string {
  const pct = zoom * 100;
  if (pct >= 1000) return `${Math.round(pct).toLocaleString('en-US')}%`;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct > 0) return `${Number(pct.toPrecision(2))}%`;
  return '0%';
}

const LAYER_NAMES: Record<string, string> = {
  CONC: 'Concrete outline',
  RBAR: 'Reinforcement',
  GRND: 'Ground & levels',
  DIMS: 'Dimensions',
  TEXT: 'Text & callouts',
  SHEET: 'Border & title block',
};

export function SheetStrip() {
  const data = useStudioData();
  const store = useStudioStore();
  const { sheets, ui, view } = useStudio((s) => ({ sheets: s.sheets, ui: s.ui, view: s.view }));
  const active = sheets.active ? data.sheets[sheets.active] : null;

  const tabsMenu = useMenuAnchor();
  const zoomMenu = useMenuAnchor();
  const layersMenu = useMenuAnchor();
  const panelsMenu = useMenuAnchor();
  const findMenu = useMenuAnchor();
  const revMenu = useMenuAnchor();
  const [findQuery, setFindQuery] = useState('');
  // What the strip SHOWS mid-drag: the tab in flight, how far it has been
  // carried, and where it would land. The authoritative copy is `dragRef` —
  // this exists to render, and an abandoned drag must leave no trace, which
  // is why neither of them is in the store.
  const [drag, setDrag] = useState<{ id: string; dx: number; over: string | null; after: boolean } | null>(null);
  const dragRef = useRef<{
    id: string;
    startX: number;
    moved: boolean;
    over: string | null;
    after: boolean;
  } | null>(null);
  // A drag ends in a click on the tab it started from; without this the tab
  // you were reordering would also open.
  const clickAfterDrag = useRef(false);
  const tabEls = useRef(new Map<string, HTMLElement>());

  const dense = sheets.open.length > 5;
  const order = tabOrderOf({ ui, sheets });

  const registerTab = (id: string) => (el: HTMLElement | null) => {
    if (el) tabEls.current.set(id, el);
    else tabEls.current.delete(id);
  };

  /**
   * Reordering runs on POINTER events, not HTML5 drag-and-drop.
   *
   * The native API cannot do this job here. `draggable` is inert on a form
   * control in Chromium; a dragstart is refused for reasons the page never
   * sees; there is no live feedback, so a drag that does not take is
   * indistinguishable from a strip that does not reorder — which is exactly
   * how this landed the first time. Pointer events behave identically on
   * every tab whatever its tag or content, carry the tab under the cursor so
   * you can see what you are doing, and work with a pen and a touchscreen.
   */
  const DRAG_SLOP = 4;

  /** The tab under `clientX`, and which side of its midpoint. */
  const landing = (dragId: string, clientX: number): { over: string | null; after: boolean } => {
    for (const [id, el] of tabEls.current) {
      if (id === dragId) continue;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        return { over: id, after: clientX > r.left + r.width / 2 };
      }
    }
    return { over: null, after: false };
  };

  const tabProps = (id: string, activate: () => void) => ({
    ref: registerTab(id),
    role: 'button',
    tabIndex: 0,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // Left button only, and never from the close cross — that is its own
      // control and dragging off it would be a hidden way to close a tab.
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('.x')) return;
      dragRef.current = { id, startX: e.clientX, moved: false, over: null, after: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      // A few pixels of slop, so a click that trembles still opens the tab.
      if (!d.moved && Math.abs(dx) < DRAG_SLOP) return;
      d.moved = true;
      const at = landing(d.id, e.clientX);
      d.over = at.over;
      d.after = at.after;
      setDrag({ id: d.id, dx, over: at.over, after: at.after });
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (!d.moved) return; // a plain click: let onClick open the tab
      clickAfterDrag.current = true;
      if (d.over) store.moveTab(d.id, d.over, d.after);
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setDrag(null);
    },
    onClick: () => {
      if (clickAfterDrag.current) {
        clickAfterDrag.current = false;
        return;
      }
      activate();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      // The close cross runs its own keys and stops them; this is the tab.
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      activate();
    },
  });

  /** The insertion mark, and the tab in flight. */
  const dragClass = (id: string): string =>
    [
      drag?.id === id ? ' dragging' : '',
      drag && drag.over === id && drag.id !== id ? (drag.after ? ' drop-after' : ' drop-before') : '',
    ].join('');

  /** The dragged tab follows the pointer; everything else stays put. */
  const dragStyle = (id: string): React.CSSProperties | undefined =>
    drag?.id === id ? { transform: `translateX(${drag.dx}px)` } : undefined;

  return (
    <div className="tabs">
      <div className={`tab-list${dense ? ' dense' : ''}`}>
        {order.map((id) => {
          if (id === FILES_TAB) {
            return (
              <div
                key={id}
                className={`tab files${ui.stageMode === 'files' ? ' active' : ''}${dragClass(id)}`}
                title="Browse the project files — drag to reorder"
                style={dragStyle(id)}
                {...tabProps(id, () => store.setStageMode('files'))}
              >
                <Icon name="folder" />
                <span className="name">Files</span>
              </div>
            );
          }
          // R4 — the project's third face: memory rendered as its specification.
          if (id === SPEC_TAB) {
            return (
              <div
                key={id}
                className={`tab files${ui.stageMode === 'spec' ? ' active' : ''}${dragClass(id)}`}
                title="The project specification — every fact, its state and its source"
                style={dragStyle(id)}
                data-testid="spec-tab"
                {...tabProps(id, () => store.setStageMode('spec'))}
              >
                <Icon name="schedule" />
                <span className="name">Specification</span>
              </div>
            );
          }
          const s = data.sheets[id];
          // An open id whose sheet is not (yet) buildable — e.g. a section
          // whose parent drawing unloaded — must not take the strip down.
          if (!s) return null;
          const on = id === sheets.active && ui.stageMode === 'sheet';
          return (
            <div
              key={id}
              className={`tab${on ? ' active' : ''}${dragClass(id)}`}
              title={`${s.tab} — drag to reorder`}
              style={dragStyle(id)}
              {...tabProps(id, () => {
                if (!on) store.openSheet(id);
              })}
            >
              {on && <span className={`state ${s.grounded ? 'ok' : s.issues ? 'warn' : 'idle'}`} />}
              <span className="name">{s.tab}</span>
              {!on && <span className="count">{s.entities.toLocaleString('en-US')}</span>}
              <span
                className="x"
                role="button"
                aria-label={`Close ${s.tab}`}
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  store.closeSheet(id, s.tab);
                  toast(`Closed ${s.tab}.`);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    store.closeSheet(id, s.tab);
                  }
                }}
              >
                <Icon name="close" size={11} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="sheet-tools">
        <button type="button" className="ibtn" title="All open sheets" onClick={tabsMenu.toggle}>
          <Icon name="dots" />
        </button>
        {tabsMenu.open && tabsMenu.anchor && (
          <Menu
            anchor={tabsMenu.anchor}
            onClose={tabsMenu.close}
            align="right"
            items={[
              { kind: 'title', label: `${sheets.open.length} open sheet${sheets.open.length === 1 ? '' : 's'}` },
              ...sheets.open
                .filter((id) => data.sheets[id])
                .map((id) => ({
                  label: data.sheets[id].tab,
                  checked: id === sheets.active,
                  onSelect: () => store.openSheet(id),
                })),
              { kind: 'divider' as const },
              {
                label: 'Close the others',
                icon: 'close',
                disabled: sheets.open.length < 2,
                onSelect: () => {
                  sheets.open.filter((id) => id !== sheets.active).forEach((id) => store.closeSheet(id, data.sheets[id]?.tab));
                  toast('Closed every sheet but this one.');
                },
              },
            ]}
          />
        )}
        <span className="bar-sep" />
        <button type="button" className="ibtn" title="Zoom to fit · double-click the sheet" onClick={() => store.zoomFit()}>
          <Icon name="expand" />
        </button>
        <button
          type="button"
          className="pill mono"
          title="Zoom — scroll on the drawing, as far in or out as you like"
          onClick={zoomMenu.toggle}
        >
          {zoomLabel(view.zoom)}
        </button>
        {zoomMenu.open && zoomMenu.anchor && (
          <Menu
            anchor={zoomMenu.anchor}
            onClose={zoomMenu.close}
            align="right"
            items={[
              { kind: 'title', label: 'Zoom' },
              // Named stops, not a range: the wheel is unbounded, and a menu
              // that stopped at 400% used to be read as the ceiling.
              { kind: 'note', label: 'Scroll on the drawing to zoom — there is no floor or ceiling.' },
              { label: 'Fit', onSelect: () => store.zoomFit() },
              ...ZOOM_STOPS.map((k) => ({
                label: zoomLabel(k),
                checked: Math.abs(view.zoom - k) < k * 0.01,
                onSelect: () => store.setZoomPan(k, view.pan),
              })),
            ]}
          />
        )}
        <span className="bar-sep" />
        <button type="button" className="ibtn" title="Layers on this sheet" onClick={layersMenu.toggle}>
          <Icon name="layers" />
        </button>
        {layersMenu.open && layersMenu.anchor && (
          <Menu
            anchor={layersMenu.anchor}
            onClose={layersMenu.close}
            align="right"
            items={[
              { kind: 'title', label: 'Layers on this sheet' },
              ...Object.keys(LAYER_NAMES).map((id) => {
                const sheetLayers = layersFor(view, sheets.active);
                return {
                  label: LAYER_NAMES[id],
                  hint: id,
                  checked: sheetLayers[id] !== false,
                  keepOpen: true,
                  onSelect: () => store.setLayer(id, sheetLayers[id] === false, LAYER_NAMES[id]),
                };
              }),
            ]}
          />
        )}
        {/* What has been READ, outlined on the geometry it was read from. A
            coverage percentage cannot say which part it is about. */}
        <button
          type="button"
          className={`ibtn${view.sectionMarks ? ' on' : ''}`}
          data-testid="toggle-section-marks"
          aria-pressed={view.sectionMarks}
          title={
            view.sectionMarks
              ? 'Hide the read — the sections outlined on the drawing'
              : 'Show the read — every section outlined on the part it was read from'
          }
          onClick={() => store.setSectionMarks(!view.sectionMarks)}
        >
          <Icon name="section" />
        </button>
        <button
          type="button"
          className={`ibtn${view.isolate ? ' on' : ''}`}
          title="Isolate the selection"
          onClick={() => {
            store.setIsolate(!view.isolate);
            toast(view.isolate ? 'Isolation off.' : 'Everything but concrete, reinforcement and the selection dimmed.');
          }}
        >
          <Icon name="solo" />
        </button>
        <span className="bar-sep" />
        <button type="button" className="ibtn" title="Jump to an indexed panel" onClick={panelsMenu.toggle}>
          <Icon name="section" />
        </button>
        {panelsMenu.open && panelsMenu.anchor && (
          <Menu
            anchor={panelsMenu.anchor}
            onClose={panelsMenu.close}
            align="right"
            items={
              active && active.grounded && active.panels.length
                ? [
                    { kind: 'title', label: 'Indexed panels' },
                    ...active.panels.map((p) => ({
                      label: p,
                      onSelect: () => toast(`Panel jump — wired with the real panel index.`),
                    })),
                  ]
                : [
                    { kind: 'title', label: 'No panels indexed' },
                    { kind: 'note', label: 'This sheet has not been grounded, so it has no panel index yet.' },
                    { label: 'Ground this drawing', icon: 'sparkles', onSelect: () => toast('Grounding runs against the real engine.') },
                  ]
            }
          />
        )}
        <button type="button" className="ibtn" title="Find a mark on this sheet" onClick={findMenu.toggle}>
          <Icon name="search" />
        </button>
        {findMenu.open && findMenu.anchor && (
          <Popover anchor={findMenu.anchor} onClose={findMenu.close} align="right">
            <div className="pop-title">Find a mark</div>
            <div className="find-mark">
              <input
                autoFocus
                placeholder="C1, TB, F1…"
                aria-label="Find a mark on this sheet"
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && findQuery.trim()) {
                    const mark = findQuery.trim().toUpperCase();
                    store.setSelection({ memberId: mark, source: 'canvas' });
                    findMenu.close();
                    setFindQuery('');
                    toast(`Selected ${mark} on the sheet.`);
                  }
                }}
              />
            </div>
          </Popover>
        )}
        <button type="button" className="pill mono" title="Compare with another revision" onClick={revMenu.toggle}>
          {active?.rev ?? '—'}
        </button>
        {revMenu.open && revMenu.anchor && (
          <Menu
            anchor={revMenu.anchor}
            onClose={revMenu.close}
            align="right"
            items={[
              { kind: 'title', label: 'Revision' },
              { kind: 'note', label: 'Comparison reports a schedule delta once the engine lands — entity deltas alone mislead a checker.' },
              { label: 'Mark this revision superseded', icon: 'layers', onSelect: () => toast('Superseding files against the real register.') },
            ]}
          />
        )}
        {/* Only present when the sheet has a model behind it (§4.4). */}
        {active?.hasModel && (
          <>
            <span className="bar-sep" />
            <button type="button" className="pill" title="Show the model built from this sheet" onClick={() => store.setViewMode(view.mode === 'split' ? '2d' : 'split')}>
              Model
            </button>
          </>
        )}
      </div>
    </div>
  );
}
