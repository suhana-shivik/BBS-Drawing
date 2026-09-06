// The register (left column): a tree of the project — Drawings by discipline,
// Outputs, Attention. The folder count is the number of children; clicking a
// folder's NAME walks into it in the Files view, clicking its CHEVRON only
// expands it in place. Two gestures, two meanings (STUDIO_DESIGN §4.2).

import React, { useMemo, useRef, useState } from 'react';
import {
  countDrawings,
  folderPath,
  pathToFile,
  type RegisterFileNode,
  type RegisterFolderNode,
  type StudioActions,
  useStudioData,
} from '../studio/data';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { Menu, useMenuAnchor } from './Menu';
import { toast } from './Toasts';
import './RegisterPanel.css';

export const REGISTER_SEARCH_ID = 'register-search';

/**
 * Rename and Delete, on the folder's own row.
 *
 * Its own component because it holds a hook: one `useMenuAnchor` per row, so
 * two folders cannot share an open menu. Rendered only for the folders
 * `editableKind` allows, so a discipline folder carries no dead affordance.
 *
 * The actions come in as a prop rather than off `useStudioData()` — this
 * renders once per folder, and a subscription per row would re-render the
 * whole tree on every unrelated change to the register.
 */
function FolderActions({
  folder,
  kind,
  actions,
}: {
  folder: RegisterFolderNode;
  kind: 'user' | 'pdf';
  actions?: StudioActions;
}) {
  const menu = useMenuAnchor();

  const rename = () => {
    if (!actions) {
      toast('Rename lands with the real register.', 'warn');
      return;
    }
    const next = window.prompt(kind === 'user' ? 'Rename folder' : 'Rename PDF', folder.name);
    const trimmed = next?.trim();
    if (!trimmed || trimmed === folder.name) return;
    if (kind === 'user') actions.renameFolder(folder.id, trimmed);
    else actions.renamePdfBatch(folder.pdfBatchAt!, trimmed);
    toast(`Renamed to ${trimmed}.`, 'ok');
  };

  const remove = () => {
    if (!actions) {
      toast('Delete lands with the real register.', 'warn');
      return;
    }
    if (kind === 'user') {
      // No confirmation, and that is not an oversight: a folder someone made
      // is a LABEL. Deleting it removes the label — every drawing filed under
      // it stays in the register and in every derived view it belonged to —
      // so there is nothing to warn about. `deleteFolder` says so itself.
      actions.deleteFolder(folder.id);
      return;
    }
    // A PDF's Pages/ folder IS the imported file, so this one really does take
    // its contents with it.
    if (!window.confirm(`Delete "${folder.name}"? Every page in it goes with it.`)) return;
    actions.deletePdfBatch(folder.pdfBatchAt!);
    toast(`Deleted ${folder.name}.`, 'ok');
  };

  return (
    <>
      <button
        type="button"
        className="row-menu ibtn"
        aria-label={`Actions for ${folder.name}`}
        aria-expanded={menu.open}
        title={`Rename or delete ${folder.name}`}
        data-testid={`folder-menu-${folder.id}`}
        onClick={menu.toggle}
      >
        <Icon name="dots" size={13} />
      </button>
      {menu.open && menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          align="right"
          items={[
            { label: 'Rename…', icon: 'pencil', onSelect: rename },
            { kind: 'divider' },
            {
              label: 'Delete',
              icon: 'trash',
              title:
                kind === 'user'
                  ? 'Removes the folder only — the drawings in it stay in the register'
                  : 'Removes every page of this PDF',
              onSelect: remove,
            },
          ]}
        />
      )}
    </>
  );
}

function fileMatches(node: RegisterFileNode, q: string): boolean {
  return node.name.toLowerCase().includes(q);
}

function folderHasMatch(folder: RegisterFolderNode, q: string): boolean {
  if (folder.name.toLowerCase().includes(q)) return true;
  return folder.children.some((c) =>
    c.kind === 'file' ? fileMatches(c, q) : folderHasMatch(c, q),
  );
}

/**
 * WHICH FOLDERS HAVE A NAME ANYONE MAY CHANGE.
 *
 * A folder a person made ("demofolder", "WH-4 package") is a label they own,
 * and a multi-page PDF's Pages/ folder IS the imported file — those two can be
 * renamed and deleted. Everything else in this tree is DERIVED: "Structural"
 * is a consequence of what its drawings are, "BBS" is a consequence of what
 * has been filed, and renaming either would be renaming a fact about the
 * drawings rather than a folder. So they get no menu at all, rather than a
 * disabled one on every row.
 *
 * The same rule the Files toolbar applies to its Rename/Delete buttons —
 * stated here rather than re-derived, because two rules that drift would mean
 * a folder the tree lets you delete and the Files view does not.
 */
function editableKind(folder: RegisterFolderNode): 'user' | 'pdf' | null {
  if (folder.userMade) return 'user';
  if (typeof folder.pdfBatchAt === 'number') return 'pdf';
  return null;
}

export function RegisterPanel() {
  const data = useStudioData();
  const store = useStudioStore();
  const activeSheet = useStudio((s) => s.sheets.active);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    'f-str': true,
    'f-mep': true,
    'f-bbs': true,
  });
  const paneRef = useRef<HTMLElement>(null);

  const drawings = useMemo(() => countDrawings(data), [data]);
  const q = query.trim().toLowerCase();

  const toggleFolder = (id: string) =>
    setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const walkIntoFolder = (folder: RegisterFolderNode) => {
    setExpanded((e) => ({ ...e, [folder.id]: true }));
    store.browseTo(folderPath(data, folder.id));
  };

  const openFile = (file: RegisterFileNode) => {
    const located = pathToFile(data, file.id);
    if (located) store.revealInBrowser(located.path, file.id);
    if (file.sheetId) {
      store.openSheet(file.sheetId);
      return;
    }
    // A filed output opens the version that was clicked, not the newest one.
    if (file.artifactId) {
      store.setStageMode('sheet');
      store.openArtifact(file.artifactId);
      toast(`Opened ${file.name} — download it from the panel.`);
      return;
    }
    if (file.dockTab) {
      store.setStageMode('sheet');
      store.setDockTab(file.dockTab);
      toast(`Opened ${file.name} in the dock.`);
      return;
    }
    // An unparsed entry: show what is on file in Details.
    store.setDockTab('details');
    toast(`${file.name} is filed but not parsed — nothing to draw from it yet.`);
  };

  const renderFile = (file: RegisterFileNode, depth: number) => {
    if (q && !fileMatches(file, q)) return null;
    const active = !!file.sheetId && file.sheetId === activeSheet;
    return (
      <button
        key={file.id}
        type="button"
        className={`node file${active ? ' active' : ''}`}
        style={{ paddingLeft: 10 + depth * 13 + 15 }}
        onClick={() => openFile(file)}
      >
        <span className="glyph"><Icon name="file" size={14} /></span>
        <span className="label">{file.name}</span>
        {file.rev ? <span className={`rev${file.current ? ' current' : ''}`}>{file.rev}</span> : null}
        {file.tag ? <span className="rev">{file.tag}</span> : null}
        <span className={`state ${file.state}`} />
      </button>
    );
  };

  const renderFolder = (folder: RegisterFolderNode, depth: number): React.ReactNode => {
    if (q && !folderHasMatch(folder, q)) return null;
    const open = q ? true : !!expanded[folder.id];
    const editable = editableKind(folder);
    return (
      <React.Fragment key={folder.id}>
        <div
          className="node folder"
          role="treeitem"
          aria-expanded={open}
          style={{ paddingLeft: 10 + depth * 13 }}
        >
          <button
            type="button"
            className="twist"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
            onClick={() => toggleFolder(folder.id)}
          >
            <Icon name="chevronRight" size={12} />
          </button>
          <button
            type="button"
            className="folder-name"
            aria-label={`Open ${folder.name} in Files`}
            title={`Open ${folder.name} in Files`}
            onClick={() => walkIntoFolder(folder)}
          >
            <span className="glyph"><Icon name={folder.icon ?? 'folder'} size={14} /></span>
            <span className="label">{folder.name}</span>
          </button>
          {editable && <FolderActions folder={folder} kind={editable} actions={data.actions} />}
          {/* The count IS the children — it cannot drift from what the folder holds. */}
          <span className="count" data-testid={`count-${folder.id}`}>{folder.children.length}</span>
        </div>
        <div className="kids" hidden={!open}>
          {folder.children.map((c) =>
            c.kind === 'folder' ? renderFolder(c, depth + 1) : renderFile(c, depth + 1),
          )}
        </div>
      </React.Fragment>
    );
  };

  return (
    <aside className="tree-pane" aria-label="Project register" ref={paneRef}>
      <div className="pane-head">
        <span className="pane-title">Register</span>
        <button
          type="button"
          className="ibtn"
          title="Import drawing (DXF / DWG / PDF)"
          onClick={() =>
            data.actions
              ? data.actions.importDrawing()
              : toast('Import lands in the register — wired when the CAD pipeline arrives.')
          }
        >
          <Icon name="upload" />
        </button>
        <button type="button" className="ibtn" title="Filter by discipline" onClick={() => toast('Discipline filter — wired with the real register.')}>
          <Icon name="filter" />
        </button>
      </div>
      <div className="search">
        <label className="search-box">
          <span className="search-glyph"><Icon name="search" size={14} /></span>
          <input
            id={REGISTER_SEARCH_ID}
            type="search"
            placeholder="Find a drawing or mark"
            aria-label="Find a drawing or mark"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="tree" role="tree" aria-label="Register tree">
        {data.groups.map((g) => {
          const folders = g.folders.map((f) => renderFolder(f, 0)).filter(Boolean);
          if (q && !folders.length) return null;
          return (
            <React.Fragment key={g.id}>
              {!q && <div className="tree-group">{g.name}</div>}
              {folders}
            </React.Fragment>
          );
        })}
      </div>
      <ResizeHandle side="right" />
      <div className="tree-foot">
        <span className="state ok" />
        <span>{drawings} drawings</span>
      </div>
    </aside>
  );
}

/** Drag the inner edge; register 180–460, dock 320–720; double-click resets. */
export function ResizeHandle({ side }: { side: 'left' | 'right' }) {
  const store = useStudioStore();
  const which = side === 'right' ? 'tree' : 'dock';
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const parent = grip.parentElement;
    const start = parent ? parent.getBoundingClientRect().width : 0;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const d = ev.clientX - startX;
      if (which === 'tree') store.setTreeWidth(start + d);
      else store.setDockWidth(start - d);
    };
    const up = () => {
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`resizer ${side}`}
      data-resize={which}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        if (which === 'tree') store.setTreeWidth(268);
        else store.setDockWidth(400);
        toast(`${which === 'tree' ? 'Register' : 'Detail'} panel reset.`);
      }}
    />
  );
}
