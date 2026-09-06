// The Files view — the register as a browser (STUDIO_DESIGN §4.3). It takes
// the viewport's place in the stage grid; it is not an overlay. At the root,
// folders are grouped exactly as the register groups them: two views of one
// project must not disagree about its shape.
//
// It reads as a file manager because that is what it is: a details list whose
// column headers ARE the sort control, a toolbar of verbs, and a properties
// pane in the dock. Everything it states about a node comes from
// src/studio/browse.ts, so the row and the pane cannot drift apart.

import React, { useEffect, useMemo, useRef } from 'react';
import {
  compareNodes,
  dateLine,
  disciplineOf,
  drawingNumber,
  extOf,
  revisionOf,
  sizeLine,
  statusLabel,
  typeLabel,
} from '../studio/browse';
import {
  findFolder,
  type RegisterFileNode,
  type RegisterFolderNode,
  type RegisterNode,
  useStudioData,
} from '../studio/data';
import { useStudio, useStudioStore, type BrowseSort } from '../studio/store';
import { Icon } from './icons';
import { Menu, useMenuAnchor } from './Menu';
import { toast } from './Toasts';
import './FilesView.css';

/** The details list, left to right. `sort` is the column's sort key (§4.3). */
const COLUMNS: { sort: BrowseSort; label: string; cls?: string }[] = [
  { sort: 'name', label: 'Name' },
  { sort: 'rev', label: 'Rev' },
  { sort: 'number', label: 'Drawing no.' },
  { sort: 'type', label: 'Type' },
  { sort: 'discipline', label: 'Discipline' },
  { sort: 'size', label: 'Size', cls: 'num' },
  { sort: 'status', label: 'Status' },
  { sort: 'date', label: 'Added' },
];

export function FilesView() {
  const data = useStudioData();
  const store = useStudioStore();
  const browse = useStudio((s) => s.browse);
  const bodyRef = useRef<HTMLDivElement>(null);

  const atRoot = browse.path.length === 0;
  const folder = atRoot ? null : findFolder(data, browse.path[browse.path.length - 1]);

  const items = useMemo<RegisterNode[]>(() => {
    let list: RegisterNode[] = atRoot
      ? data.groups.flatMap((g) => g.folders)
      : folder?.children ?? [];
    const q = browse.query.trim().toLowerCase();
    if (q) {
      list = list.filter((n) =>
        (n.kind === 'folder' ? n.name : n.name).toLowerCase().includes(q),
      );
    }
    if (!atRoot || q || browse.view === 'details') {
      list = [...list].sort((a, b) => compareNodes(data, a, b, browse.sort, browse.desc));
    }
    return list;
  }, [data, atRoot, folder, browse.query, browse.sort, browse.desc, browse.view]);

  // Reveal: locate() from the register selects the item and scrolls it into view.
  useEffect(() => {
    if (!browse.reveal) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-node="${browse.reveal}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
    store.clearReveal();
  }, [browse.reveal, store]);

  const openItem = (n: RegisterNode) => {
    if (n.kind === 'folder') {
      store.browseTo(atRoot ? pathFromRoot(data, n.id) : [...browse.path, n.id]);
      return;
    }
    if (n.sheetId) {
      store.openSheet(n.sheetId);
      return;
    }
    if (n.artifactId) {
      store.setStageMode('sheet');
      store.openArtifact(n.artifactId);
      toast(`Opened ${n.name} — download it from the panel.`);
      return;
    }
    if (n.dockTab) {
      store.setStageMode('sheet');
      store.setDockTab(n.dockTab);
      toast(`Opened ${n.name} in the dock.`);
      return;
    }
    toast(`${n.name} opens outside the studio.`);
  };

  // Selection repaints in place — re-rendering the grid on the first click
  // would replace the element under the pointer and the browser would never
  // fire the dblclick that opens it. React keys keep elements stable here.
  const onItemClick = (e: React.MouseEvent, n: RegisterNode) => {
    const id = n.kind === 'folder' ? n.id : n.id;
    if (e.ctrlKey || e.metaKey) {
      store.setBrowseSelection(
        browse.selection.includes(id)
          ? browse.selection.filter((s) => s !== id)
          : [...browse.selection, id],
      );
    } else {
      store.setBrowseSelection([id]);
    }
  };

  const selected = (id: string) => browse.selection.includes(id);
  // Exactly one filed output selected — the only state a download has a
  // single, unambiguous file to hand over.
  const downloadable =
    browse.selection.length === 1
      ? items.find(
          (n): n is RegisterFileNode =>
            n.id === browse.selection[0] && n.kind === 'file' && !!n.artifactId,
        )
      : undefined;
  // Exactly one drawing OR one PDF page selected — `entryId`/`pdfId` are only
  // set on a register entry's own row (§ fileNodeFor / the PDF loop in
  // buildGroups). Renaming a filed output has no defined target: its name is
  // COMPUTED (`bbsFileName` off the drawing number/revision/version), not a
  // field anyone can overwrite, so Rename stops at drawings and PDF pages.
  const renameTarget =
    browse.selection.length === 1
      ? items.find(
          (n): n is RegisterFileNode & ({ entryId: string } | { pdfId: string }) =>
            n.id === browse.selection[0] && n.kind === 'file' && !!(n.entryId || n.pdfId),
        )
      : undefined;
  // Delete is broader than Rename — a drawing (cascades to its Sections and
  // every output filed under it), a PDF page, OR a single filed output on its
  // own (an old BBS/quantity version, deleted without touching the drawing
  // that made it).
  const deleteTarget =
    browse.selection.length === 1
      ? items.find(
          (n): n is RegisterFileNode & ({ entryId: string } | { artifactId: string } | { pdfId: string }) =>
            n.id === browse.selection[0] &&
            n.kind === 'file' &&
            !!(n.entryId || n.artifactId || n.pdfId),
        )
      : undefined;
  // A folder a person made — the only DERIVED folder besides one exception
  // that can be renamed or deleted. A discipline folder or a Sections/ folder
  // is a consequence of what its drawing is; renaming "Structural" would be
  // renaming a fact about the drawings in it.
  const folderTarget =
    browse.selection.length === 1
      ? items.find(
          (n): n is RegisterFolderNode =>
            n.id === browse.selection[0] && n.kind === 'folder' && !!n.userMade,
        )
      : undefined;
  // The exception: a multi-page PDF's Pages/ folder IS the imported file —
  // there is no separate row above it the way a drawing sits above its
  // Sections/ folder — so it gets its own delete/rename, keyed by the
  // `importedAt` every page in it shares (§ pdfBatchAt).
  const pdfFolderTarget =
    browse.selection.length === 1
      ? items.find(
          (n): n is RegisterFolderNode & { pdfBatchAt: number } =>
            n.id === browse.selection[0] && n.kind === 'folder' && typeof n.pdfBatchAt === 'number',
        )
      : undefined;
  // Every folder a person has made, for the "File into" menu. They live in
  // their own group, so this is the group — not a scan of the whole tree.
  const madeFolders = useMemo(
    () => data.groups.find((g) => g.id === 'g-folders')?.folders ?? [],
    [data.groups],
  );
  // What File into acts on: whatever is selected, folders included — filing a
  // Sections folder into "WH-4 package" is as reasonable as filing a drawing.
  const fileable = items.filter(
    (n) => browse.selection.includes(n.id) && !(n.kind === 'folder' && n.userMade),
  );
  // A membership is stored under the DOCUMENT id for a drawing — the entry id
  // is minted on this machine, so a folder filed under it came back empty on
  // any other. Reading uses both, because anything filed before this named the
  // entry id and must keep resolving.
  const filingKey = (n: RegisterNode): string =>
    n.kind === 'file' && n.documentId ? n.documentId : n.id;
  const inFolder = (f: RegisterFolderNode, n: RegisterNode): boolean =>
    f.children.some((c) => c.id === n.id || c.id === filingKey(n));

  const sortStateOf = (col: BrowseSort): 'ascending' | 'descending' | 'none' =>
    browse.sort !== col ? 'none' : browse.desc ? 'descending' : 'ascending';

  const sortMenu = useMenuAnchor();
  const viewMenu = useMenuAnchor();
  const newMenu = useMenuAnchor();
  const fileMenu = useMenuAnchor();
  const moveMenu = useMenuAnchor();

  const crumbs: { id: string | null; name: string }[] = [
    { id: null, name: 'Files' },
    ...browse.path.map((id) => ({ id, name: findFolder(data, id)?.name ?? id })),
  ];

  const thumb = (n: RegisterNode, small: boolean) => {
    if (n.kind === 'folder') {
      return (
        <span className="bthumb folder-thumb" aria-hidden="true">
          <svg width="72" height="58" viewBox="0 0 72 58" fill="none">
            <path d="M3 12a4 4 0 0 1 4-4h18l7 8h37a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" fill="#e8b44a" />
            <path d="M3 20h66v30a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" fill="#f5c563" />
          </svg>
        </span>
      );
    }
    const sheet = n.sheetId ? data.sheets[n.sheetId] : null;
    if (sheet) {
      // Thumbnails are the drawings themselves — the same SVG the canvas shows.
      return (
        <span
          className="bthumb sheet-thumb"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: sheet.svg }}
        />
      );
    }
    const e = extOf(n);
    return (
      <span className="bthumb doc" aria-hidden="true">
        <span className={`ext ${e}`}>{e.toUpperCase()}</span>
      </span>
    );
  };

  // A node that states its own meta wins — a Sections/ folder carries its
  // coverage ("12 items · 97.5% covered", §3.2), a section its entity count.
  const meta = (n: RegisterNode): string => {
    const line = sizeLine(data, n);
    return n.kind === 'file' && !n.meta && /^[\d,]+$/.test(line) ? `${line} entities` : line;
  };

  const tile = (n: RegisterNode) => (
    <button
      key={n.id}
      type="button"
      data-node={n.id}
      className={`bitem${selected(n.id) ? ' on' : ''}`}
      onClick={(e) => onItemClick(e, n)}
      onDoubleClick={() => openItem(n)}
    >
      {thumb(n, browse.view === 'small')}
      <span className="bname">{n.name}</span>
      <span className="bmeta">
        {n.kind === 'file' && n.rev ? <span className={`rev${n.current ? ' current' : ''}`}>{n.rev}</span> : null}
        {n.kind === 'file' && !n.rev && n.tag ? <span className="rev">{n.tag}</span> : null}
        {meta(n)}
      </span>
    </button>
  );

  return (
    <div className="browser" data-testid="files-view">
      <div className="bnav">
        <button type="button" className="btool icon" title="Back" disabled={!browse.back.length} onClick={() => store.browseBack()}>
          <Icon name="back" />
        </button>
        <button type="button" className="btool icon" title="Forward" disabled={!browse.fwd.length} onClick={() => store.browseForward()}>
          <Icon name="chevronRight" />
        </button>
        <button type="button" className="btool icon" title="Up one level" disabled={atRoot} onClick={() => store.browseUp()}>
          <Icon name="upLevel" />
        </button>
        <div className="bcrumb" aria-label="Folder path">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.id ?? 'root'}>
              {i > 0 && (
                <span className="sep">
                  <Icon name="chevronRight" size={12} />
                </span>
              )}
              <button
                type="button"
                onClick={() => store.browseTo(c.id === null ? [] : browse.path.slice(0, i))}
              >
                {i === 0 ? <Icon name="folder" size={13} /> : null}
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </div>
        <label className="bfind">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder={`Search ${folder?.name ?? 'Files'}`}
            aria-label={`Search ${folder?.name ?? 'Files'}`}
            value={browse.query}
            onChange={(e) => store.setBrowseQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="btools">
        <button type="button" className="btool" aria-haspopup="menu" onClick={newMenu.toggle}>
          <Icon name="plus" /> New
          <Icon name="chevronDown" size={11} />
        </button>
        {newMenu.open && newMenu.anchor && (
          <Menu
            anchor={newMenu.anchor}
            onClose={newMenu.close}
            items={[
              {
                label: 'Folder…',
                icon: 'folder',
                onSelect: () => {
                  if (!data.actions) {
                    toast('Folders arrive with the real register.', 'warn');
                    return;
                  }
                  const name = window.prompt('New folder', '');
                  const trimmed = name?.trim();
                  if (!trimmed) return;
                  data.actions.createFolder(trimmed);
                },
              },
              {
                label: 'Import a drawing…',
                icon: 'upload',
                onSelect: () =>
                  data.actions
                    ? data.actions.importDrawing()
                    : toast('Import lands in the register — wired with the CAD pipeline.'),
              },
            ]}
          />
        )}
        <span className="bar-sep" />
        <button
          type="button"
          className="btool icon"
          title={
            renameTarget
              ? `Rename ${renameTarget.name}`
              : folderTarget
                ? `Rename ${folderTarget.name}`
                : pdfFolderTarget
                  ? `Rename ${pdfFolderTarget.name} — renames every page in it`
                  : deleteTarget
                    ? `${deleteTarget.name}'s name is computed from the drawing it was built from — it cannot be renamed on its own`
                    : 'Select a drawing, a PDF or a folder you made to rename it'
          }
          aria-label="Rename"
          disabled={!renameTarget && !folderTarget && !pdfFolderTarget}
          onClick={() => {
            const target = renameTarget ?? folderTarget ?? pdfFolderTarget;
            if (!target) return;
            if (!data.actions) {
              toast('Rename lands with the real register.', 'warn');
              return;
            }
            const next = window.prompt(
              folderTarget
                ? 'Rename folder'
                : renameTarget?.pdfId || pdfFolderTarget
                  ? 'Rename PDF'
                  : 'Rename drawing',
              target.name,
            );
            const trimmed = next?.trim();
            if (!trimmed || trimmed === target.name) return;
            if (folderTarget) data.actions.renameFolder(folderTarget.id, trimmed);
            else if (renameTarget?.entryId) data.actions.renameDrawing(renameTarget.entryId, trimmed);
            else if (renameTarget?.pdfId) data.actions.renamePdf(renameTarget.pdfId, trimmed);
            else if (pdfFolderTarget) data.actions.renamePdfBatch(pdfFolderTarget.pdfBatchAt, trimmed);
            toast(`Renamed to ${trimmed}.`, 'ok');
          }}
        >
          <Icon name="pencil" />
        </button>
        <button
          type="button"
          className="btool icon"
          title={
            deleteTarget
              ? deleteTarget.entryId
                ? `Delete ${deleteTarget.name} — also removes its Sections and any filed BBS/Quantity output`
                : `Delete ${deleteTarget.name}`
              : folderTarget
                ? `Delete the folder ${folderTarget.name} — the drawings in it stay`
                : pdfFolderTarget
                  ? `Delete ${pdfFolderTarget.name} — removes every page in it`
                  : 'Select a drawing, a filed output, a PDF or a folder you made to delete it'
          }
          aria-label="Delete"
          disabled={!deleteTarget && !folderTarget && !pdfFolderTarget}
          onClick={() => {
            if (!data.actions) {
              toast('Delete lands with the real register.', 'warn');
              return;
            }
            // A folder a person made is a LABEL. Removing it removes the
            // label; every drawing filed under it stays in the register and
            // in every derived view it belonged to, so this needs no warning
            // about what else it takes with it — it takes nothing.
            if (folderTarget) {
              store.setBrowseSelection([]);
              data.actions.deleteFolder(folderTarget.id);
              return;
            }
            if (pdfFolderTarget) {
              const ok = window.confirm(`Delete "${pdfFolderTarget.name}"? Every page in it goes with it.`);
              if (!ok) return;
              store.setBrowseSelection([]);
              data.actions.deletePdfBatch(pdfFolderTarget.pdfBatchAt);
              toast(`Deleted ${pdfFolderTarget.name}.`, 'ok');
              return;
            }
            if (!deleteTarget) return;
            if (deleteTarget.entryId) {
              const ok = window.confirm(
                `Delete "${deleteTarget.name}"?\n\nThis also removes its Sections folder and any BBS or Quantity output filed under it. The originally uploaded file is kept.`,
              );
              if (!ok) return;
              store.setBrowseSelection([]);
              // deleteDrawing itself reports success/failure via the shell's
              // notify (the same `toast` this view uses) — one message, not two.
              data.actions.deleteDrawing(deleteTarget.entryId);
              return;
            }
            if (deleteTarget.pdfId) {
              const ok = window.confirm(`Delete "${deleteTarget.name}"?`);
              if (!ok) return;
              store.setBrowseSelection([]);
              data.actions.deletePdf(deleteTarget.pdfId);
              toast(`Deleted ${deleteTarget.name}.`, 'ok');
              return;
            }
            // A filed output on its own — an old BBS/quantity version.
            const ok = window.confirm(`Delete "${deleteTarget.name}"? This filed output cannot be recovered.`);
            if (!ok) return;
            store.setBrowseSelection([]);
            data.actions.deleteArtifact(deleteTarget.artifactId!);
            toast(`Deleted ${deleteTarget.name}.`, 'ok');
          }}
        >
          <Icon name="trash" />
        </button>
        {/* An issued output is a deliverable — it comes out of the folder that
            lists it, under the .xlsx name the row already shows (§6.2). */}
        <button
          type="button"
          className="btool"
          title={
            downloadable
              ? `Download ${downloadable.name}`
              : 'Select a filed schedule to download it'
          }
          disabled={!downloadable}
          onClick={() => {
            if (!downloadable?.artifactId) return;
            if (!data.actions) {
              toast('Downloads land with the real register.', 'warn');
              return;
            }
            const name = data.actions.downloadArtifact(downloadable.artifactId, 'xlsx');
            toast(
              name ? `Downloaded ${name}` : 'That schedule could not be read back.',
              name ? 'ok' : 'warn',
            );
          }}
        >
          <Icon name="download" /> Download
        </button>
        {/* Filing is a SECOND membership, never a move: what goes into "WH-4
            package" is still in Structural, still supersedable. So the verb is
            "File into", not "Move to" — the row does not leave anywhere. */}
        <button
          type="button"
          className="btool"
          aria-haspopup="menu"
          title={
            fileable.length
              ? `File ${fileable.length === 1 ? fileable[0].name : `${fileable.length} items`} into a folder`
              : 'Select something to file it into a folder'
          }
          disabled={!fileable.length}
          onClick={fileMenu.toggle}
        >
          <Icon name="folder" /> File into
          <Icon name="chevronDown" size={11} />
        </button>
        {fileMenu.open && fileMenu.anchor && (
          <Menu
            anchor={fileMenu.anchor}
            onClose={fileMenu.close}
            items={[
              { kind: 'title', label: fileable.length === 1 ? 'File into' : `File ${fileable.length} items into` },
              ...(madeFolders.length
                ? madeFolders.map((f) => {
                    // Ticked when EVERY selected item is already in it, so the
                    // click that follows means the same thing for all of them.
                    const all = fileable.every((n) => inFolder(f, n));
                    return {
                      label: f.name,
                      icon: 'folder' as const,
                      checked: all,
                      onSelect: () => {
                        if (!data.actions) {
                          toast('Folders arrive with the real register.', 'warn');
                          return;
                        }
                        for (const n of fileable) data.actions.fileInFolder(f.id, filingKey(n), !all);
                        toast(
                          all
                            ? `Removed from ${f.name}.`
                            : `Filed into ${f.name} — still in ${fileable.length === 1 ? 'its own folder' : 'their own folders'} too.`,
                          'ok',
                        );
                      },
                    };
                  })
                : [{ kind: 'note' as const, label: 'No folders yet — make one with New → Folder.' }]),
              { kind: 'divider' as const },
              {
                label: 'New folder…',
                icon: 'plus',
                onSelect: () => {
                  if (!data.actions) return;
                  const name = window.prompt('New folder', '')?.trim();
                  if (!name) return;
                  // Make it and fill it in the same click — the id comes back
                  // from the write, so nothing here waits for a re-render.
                  const made = data.actions.createFolder(name);
                  if (!made) return;
                  for (const n of fileable) data.actions.fileInFolder(made, filingKey(n), true);
                  toast(`Filed ${fileable.length === 1 ? fileable[0].name : `${fileable.length} items`} into ${name}.`, 'ok');
                },
              },
            ]}
          />
        )}
        {/* MOVE, beside FILE INTO, because they are different statements.
            File into ADDS a membership and leaves the others alone. Move says
            this drawing lives HERE now — it leaves every other folder someone
            made. Neither one touches the discipline: that is read off the
            sheet, and filing a drawing somewhere says nothing about what kind
            of drawing it is. */}
        <button
          type="button"
          className="btool"
          aria-haspopup="menu"
          disabled={!fileable.length}
          title={
            fileable.length
              ? 'Move to one folder — it leaves the others. Its discipline does not change.'
              : 'Select something to move'
          }
          onClick={moveMenu.toggle}
        >
          <Icon name="folder" /> Move to
          <Icon name="chevronDown" size={11} />
        </button>
        {moveMenu.open && moveMenu.anchor && (
          <Menu
            anchor={moveMenu.anchor}
            onClose={moveMenu.close}
            items={[
              {
                kind: 'title',
                label: fileable.length === 1 ? 'Move into' : `Move ${fileable.length} items into`,
              },
              ...(madeFolders.length
                ? madeFolders.map((f) => ({
                    label: f.name,
                    icon: 'folder' as const,
                    checked: fileable.every((n) => inFolder(f, n)),
                    onSelect: () => {
                      if (!data.actions) {
                        toast('Folders arrive with the real register.', 'warn');
                        return;
                      }
                      for (const n of fileable) data.actions.moveToFolder(filingKey(n), f.id);
                      toast(`Moved into ${f.name}. Discipline unchanged.`, 'ok');
                    },
                  }))
                : [{ kind: 'note' as const, label: 'No folders yet — make one with New → Folder.' }]),
              { kind: 'divider' as const },
              {
                label: 'Out of every folder',
                icon: 'layers',
                title: 'Filed by discipline alone — the drawing itself is untouched',
                onSelect: () => {
                  if (!data.actions) return;
                  for (const n of fileable) data.actions.moveToFolder(filingKey(n), null);
                  toast('Filed by discipline only now.', 'ok');
                },
              },
            ]}
          />
        )}
        <span className="bar-sep" />
        <button type="button" className="btool" aria-haspopup="menu" onClick={sortMenu.toggle}>
          <Icon name="sortArrows" /> Sort
          <Icon name="chevronDown" size={11} />
        </button>
        {sortMenu.open && sortMenu.anchor && (
          <Menu
            anchor={sortMenu.anchor}
            onClose={sortMenu.close}
            items={[
              { kind: 'title', label: 'Sort by' },
              ...COLUMNS.map((c) => ({
                label: c.sort === 'rev' ? 'Revision' : c.label,
                checked: browse.sort === c.sort,
                onSelect: () => store.setBrowseSort(c.sort, false),
              })),
              { kind: 'divider' as const },
              {
                label: 'Ascending',
                checked: !browse.desc,
                onSelect: () => store.setBrowseSort(browse.sort, false),
              },
              {
                label: 'Descending',
                checked: browse.desc,
                onSelect: () => store.setBrowseSort(browse.sort, true),
              },
            ]}
          />
        )}
        <button type="button" className="btool" aria-haspopup="menu" onClick={viewMenu.toggle}>
          <Icon name="viewGrid" /> View
          <Icon name="chevronDown" size={11} />
        </button>
        {viewMenu.open && viewMenu.anchor && (
          <Menu
            anchor={viewMenu.anchor}
            onClose={viewMenu.close}
            items={[
              { kind: 'title', label: 'View' },
              ...(['large', 'small', 'details'] as const).map((v) => ({
                label: v === 'large' ? 'Large icons' : v === 'small' ? 'Small icons' : 'Details',
                checked: browse.view === v,
                onSelect: () => store.setBrowseView(v),
              })),
            ]}
          />
        )}
        {/* The item count is NOT repeated here — the status bar says it once,
            "6 items in Structural", and one count cannot then contradict the
            other. Only the selection, which the status bar does not carry. */}
        {browse.selection.length ? (
          <span className="bcount">{browse.selection.length} selected</span>
        ) : null}
      </div>

      <div
        className={`bbody${browse.view === 'details' ? ' list' : ''}`}
        ref={bodyRef}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (e.target === e.currentTarget || el.classList.contains('bgrid') || el.classList.contains('blist-scroll')) {
            store.setBrowseSelection([]);
          }
        }}
      >
        {!items.length ? (
          <div className="bempty">
            <span className="vt">This folder is empty</span>
            <span className="vs">
              {browse.query
                ? `Nothing here matches "${browse.query}".`
                : 'Import a drawing, or move one in from another folder.'}
            </span>
          </div>
        ) : browse.view === 'details' ? (
          <div className="blist-scroll">
            <table className="blist">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.sort} className={c.cls} aria-sort={sortStateOf(c.sort)}>
                      {/* The header IS the sort control — clicking the sorted
                          column again reverses it, as a file manager does. */}
                      <button type="button" onClick={() => store.setBrowseSort(c.sort)}>
                        {c.label}
                        {browse.sort === c.sort ? (
                          <Icon name={browse.desc ? 'chevronDown' : 'chevronUp'} size={11} />
                        ) : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((n) => (
                  <tr
                    key={n.id}
                    data-node={n.id}
                    className={selected(n.id) ? 'on' : ''}
                    onClick={(e) => onItemClick(e, n)}
                    onDoubleClick={() => openItem(n)}
                  >
                    <td className="n">
                      <span className={`row-ic ${n.kind}`}>
                        <Icon name={n.kind === 'folder' ? 'folder' : 'file'} size={14} />
                      </span>
                      {n.name}
                    </td>
                    <td>{revisionOf(n) ?? '—'}</td>
                    <td className="mono">{drawingNumber(data, n) ?? '—'}</td>
                    <td>{typeLabel(n)}</td>
                    <td>{disciplineOf(data, n) ?? '—'}</td>
                    <td className="num">{sizeLine(data, n)}</td>
                    <td>{statusLabel(n)}</td>
                    <td className="when">{dateLine(n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={`bgrid${browse.view === 'small' ? ' small' : ''}`}>
            {atRoot && !browse.query
              ? data.groups.map((g) => (
                  <React.Fragment key={g.id}>
                    <div className="bgroup">
                      {g.name}
                      <span className="rule" />
                    </div>
                    {g.folders.filter((f) => items.includes(f)).map(tile)}
                  </React.Fragment>
                ))
              : items.map(tile)}
          </div>
        )}
      </div>
    </div>
  );
}

function pathFromRoot(data: ReturnType<typeof useStudioData>, folderId: string): string[] {
  // A root tile is a top-level folder — its path is just itself.
  return [folderId];
}
