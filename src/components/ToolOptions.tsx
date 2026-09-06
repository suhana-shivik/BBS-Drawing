// The arming row — what the active tool is armed WITH, under the strip that
// says which tool it IS.
//
// EDITOR_TOOLS_NOTE describes a tool set that is armed: §8.4 says the drafting
// primitives "carry a CAD layer name taken from `toolOptions.activeLayer`",
// §8.5 gives openings a size precedence of "catalogue item → tool option →
// DEFAULTS", and §8.6 makes the Library "an arming control rather than a
// browser". The controller reads all of it (`opt()`, `activeLayer()`,
// `openingSize()`), `src/editor/toolOptions.ts` tabulates it, and the store has
// held a `toolOptions` record all along — but NOTHING in the shell ever wrote
// a key. Every wall in the app was 230 mm, every primitive landed on layer "0",
// and two of the 22 tools could not be used at all: Furniture refused for want
// of a catalogue item nothing could arm, and Stair refused for want of a level
// above that nothing could add.
//
// This row is the missing half. Three rules hold it to the note:
//
//  * ONE TABLE. The fields come from `TOOL_OPTIONS[tool]`, the same table
//    `EditorController.opt()` resolves against, so a field the strip shows and
//    a number the geometry gets cannot be two different things (D3's lesson,
//    applied to options rather than names).
//  * THE PRECEDENCE IS VISIBLE. When a catalogue item is armed for the Door or
//    Window tool it OVERRIDES Width and Height (§8.5). The fields then show the
//    item's numbers and are disabled, saying why — rather than showing an
//    editable number the tool is going to ignore. "Pick an item…" opens the
//    Library (inside Ask) where the arming actually happens.
//  * NO KEYBOARD. Every control here is an <input> or a <button>; the
//    controller stands down inside editable targets (`isEditableTarget`), so
//    typing 230 into Thickness cannot arm the Beam tool. One keyboard owner
//    still (D1/D2).

import React, { useState } from 'react';
import { isToolId } from '../editor/tools';
import {
  ACTIVE_LAYER_KEY,
  DEFAULT_LAYER,
  LAYERED_TOOLS,
  TOOL_OPTIONS,
  activeLayerOf,
  clampOption,
  optNumber,
  type ToolOptionDef,
  type ToolOptionKey,
} from '../editor/toolOptions';
import { CATALOG, type CatalogItem } from '../library/catalog';
import {
  MAX_GRID,
  MIN_GRID,
  activeLevelIdOf,
  addLevelAbove,
  setGridSpacing,
  useEditorLevels,
  useEditorModel,
  useGridSpacing,
} from '../studio/editorHost';
import { DEFAULT_LAYERS, formatLength, useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { Menu, useMenuAnchor } from './Menu';
import { toast } from './Toasts';
import './ToolOptions.css';

/** The catalogue item armed for a tool, applying §8.5's category rule. */
export function armedItemFor(
  tool: string,
  catalogId: string | null,
): CatalogItem | null {
  if (!catalogId) return null;
  const item = CATALOG.find((c) => c.id === catalogId) ?? null;
  if (!item) return null;
  if (tool === 'door' || tool === 'window') return item.category === tool ? item : null;
  // Furniture places whatever is armed — the controller does not filter it,
  // and sanitary ware and structural parts are legitimate furniture blocks.
  return tool === 'furniture' ? item : null;
}

/** The option keys a catalogue item takes over, per `openingSize()`. */
function overriddenBy(tool: string, item: CatalogItem | null): ToolOptionKey[] {
  if (!item) return [];
  if (tool === 'door') return ['doorWidth', 'doorHeight'];
  if (tool === 'window') return ['windowWidth', 'windowHeight'];
  return [];
}

export function ToolOptions() {
  const store = useStudioStore();
  const { ui, editor, view } = useStudio((s) => ({ ui: s.ui, editor: s.editor, view: s.view }));
  const model = useEditorModel();
  const levels = useEditorLevels();
  const grid = useGridSpacing();
  const levelMenu = useMenuAnchor();

  const tool = isToolId(ui.activeTool) ? ui.activeTool : 'select';
  const defs = TOOL_OPTIONS[tool] ?? [];
  const layered = LAYERED_TOOLS.includes(tool);
  const armsCatalog = tool === 'door' || tool === 'window' || tool === 'furniture';
  const armed = armedItemFor(tool, editor.catalogId);
  const overridden = overriddenBy(tool, armed);

  const activeId = activeLevelIdOf(store.getState(), model);
  const activeLevel = levels.find((l) => l.id === activeId) ?? null;
  // §8.6 — the Stair tool refuses without one, and this is where you get it.
  const hasAbove = Boolean(activeLevel && levels.some((l) => l.elevation > activeLevel.elevation));

  /** What a field shows: the armed item's number when it owns the key. */
  const valueOf = (def: ToolOptionDef): number => {
    if (armed && overridden.includes(def.key)) {
      return def.key.endsWith('Height') ? armed.height : armed.width;
    }
    return optNumber(editor.toolOptions, def.key);
  };

  return (
    <div className="tooloptions" data-testid="tool-options" aria-label="Tool options">
      <button
        type="button"
        className="topt-level"
        data-testid="level-picker"
        title="The level every tool draws on"
        onClick={levelMenu.toggle}
      >
        <Icon name="layers" size={13} />
        <span className="lv-name">{activeLevel?.name ?? 'No level'}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {levelMenu.open && levelMenu.anchor && (
        <Menu
          anchor={levelMenu.anchor}
          onClose={levelMenu.close}
          above
          items={[
            { kind: 'title', label: 'Draw on level' },
            ...levels.map((l) => ({
              label: l.name,
              hint: `+${formatLength(l.elevation, view.unit)}`,
              checked: l.id === activeId,
              onSelect: () => store.setEditorLevel(l.id),
            })),
            { kind: 'divider' as const },
            {
              label: 'Add level above',
              // The Stair tool's own refusal names this action; when there is
              // already a storey above, it says so rather than going grey for
              // a reason the user has to guess.
              hint: hasAbove ? 'one already above' : undefined,
              onSelect: () => addLevelAbove(store, toast),
            },
          ]}
        />
      )}

      {(defs.length > 0 || layered || armsCatalog) && <span className="topt-sep" />}

      {defs.map((def) => {
        const owned = armed !== null && overridden.includes(def.key);
        return (
          <NumField
            key={def.key}
            label={def.label}
            value={valueOf(def)}
            disabled={owned}
            title={
              owned
                ? `${armed?.name} sets this — clear it in the Library tab to type a size`
                : `${def.label}, ${def.min}–${def.max} mm`
            }
            onCommit={(n) => store.setToolOption(def.key, clampOption(def, n))}
          />
        );
      })}

      {layered && (
        <label className="topt" title="New drafting geometry lands on this CAD layer (§8.4)">
          <span className="topt-l">Layer</span>
          <input
            className="topt-in mono wide"
            aria-label="Active layer"
            list="topt-layers"
            value={activeLayerOf(editor.toolOptions)}
            onChange={(e) =>
              store.setToolOption(ACTIVE_LAYER_KEY, e.target.value.trim() || DEFAULT_LAYER)
            }
          />
          <datalist id="topt-layers">
            {Object.keys(DEFAULT_LAYERS).map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
      )}

      {armsCatalog && (
        <span className="topt topt-cat">
          <span className="topt-l">Library</span>
          <button
            type="button"
            className={`topt-pick${armed ? ' armed' : ''}`}
            data-testid="armed-item"
            title={
              armed
                ? `${armed.name} — ${armed.width} × ${armed.depth} × ${armed.height} mm`
                : 'Pick an item in the Library tab to arm this tool'
            }
            onClick={() => store.setDockTab('library')}
          >
            {armed ? armed.name : 'Pick an item…'}
          </button>
          {armed && (
            <button
              type="button"
              className="topt-clear"
              aria-label="Clear the armed library item"
              title="Clear the armed item"
              onClick={() => store.setCatalogItem(null)}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      )}

      <span className="topt-tail">
        <label className="topt" title="What GRID snaps to — and how far an arrow key nudges">
          <span className="topt-l">Grid</span>
          <input
            className="topt-in num"
            aria-label="Grid spacing (mm)"
            inputMode="decimal"
            disabled={grid === null}
            value={grid ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= MIN_GRID && n <= MAX_GRID) setGridSpacing(n);
            }}
          />
          <span className="topt-u">mm</span>
        </label>
      </span>
    </div>
  );
}

/**
 * One armed number.
 *
 * It holds a DRAFT string while the field has focus, so a user clearing 230 to
 * type 115 is not fighting a clamp on every keystroke — the value is committed
 * (and clamped into the field's declared range) on blur or Enter. Escape
 * abandons the draft. `clampOption` is the editor's own function, so the floor
 * and ceiling the strip enforces are the ones the table declares.
 */
function NumField({
  label,
  value,
  disabled,
  title,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  title: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);

  const commit = (el: HTMLInputElement) => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() && Number.isFinite(n)) onCommit(n);
    el.blur();
  };

  return (
    <label className="topt" title={title}>
      <span className="topt-l">{label}</span>
      <input
        className="topt-in num"
        aria-label={`${label} (mm)`}
        inputMode="decimal"
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget);
          else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="topt-u">mm</span>
    </label>
  );
}
