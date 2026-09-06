// The real import flow, end to end through the live StudioData seam:
// register upload button → picker → DXF text → parse → session sheet →
// register entry → open sheet with data-layer groups in the viewport.
//
// The DXF worker is the one piece jsdom cannot host (no Worker), so the worker
// CLIENT is mocked with the real synchronous parser — everything downstream of
// the parse is the production path. IndexedDB is absent too; the import then
// takes its documented degraded path (in-memory session + register, transient
// warning) which is exactly what this test asserts survives.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/cad/worker/client', async () => {
  const { parseDXF } = await import('../../src/cad/dxf/parse');
  return {
    parseDXFInWorker: async (text: string, fileName: string) => parseDXF(text, fileName),
    disposeDXFWorker: () => undefined,
  };
});

// jsdom cannot run pdf.js (no Worker, no 2d canvas) — mocked the same way
// tests/domain/pdf-import.test.ts does, so a PDF import through the real UI
// picker still exercises the production register/grouping path downstream.
interface MockPdfPage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: unknown[] }>;
  render?: () => { promise: Promise<void> };
}
const mockPdfPages: MockPdfPage[] = [];
function mockPdfPage(): MockPdfPage {
  return {
    getViewport: ({ scale }) => ({ width: 841.89 * scale, height: 595.28 * scale }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve() }),
  };
}
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: mockPdfPages.length,
      getPage: async (n: number) => mockPdfPages[n - 1],
      destroy: async () => {},
    }),
  }),
}));

import { StudioShell } from '../../src/components/StudioShell';
import { setCadDocument } from '../../src/cad/session';
import { StudioDataContext } from '../../src/studio/data';
import { useRealStudioData, type Notify } from '../../src/studio/realData';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';
import { createFolder as createUserFolderRecord } from '../../src/register/folders';

afterEach(cleanup);

// jsdom's Blob has no arrayBuffer(); the import flow reads magic bytes with it.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// A small synthetic sheet: two concrete lines, a rebar line, a dimension-layer
// line and a callout text. The filename carries the drawing number + revision
// the title-block reader falls back to.
const DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '5', 'A1', '8', 'CONCRETE', '10', '0', '20', '0', '11', '3000', '21', '0',
  '0', 'LINE', '5', 'A2', '8', 'CONCRETE', '10', '0', '20', '450', '11', '3000', '21', '450',
  '0', 'LINE', '5', 'A3', '8', 'REINF', '10', '50', '20', '50', '11', '2950', '21', '50',
  '0', 'LINE', '5', 'A4', '8', 'DIM', '10', '0', '20', '-200', '11', '3000', '21', '-200',
  '0', 'TEXT', '5', 'A5', '8', 'TEXT', '10', '100', '20', '600', '40', '60', '1', 'TB 2-16TOR T&B',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

const FILE_NAME = 'TEST-STR-001_R1.dxf';

function dxfFile(): File {
  return new File([DXF], FILE_NAME, { type: 'application/dxf' });
}

/** A second, clearly different sheet — different geometry AND its own marker text. */
const DXF_2 = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '5', 'B1', '8', 'CONCRETE', '10', '0', '20', '0', '11', '5000', '21', '0',
  '0', 'LINE', '5', 'B2', '8', 'CONCRETE', '10', '0', '20', '900', '11', '5000', '21', '900',
  '0', 'CIRCLE', '5', 'B3', '8', 'REINF', '10', '2500', '20', '450', '40', '150',
  '0', 'TEXT', '5', 'B4', '8', 'TEXT', '10', '200', '20', '1200', '40', '60', '1', 'C1 4-20TOR',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');
const FILE_NAME_2 = 'TEST-STR-002_R1.dxf';

function dxfFile2(): File {
  return new File([DXF_2], FILE_NAME_2, { type: 'application/dxf' });
}

function pdfFile(name: string): File {
  // The picked-file branch checks magic bytes OR a .pdf extension; the name
  // alone is enough here since pdfjs-dist itself is mocked above.
  return new File(['%PDF-1.4'], name, { type: 'application/pdf' });
}

/** array-like FileList stand-in — jsdom has no DataTransfer to build one. */
function fakeFileList(file: File): FileList {
  return { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
}

const TEST_PROJECT = {
  id: 'test-project',
  name: 'Test Project',
  createdAt: 0,
  modifiedAt: 0,
};

function Harness({
  store,
  notify,
  project = TEST_PROJECT,
}: {
  store: StudioStore;
  notify: Notify;
  project?: typeof TEST_PROJECT;
}) {
  const data = useRealStudioData(store, notify, project);
  return (
    <StudioDataContext.Provider value={data}>
      <StudioShell />
    </StudioDataContext.Provider>
  );
}

describe('import flow (real seam)', () => {
  beforeEach(() => {
    setCadDocument(null);
  });

  it('imports a DXF: parses, registers, opens the sheet with layer groups', async () => {
    const store = new StudioStore();
    const messages: string[] = [];
    const notify: Notify = (m) => messages.push(m);

    // Intercept the picker: the flow creates an <input type=file> and clicks
    // it; feed it the fixture instead of a dialog.
    let picker: HTMLInputElement | null = null;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type === 'file') picker = this;
    });

    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={notify} />
      </StudioStoreContext.Provider>,
    );

    // the live register starts empty; let the mount-time restore settle first
    // (register load + session restore are async and the flow serialises on them)
    expect(screen.getByText('0 drawings')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));

    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    expect(picker).not.toBeNull();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile()) });
    picker!.onchange?.(new Event('change'));

    // the parsed document lands in the session and the shell opens its sheet
    await waitFor(() => {
      expect(store.getState().sheets.active).not.toBeNull();
    });

    // the register filed it: identity from the filename, revision chip R1
    await waitFor(() => {
      expect(screen.getAllByText(/TEST-STR-001/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('R1').length).toBeGreaterThan(0);

    // the viewport carries the six-ink-group contract with real geometry:
    // CONCRETE→CONC, REINF→RBAR, DIM→DIMS, TEXT→TEXT
    const host = screen.getByTestId('sheet-host');
    await waitFor(() => {
      expect(host.querySelector('[data-layer="CONC"] path')).not.toBeNull();
    });
    expect(host.querySelector('[data-layer="RBAR"] path')).not.toBeNull();
    expect(host.querySelector('[data-layer="DIMS"] path')).not.toBeNull();
    expect(host.querySelector('[data-layer="TEXT"] text')).not.toBeNull();
    // every op is addressable for the §6.3 row→geometry highlight
    expect(host.querySelector('[data-handle]')).not.toBeNull();

    // the import reported honestly (jsdom has no IndexedDB, so the documented
    // "loaded but not saved" degraded path is allowed alongside success)
    expect(messages.some((m) => /filed in the register/.test(m))).toBe(true);

    click.mockRestore();
  });

  it('two different imported drawings open with their OWN content, not each other\'s', async () => {
    const store = new StudioStore();
    const notify: Notify = () => undefined;
    // Its own project: the register is module-level state, so sharing
    // TEST_PROJECT with the earlier test would carry that test's own
    // "TEST-STR-001" entry into this one's count and its `getByText` queries.
    const project = { id: 'test-project-two-drawings', name: 'Two Drawings', createdAt: 0, modifiedAt: 0 };

    let picker: HTMLInputElement | null = null;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type === 'file') picker = this;
    });

    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={notify} project={project} />
      </StudioStoreContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Import #1
    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile()) });
    picker!.onchange?.(new Event('change'));
    await waitFor(() => {
      expect(screen.getByTestId('sheet-host').textContent).toContain('TB 2-16TOR T&B');
    });

    // Import #2 — different geometry, different drawing number, so it files
    // as an unrelated entry (not a revision of #1).
    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile2()) });
    picker!.onchange?.(new Event('change'));
    await waitFor(() => {
      expect(screen.getByTestId('sheet-host').textContent).toContain('C1 4-20TOR');
    });
    // #1's own marker is gone — the canvas holds one sheet at a time (§ cad/session.ts).
    expect(screen.getByTestId('sheet-host').textContent).not.toContain('TB 2-16TOR T&B');

    // Now open each one again BY NAME, from the register tree — the panel
    // that is always mounted regardless of stageMode, so this exercises
    // opening an already-imported drawing without a Files-view navigation
    // step in between. It must show its OWN content again, not a repeat of
    // whatever the other one last rendered.
    const tree = screen.getByRole('tree', { name: 'Register tree' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand Structural' }));

    fireEvent.click(within(tree).getByText(/TEST-STR-001/));
    await waitFor(() => {
      expect(screen.getByTestId('sheet-host').textContent).toContain('TB 2-16TOR T&B');
    });
    expect(screen.getByTestId('sheet-host').textContent).not.toContain('C1 4-20TOR');

    // And #2 again — the same round trip, the other way.
    fireEvent.click(within(tree).getByText(/TEST-STR-002/));
    await waitFor(() => {
      expect(screen.getByTestId('sheet-host').textContent).toContain('C1 4-20TOR');
    });
    expect(screen.getByTestId('sheet-host').textContent).not.toContain('TB 2-16TOR T&B');

    click.mockRestore();
  });

  it('the same file dropped in twice stays one drawing — no second row, no version', async () => {
    const store = new StudioStore();
    const messages: string[] = [];
    const notify: Notify = (m) => messages.push(m);
    const project = { id: 'test-project-reupload', name: 'Re-upload', createdAt: 0, modifiedAt: 0 };

    let picker: HTMLInputElement | null = null;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type === 'file') picker = this;
    });

    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={notify} project={project} />
      </StudioStoreContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 30));

    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile()) });
    picker!.onchange?.(new Event('change'));
    await waitFor(() => expect(screen.getByText('1 drawings')).toBeInTheDocument());

    // The identical file again. It is not a revision of itself.
    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile()) });
    picker!.onchange?.(new Event('change'));
    await waitFor(() => {
      expect(messages.some((m) => /already on file/.test(m))).toBe(true);
    });

    expect(screen.getByText('1 drawings')).toBeInTheDocument();
    const tree = screen.getByRole('tree', { name: 'Register tree' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand Structural' }));
    expect(within(tree).getAllByText(/TEST-STR-001/)).toHaveLength(1);

    click.mockRestore();
  });

  it('importing while standing inside a folder a person made files the drawing into it', async () => {
    const store = new StudioStore();
    const notify: Notify = () => undefined;

    let picker: HTMLInputElement | null = null;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type === 'file') picker = this;
    });

    const folder = createUserFolderRecord(TEST_PROJECT.id, 'demo');

    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={notify} />
      </StudioStoreContext.Provider>,
    );

    await new Promise((r) => setTimeout(r, 30));
    store.browseTo([folder.id]);
    await waitFor(() => screen.getByText('This folder is empty'));

    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    expect(picker).not.toBeNull();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(dxfFile()) });
    picker!.onchange?.(new Event('change'));

    // Filed as a SECOND membership (src/register/folders.ts): it shows up
    // standing inside "demo" without ever leaving Structural, its discipline
    // folder — the same drawing, listed in both places.
    await waitFor(() => {
      expect(screen.queryByText('This folder is empty')).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(/TEST-STR-001/).length).toBeGreaterThan(0);

    click.mockRestore();
  });

  it('groups a multi-page PDF into one Pages/ folder instead of one flat row per page', async () => {
    const store = new StudioStore();
    const notify: Notify = () => undefined;

    let picker: HTMLInputElement | null = null;
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      if (this.type === 'file') picker = this;
    });

    mockPdfPages.length = 0;
    mockPdfPages.push(mockPdfPage(), mockPdfPage(), mockPdfPage());

    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={notify} />
      </StudioStoreContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 30));

    screen.getByTitle('Import drawing (DXF / DWG / PDF)').click();
    expect(picker).not.toBeNull();
    Object.defineProperty(picker!, 'files', { value: fakeFileList(pdfFile('harness2.pdf')) });
    picker!.onchange?.(new Event('change'));

    // The import opens the first page's sheet once it lands — the signal
    // that the async read-and-register work is actually done.
    await waitFor(() => {
      expect(store.getState().sheets.active).not.toBeNull();
    });

    // No title-block/keyword hints in a blank mock page, so it files under
    // General — same fallback `inferDiscipline` gives a DXF with none either.
    store.browseTo(['f-disc-general']);
    const files = screen.getByTestId('files-view');
    await waitFor(() => within(files).getByText('Pages — harness2.pdf'));

    expect(within(files).getByText('3 pages')).toBeInTheDocument();
    // Grouped, not flattened: no top-level "harness2.pdf — page N" row.
    expect(within(files).queryByText(/harness2\.pdf — page/)).not.toBeInTheDocument();

    click.mockRestore();
  });

  it('states plainly why a BBS run cannot start without a key', async () => {
    const store = new StudioStore();
    render(
      <StudioStoreContext.Provider value={store}>
        <Harness store={store} notify={() => undefined} />
      </StudioStoreContext.Provider>,
    );

    // BBS is requested in the Ask conversation; the assistant names the
    // missing prerequisite instead of exposing a separate cramped panel.
    screen.getByRole('tab', { name: 'Ask' }).click();
    // the tab switch is a React state update; query for the input rather than
    // assuming this frame already committed
    const input = await screen.findByRole('textbox', { name: /Ask about this drawing/ });
    fireEvent.change(input, { target: { value: 'Calculate the BBS for this drawing' } });
    screen.getByRole('button', { name: 'Send' }).click();
    await waitFor(() => {
      expect(screen.getByTestId('ask-thread').textContent).toMatch(/Open a DXF drawing|OpenRouter key/);
    });
    expect(screen.queryByRole('tab', { name: /BBS/ })).not.toBeInTheDocument();
  });
});
