// The Expand/Edit window, wired to the register.
//
// It owns nothing but the open/closed state and the last save's rejections:
// the grid comes from the filed artifact, and the save goes straight to
// `saveBbsEdits`, which validates, files the DataFacts and recomputes through
// the one pipeline. No arithmetic happens in this file or the one it renders.
import React, { useMemo, useState } from 'react';
import { BbsEditor } from './BbsEditor';
import { useStudioData } from '../studio/data';
import { useStudioStore } from '../studio/store';
import { toast } from './Toasts';
import type { CellEdit, EditRejection } from '../../calculations/bbsEdit';

export function BbsEditorHost({ artifactId }: { artifactId: string }) {
  const data = useStudioData();
  const store = useStudioStore();
  const [rejected, setRejected] = useState<readonly EditRejection[]>([]);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const close = () => store.openBbsEditor(null);

  // Rebuilt after every save, so the grid a person is looking at is the
  // schedule as it now stands — not the one they opened.
  const grid = useMemo(
    () => (data.actions ? data.actions.bbsEditorGrid(artifactId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.actions, artifactId, nonce],
  );

  const file = useMemo(
    () =>
      data.groups
        .flatMap((g) => g.folders)
        .flatMap((f) => f.children)
        .find((n): n is Extract<typeof n, { kind: 'file' }> => n.kind === 'file' && n.artifactId === artifactId),
    [data.groups, artifactId],
  );

  if (!grid) {
    return (
      <div className="bbsed-overlay" role="dialog" aria-modal="true">
        <div className="bbsed" style={{ maxWidth: 520 }}>
          <header className="bbsed-head">
            <div className="bbsed-title">
              <h2>This schedule cannot be opened for editing</h2>
              <p>
                It carries no rows, members or settings to rebuild from — an empty or damaged artifact.
                Rebuild the BBS for this drawing and the new version opens here.
              </p>
            </div>
          </header>
          <footer className="bbsed-foot">
            <button type="button" className="btool" onClick={close}>
              Close
            </button>
          </footer>
        </div>
      </div>
    );
  }

  const save = async (edits: CellEdit[], opts: { asNewVersion?: boolean; acknowledged?: string[] } = {}) => {
    if (!data.actions) return;
    setBusy(true);
    try {
      const out = await data.actions.saveBbsEdits(artifactId, edits, opts);
      if (!out) {
        toast('That schedule could not be saved.', 'warn');
        return;
      }
      setRejected(out.rejected);
      if (out.rejected.length) {
        toast(`${out.rejected.length} edit(s) were not accepted — see the cells marked in red.`, 'warn');
        return;
      }
      setNonce((n) => n + 1);
      toast(
        `${out.newVersion ? `Filed as v${out.version}` : `v${out.version} updated`} — ` +
          `${out.facts} input${out.facts === 1 ? '' : 's'} recorded, ` +
          `${out.recalculated} row${out.recalculated === 1 ? '' : 's'} recalculated. Status: ${out.status}.`,
        out.status === 'FINAL' ? 'ok' : 'warn',
      );
      // A new version is a different document — follow it, so the next edit
      // does not silently go back to the one that was superseded.
      if (out.newVersion && out.artifactId !== artifactId) store.openBbsEditor(out.artifactId);
      else if (out.status === 'FINAL') close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <BbsEditor
      grid={grid}
      title={file?.name ?? 'Bar bending schedule'}
      subtitle={file?.number ? `${file.number}${file.tag ? ` · ${file.tag}` : ''}` : file?.tag}
      drawing={file?.number}
      revision={file?.rev}
      onSave={save}
      onClose={close}
      rejected={rejected}
      busy={busy}
    />
  );
}
