// The shell — title bar over four grid columns: register · stage · dock · the
// rail the dock leaves behind. Collapsing sets a column to 0; it NEVER removes
// the element (display:none re-maps every grid column after it — §10).

import React, { useEffect } from 'react';
import { useStudioData } from '../studio/data';
import { dockIsOpen, useStudio, useStudioStore } from '../studio/store';
import { CommandPalette } from './CommandPalette';
import { BbsEditorHost } from './BbsEditorHost';
import { Dock } from './Dock';
import { FilesView } from './FilesView';
import { RegisterPanel, REGISTER_SEARCH_ID } from './RegisterPanel';
import { SheetStrip } from './SheetStrip';
import { SpecificationView } from './SpecificationView';
import { StatusBar } from './StatusBar';
import { ToolStrip } from './ToolStrip';
import { TitleBar } from './TitleBar';
import { Toasts, toast } from './Toasts';
import { Viewport } from './Viewport';
import './shell.css';

export function StudioShell() {
  const store = useStudioStore();
  const data = useStudioData();
  const ui = useStudio((s) => s.ui);
  const activeSheetId = useStudio((s) => s.sheets.active);

  // Theme is stamped on the root so token redefinition does the whole job.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', ui.theme);
  }, [ui.theme]);

  // R1 — the window title always names the project: <drawing> — <project> —
  // BIMCAD Studio, dropping the drawing part when nothing is open.
  const activeSheetTab = activeSheetId ? data.sheets[activeSheetId]?.tab : undefined;
  useEffect(() => {
    document.title = [activeSheetTab, data.projectName, 'BIMCAD Studio']
      .filter(Boolean)
      .join(' — ');
  }, [activeSheetTab, data.projectName]);

  // Keyboard (§5) — suppressed while typing.
  //
  // DEFECTS D1/D2 (EDITOR_TOOLS_NOTE §13, §14.2): this handler used to end
  // with a bare-letter branch that mapped `l` → Line, `r` → Room and so on. It
  // is GONE. Two window/document listeners racing over the same press is the
  // whole root cause of both defects: `r` rotated a stair ghost in the editor
  // AND switched to the Room tool here, and a `w` typed halfway through a
  // coordinate changed the tool mid-entry, because `preventDefault` does
  // nothing to a sibling listener.
  //
  // The EditorController is now the single keyboard owner: it listens at the
  // window in the CAPTURE phase (first in the propagation path, whoever
  // registered first) and calls `stopImmediatePropagation()` on every key it
  // consumes — tool letters included. What is left here is what the editor
  // never claims: the palette, the switcher, the register search, save, and
  // undo/redo for when no model is open (with one open the controller takes
  // Ctrl+Z and routes it to the SAME visible history stack, via the host).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        const label = store.undo();
        if (label) toast(`Undid ${label}.`);
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault();
        const label = store.redo();
        if (label) toast(`Redid ${label}.`);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toast('Project saved.', 'ok');
        return;
      }
      // R1 — Ctrl+P opens the project switcher in the title bar.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        store.setSwitcherOpen(!store.getState().ui.switcherOpen);
        return;
      }
      // R6 — Ctrl+K opens the command palette over the project index.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.setPaletteOpen(!store.getState().ui.paletteOpen);
        return;
      }
      if (e.key === 'Escape' && !typing) {
        store.clearSelection();
        return;
      }
      if (typing) return; // everything below is a bare-letter shortcut
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        if (!store.getState().ui.treeOpen) store.toggleTree();
        document.getElementById(REGISTER_SEARCH_ID)?.focus();
      }
      // No tool letters here. See the note above the effect (D1/D2).
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store]);

  const workbenchClass = [
    'workbench',
    ui.treeOpen ? '' : 'tree-closed',
    dockIsOpen(ui) ? '' : 'dock-closed',
    // Maximized OVERRIDES both — it collapses the columns without writing the
    // open flags, so minimizing hands back the panels the user had (§9).
    ui.maximized ? 'maximized' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`studio app${ui.maximized ? ' maximized' : ''}`}>
      <TitleBar />
      <div
        className={workbenchClass}
        data-testid="workbench"
        style={
          {
            '--w-tree': `${ui.treeWidth}px`,
            '--w-dock': `${ui.dockWidth}px`,
          } as React.CSSProperties
        }
      >
        {/* 1 · register */}
        <RegisterPanel />

        {/* 2 · stage: header band 35 / content / tool strip / footer band 26 */}
        <main className={`stage${ui.toolsOpen ? '' : ' tools-hidden'}`} aria-label="Drawing">
          <SheetStrip />
          <div className="stage-body">
            {/* All three live in the same grid row; [hidden] swaps them. The
                [hidden]{display:none} rule is restated in FilesView.css. */}
            <div hidden={ui.stageMode !== 'files'} className="stage-fill">
              <FilesView />
            </div>
            <div hidden={ui.stageMode !== 'spec'} className="stage-fill">
              {/* R4 — the Specification: the project's third face (§10 q5). */}
              {ui.stageMode === 'spec' && <SpecificationView />}
            </div>
            <div hidden={ui.stageMode !== 'sheet'} className="stage-fill">
              <Viewport />
            </div>
          </div>
          <ToolStrip />
          <StatusBar />
        </main>

        {/* 3 · dock */}
        <Dock />

        {/* 4 · the rail the dock leaves behind — the way back (§3). It names
            whatever the dock is on this face: the assistant, or the detail. */}
        <div className="dock-rail" data-testid="dock-rail">
          <button type="button" onClick={() => store.toggleDock()}>
            {ui.stageMode === 'sheet' ? 'Assistant' : 'Detail'}
          </button>
        </div>
      </div>
      {ui.paletteOpen && <CommandPalette />}
      {ui.bbsEditorArtifactId && <BbsEditorHost artifactId={ui.bbsEditorArtifactId} />}
      <Toasts />
    </div>
  );
}
