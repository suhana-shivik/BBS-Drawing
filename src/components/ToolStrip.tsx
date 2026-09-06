// Tool strip — the 22 drafting tools in their six groups plus the two snap
// flags, below the drawing because that is the only place they apply (§4.6).
// Collapsed, it keeps its handle, the active tool name and the snap flags —
// nothing closes without leaving a way back.
//
// DEFECT D3 (EDITOR_TOOLS_NOTE §13): this file used to carry its own
// [id, name, key] table and the status bar carried a second one that was eight
// tools short. Both now read `src/editor/tools.ts`, which is total over ToolId
// — there is nowhere left for the two to disagree.
//
// DEFECT D1/D2: this strip renders TOOL_DEFS[].key for its tooltips and binds
// NO keyboard listener. The EditorController is the single keyboard owner.
//
// DEFECT D4: the strip is collapsed by default (src/studio/store.ts), which is
// what its own copy has always claimed — this is not primarily a drawing tool.
// And with no drawing open it does not render: the tools have no surface to
// apply to in the file browser or the Specification (§4.6).
//
// §14.3: GRID and OSNAP are `model.settings`, read and written through the
// editor host. With no model open they are disabled and say why, rather than
// toggling a UI flag that means nothing.
//
// Under the icons, open, sits the ARMING row (ToolOptions.tsx): the level the
// tools draw on, the numbers the active tool is armed with, its CAD layer and
// its catalogue item. The strip says which tool; that row says what with. It
// needs a model to arm anything, so it appears with one and not before.

import React from 'react';
import { TOOL_GROUPS, toolName } from '../editor/tools';
import {
  NO_SNAP_HOME,
  deleteEditorSelection,
  setSnapFlag,
  useSnapFlags,
} from '../studio/editorHost';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { toast } from './Toasts';
import { ToolOptions } from './ToolOptions';
import './ToolStrip.css';

export function ToolStrip() {
  const store = useStudioStore();
  const { ui, sheets, editor, history } = useStudio((s) => ({
    ui: s.ui,
    sheets: s.sheets,
    editor: s.editor,
    history: s.history,
  }));
  const snaps = useSnapFlags();
  const selectedCount = editor.selectedIds.length;
  const lastEdit = history.past[history.past.length - 1];

  // The tools apply to one surface only: an open drawing. Browsing files or
  // reading the Specification, the strip has nothing to act on, so it is not
  // there at all — the stage row collapses and the footer band closes up.
  const drawingOpen = ui.stageMode === 'sheet' && Boolean(sheets.active);

  const toggleSnap = (which: 'grid' | 'objects', on: boolean) => {
    if (!setSnapFlag(which, on)) toast(NO_SNAP_HOME, 'warn');
  };

  if (!drawingOpen) return null;

  return (
    <div className="toolbar">
      <div className={`toolstrip${ui.toolsOpen ? '' : ' collapsed'}`} aria-label="Drawing tools">
        <button
          type="button"
          className="strip-handle"
          aria-expanded={ui.toolsOpen}
          title="Drafting tools — hidden by default, because this is not primarily a drawing tool"
          onClick={() => store.toggleTools()}
        >
          <span className="chev">
            <Icon name="chevronDown" />
          </span>
          <span className="cap">Tools</span>
        </button>

        {!ui.toolsOpen && (
          <span className="strip-active">
            Active <b>{toolName(ui.activeTool)}</b>
          </span>
        )}

        {ui.toolsOpen &&
          TOOL_GROUPS.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 && <span className="strip-sep" />}
              {group.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="tool"
                  title={`${t.name} · ${t.key}`}
                  aria-label={t.name}
                  aria-pressed={ui.activeTool === t.id}
                  onClick={() => store.setActiveTool(t.id)}
                >
                  <Icon name={t.icon} />
                </button>
              ))}
            </React.Fragment>
          ))}

        <span className="strip-tail">
          {/* Drawn geometry has to be removable from the surface it was drawn
              on. Both keys existed (Ctrl+Z, Del) and neither had a control, so
              a line put down by accident looked permanent. Same command stack
              as the keys — one visible history, one Ctrl+Z. */}
          <button
            type="button"
            className="strip-act"
            disabled={!lastEdit}
            data-testid="strip-undo"
            title={lastEdit ? `Undo — ${lastEdit.label} · Ctrl+Z` : 'Nothing to undo'}
            onClick={() => {
              const label = store.undo();
              toast(label ? `Undid ${label}.` : 'Nothing to undo.', label ? 'ok' : 'warn');
            }}
          >
            <Icon name="history" size={14} /> UNDO
          </button>
          <button
            type="button"
            className="strip-act"
            disabled={selectedCount === 0}
            data-testid="strip-delete"
            title={
              selectedCount
                ? `Delete ${selectedCount} selected element${selectedCount === 1 ? '' : 's'} · Del`
                : 'Select what you drew first — click it with the Select tool (V)'
            }
            onClick={() => deleteEditorSelection(store, toast)}
          >
            <Icon name="trash" size={14} /> DELETE
          </button>
          <span className="strip-sep" />
          <button
            type="button"
            className={`snap${snaps.grid ? ' on' : ''}`}
            aria-label="Grid snap"
            aria-pressed={snaps.grid}
            disabled={!snaps.available}
            title={snaps.available ? 'Grid snap — a project setting' : NO_SNAP_HOME}
            onClick={() => toggleSnap('grid', !snaps.grid)}
          >
            <Icon name="grid" size={14} /> GRID
          </button>
          <button
            type="button"
            className={`snap${snaps.objects ? ' on' : ''}`}
            aria-label="Object snap"
            aria-pressed={snaps.objects}
            disabled={!snaps.available}
            title={snaps.available ? 'Object snap — a project setting' : NO_SNAP_HOME}
            onClick={() => toggleSnap('objects', !snaps.objects)}
          >
            <Icon name="magnet" size={14} /> OSNAP
          </button>
        </span>
      </div>
      {ui.toolsOpen && snaps.available && <ToolOptions />}
    </div>
  );
}
