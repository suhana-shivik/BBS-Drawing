// Status bar — the stage's 26px footer band, mode-aware (§4.7). On a sheet:
// coordinates, hint, active tool, snaps, entity counts, display unit. Browsing
// files: the folder and its item count — the canvas readouts mean nothing in a
// folder, so they are hidden, not zeroed.
//
// §11 — THE HINT LINE IS NOT COMPOSED HERE. `hintFor()` in the editor
// controller writes it, per tool AND per phase, and publishes it; this bar
// subscribes and renders the string. That is what carries the live Measure
// distance, the CAD hover hint ("POLYLINE on RBAR, 4,180 mm") and the typed
// precision buffer ("Coordinate: 500a90 — Enter confirms · Esc back to mouse")
// without this file knowing any of them exist.
//
// The one sentence this file DOES own is the notice beside it, and it is about
// the SURFACE, not the tool: no model open, no level, a raster PDF page. §12 —
// a CAD sheet is an underlay and tools create BIM elements; where the project
// lacks what the strip implies, the sentence has to reach the user.
//
// D3: `toolName` comes from src/editor/tools.ts, which is total over ToolId, so
// the bar can name all 22 tools and can never fall through to a raw id again.

import React from 'react';
import { toolName } from '../editor/tools';
import { findFolder, useStudioData } from '../studio/data';
import {
  NO_SNAP_HOME,
  editorNotice,
  setSnapFlag,
  useEditorModel,
  useEditorStatus,
  useSnapFlags,
} from '../studio/editorHost';
import { formatLength, useCursor, useStudio, useStudioStore } from '../studio/store';
import { Menu, useMenuAnchor } from './Menu';
import { toast } from './Toasts';
import './StatusBar.css';

export function StatusBar() {
  const data = useStudioData();
  const store = useStudioStore();
  const { ui, sheets, view, browse } = useStudio((s) => ({
    ui: s.ui,
    sheets: s.sheets,
    view: s.view,
    browse: s.browse,
  }));
  const cursor = useCursor();
  const status = useEditorStatus();
  const snaps = useSnapFlags();
  const model = useEditorModel();
  const unitMenu = useMenuAnchor();

  const browsing = ui.stageMode === 'files';
  const sheet = sheets.active ? data.sheets[sheets.active] : null;

  if (browsing) {
    const folder = browse.path.length ? findFolder(data, browse.path[browse.path.length - 1]) : null;
    const count = folder
      ? folder.children.length
      : data.groups.reduce((n, g) => n + g.folders.length, 0);
    return (
      <div className="status" data-testid="status-bar">
        <span>
          {count} item{count === 1 ? '' : 's'} in {folder?.name ?? 'Files'}
        </span>
        <span className="spring" />
      </div>
    );
  }

  // The post-snap cursor wins when the editor is live — a tool never sees the
  // raw pointer (§4), so the readout must not either.
  const at = status.cursor ?? (cursor ? { x: cursor.xMm, y: cursor.yMm } : null);
  // `hasModel` is about the 3D model behind a sheet (SheetStrip's Model
  // control) — NOT about CAD geometry, and it is false on every DXF sheet. Read
  // as "hasGeometry" it told every drawing in the project it was a raster PDF
  // page while the bar beside it counted three thousand entities. The entity
  // count IS the question being asked.
  const notice = editorNotice(
    { open: Boolean(sheet), hasGeometry: (sheet?.entities ?? 0) > 0 },
    model,
  );
  const hint = status.hint || 'Drag to pan · scroll to zoom';
  const elements = model ? model.all().length : 0;

  const toggleSnap = (which: 'grid' | 'objects', on: boolean) => {
    if (!setSnapFlag(which, on)) toast(NO_SNAP_HOME, 'warn');
  };

  return (
    <div className="status" data-testid="status-bar">
      <span className="coord">X {at ? formatLength(at.x, view.unit) : '—'}</span>
      <span className="coord">Y {at ? formatLength(at.y, view.unit) : '—'}</span>
      <span className="hint" data-testid="tool-hint">
        {hint}
      </span>
      {notice && (
        <span className="note" data-testid="editor-notice">
          {notice}
        </span>
      )}
      <span className="spring" />
      <span className="chip mono" data-testid="active-tool">
        {toolName(ui.activeTool)}
      </span>
      <button
        type="button"
        className={`chip${snaps.grid ? ' on' : ''}`}
        disabled={!snaps.available}
        title={snaps.available ? 'Grid snap — a project setting' : NO_SNAP_HOME}
        onClick={() => toggleSnap('grid', !snaps.grid)}
      >
        GRID
      </button>
      <button
        type="button"
        className={`chip${snaps.objects ? ' on' : ''}`}
        disabled={!snaps.available}
        title={snaps.available ? 'Object snap — a project setting' : NO_SNAP_HOME}
        onClick={() => toggleSnap('objects', !snaps.objects)}
      >
        OSNAP
      </button>
      <span className="chip mono">
        {sheets.open.length} sheet{sheets.open.length === 1 ? '' : 's'} · {sheet ? 1 : 0} rendered
      </span>
      <span className="chip mono">
        {/* Two counts, two meanings: the underlay's entities are NOT model
            elements, and a tool never turns one into the other (§12). */}
        {sheet
          ? `${sheet.entities.toLocaleString('en-US')} entities · ${elements} element${elements === 1 ? '' : 's'}`
          : 'no sheet'}
      </span>
      <span className="bar-sep" />
      <button
        type="button"
        className={`chip issues${sheet?.issues ? ' warn' : ' ok'}`}
        title="Sheet issues"
        onClick={() => toast(sheet?.issues ? `${sheet.issues} issues on this sheet.` : 'No issues.', sheet?.issues ? 'warn' : 'ok')}
      >
        {sheet?.issues ?? 0}
      </button>
      <button type="button" className="chip mono" title="Display unit" onClick={unitMenu.toggle}>
        {view.unit}
      </button>
      {unitMenu.open && unitMenu.anchor && (
        <Menu
          anchor={unitMenu.anchor}
          onClose={unitMenu.close}
          align="right"
          above
          items={[
            { kind: 'title', label: 'Display unit' },
            ...(['mm', 'm', 'ft-in'] as const).map((u) => ({
              label: u,
              checked: view.unit === u,
              onSelect: () => {
                store.setUnit(u);
                toast(`Lengths now shown in ${u} — geometry is unchanged.`);
              },
            })),
          ]}
        />
      )}
    </div>
  );
}
