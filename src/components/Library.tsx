// The Library — the catalogue the drafting tools are armed FROM. It opens
// from the Library chip inside Ask, not on a tab of its own: arming a tool is
// something you do in the middle of working on a drawing, and the dock's tab
// strip is down to the two faces a drawing has — what it IS, and asking about
// it.
//
// EDITOR_TOOLS_NOTE §8.6: "Furniture requires `activeCatalogId` and refuses
// with 'Pick an item from the Library tab', which is what makes the Library
// an arming control rather than a browser." There was no Library at all. The
// catalogue existed (src/library/catalog.ts, 26 items), the store held an
// armed id, `EditorHost.catalogItem()` resolved it and the controller read it
// — and no surface could set it, so the sentence pointed nowhere and the
// Furniture tool could never place anything at all.
//
// Two things this panel does, and a third it deliberately does not:
//
//  * IT ARMS, IT DOES NOT PLACE. Picking an item selects the tool that uses it
//    and nothing more; the click that makes geometry is still on the canvas.
//    That is the distinction §8.6 draws, and the copy at the top says it.
//  * IT SHOWS THE PRECEDENCE. A door item's size overrides the Door tool's
//    Width and Height fields (§8.5), so the card prints the numbers that will
//    actually be built.
//  * It does NOT filter itself by the active tool. Arming is how you get to a
//    tool, not something you do after choosing one — a list that emptied
//    itself under the Select tool would hide the way in.

import React from 'react';
import { CATALOG, type CatalogItem } from '../library/catalog';
import type { ToolId } from '../editor/tools';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import './Library.css';

/** Which tool an item arms — the same rule `openingSize()` applies (§8.5). */
export function toolForItem(item: CatalogItem): ToolId {
  if (item.category === 'door') return 'door';
  if (item.category === 'window') return 'window';
  return 'furniture';
}

const GROUPS: { category: CatalogItem['category']; label: string }[] = [
  { category: 'door', label: 'Doors' },
  { category: 'window', label: 'Windows' },
  { category: 'furniture', label: 'Furniture' },
  { category: 'sanitary', label: 'Sanitary' },
  { category: 'structural', label: 'Structural' },
];

const ARMS: Record<ToolId | string, string> = {
  door: 'Arms the Door tool · sets the leaf size',
  window: 'Arms the Window tool · sets the unit size',
  furniture: 'Arms the Furniture tool · placed as a block',
};

export function LibraryPanel() {
  const store = useStudioStore();
  const armedId = useStudio((s) => s.editor.catalogId);

  const arm = (item: CatalogItem) => {
    if (armedId === item.id) {
      store.setCatalogItem(null);
      return;
    }
    store.setCatalogItem(item.id);
    // Arming is how a tool becomes usable, so it selects that tool. The
    // Furniture tool cannot place without this; the Door and Window tools
    // place a different size with it.
    store.setActiveTool(toolForItem(item));
  };

  return (
    <div className="library" data-testid="library">
      <div className="lib-head">
        <h2 className="lib-title">Library</h2>
        <p className="lib-sub">
          Picking an item <b>arms</b> the tool that places it — it draws nothing on its own.
          Doors and windows take the item&apos;s size in place of the strip&apos;s Width and
          Height; Furniture will not place at all until something here is picked.
        </p>
      </div>

      {GROUPS.map((group) => {
        const items = CATALOG.filter((c) => c.category === group.category);
        if (!items.length) return null;
        return (
          <section key={group.category} className="lib-group">
            <div className="lib-group-head">
              <span className="lib-group-name">{group.label}</span>
              <span className="lib-group-arms">{ARMS[toolForItem(items[0])]}</span>
            </div>
            <div className="lib-grid">
              {items.map((item) => {
                const armed = armedId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`lib-item${armed ? ' armed' : ''}`}
                    aria-pressed={armed}
                    aria-label={item.name}
                    title={armed ? 'Armed — click to clear' : `Arm the ${toolForItem(item)} tool with this`}
                    onClick={() => arm(item)}
                  >
                    <span className="li-top">
                      <Icon name={toolForItem(item)} size={14} />
                      <span className="li-name">{item.name}</span>
                      {armed && <span className="li-armed">armed</span>}
                    </span>
                    <span className="li-dims mono">
                      {item.width} × {item.depth} × {item.height} mm
                    </span>
                    {item.description && <span className="li-desc">{item.description}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
