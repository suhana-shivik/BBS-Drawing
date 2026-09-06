// In-memory demo StudioData so `npm run dev` shows the working shell — a demo
// register, one openable sheet on CAD black, and a small schedule — before the
// real CAD session and register land behind the StudioData seam.
//
// integration seam: delete nothing here to integrate — implement StudioData
// over the real session/register and swap the value passed to
// <StudioDataContext.Provider> in App.tsx.

import type { StudioData, StudioSheet } from './data';
import type { ScheduleRow } from './schedule';

// --- demo sheet ink ---------------------------------------------------------
// Muted ACI layer colours (§2.2). Real sheets arrive as rendered SVG with the
// same data-layer groups; this hand-drawn stand-in honours that contract.

const INK = {
  CONC: '#d7dae0',
  RBAR: '#e3b558',
  DIMS: '#57c4cf',
  TEXT: '#c489cf',
  GRND: '#6fbf7f',
  SHEET: '#7f8794',
};

function demoWallSvg(): string {
  const bays: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 90 + i * 170;
    // columns + footings (CONC), verticals (RBAR)
    bays.push(
      `<rect x="${x}" y="240" width="26" height="260" fill="none" stroke="${INK.CONC}" stroke-width="1.4"/>`,
      `<rect x="${x - 32}" y="500" width="90" height="34" fill="none" stroke="${INK.CONC}" stroke-width="1.4"/>`,
    );
  }
  const rbar: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 90 + i * 170;
    rbar.push(
      `<line x1="${x + 6}" y1="248" x2="${x + 6}" y2="524" stroke="${INK.RBAR}" stroke-width="1.1"/>`,
      `<line x1="${x + 20}" y1="248" x2="${x + 20}" y2="524" stroke="${INK.RBAR}" stroke-width="1.1"/>`,
    );
    for (let s = 0; s < 7; s++) {
      rbar.push(
        `<rect x="${x + 3}" y="${268 + s * 34}" width="20" height="8" fill="none" stroke="${INK.RBAR}" stroke-width="0.8"/>`,
      );
    }
  }
  // tie beam
  const tie = `<rect x="58" y="216" width="984" height="26" fill="none" stroke="${INK.CONC}" stroke-width="1.4"/>` +
    `<line x1="58" y1="224" x2="1042" y2="224" stroke="${INK.RBAR}" stroke-width="1"/>` +
    `<line x1="58" y1="234" x2="1042" y2="234" stroke="${INK.RBAR}" stroke-width="1"/>`;
  const ground = `<line x1="30" y1="500" x2="1070" y2="500" stroke="${INK.GRND}" stroke-width="1.3" stroke-dasharray="9 5"/>` +
    `<text x="36" y="492" fill="${INK.GRND}" font-family="IBM Plex Mono, monospace" font-size="11">GL &#177;0.00</text>`;
  const dims = `<line x1="90" y1="580" x2="940" y2="580" stroke="${INK.DIMS}" stroke-width="0.9"/>` +
    `<line x1="90" y1="572" x2="90" y2="588" stroke="${INK.DIMS}" stroke-width="0.9"/>` +
    `<line x1="940" y1="572" x2="940" y2="588" stroke="${INK.DIMS}" stroke-width="0.9"/>` +
    `<text x="515" y="572" fill="${INK.DIMS}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="12">5 &#215; 3000 = 15000</text>`;
  const text = `<text x="90" y="180" fill="${INK.TEXT}" font-family="IBM Plex Mono, monospace" font-size="13">TB 2-16TOR + 2-12TOR T&#38;B, 4L-8TOR@150</text>` +
    `<text x="90" y="640" fill="${INK.TEXT}" font-family="IBM Plex Mono, monospace" font-size="13">C1 4-16TOR VERT, 8TOR@150 LINKS</text>`;
  const sheet = `<rect x="18" y="14" width="1164" height="732" fill="none" stroke="${INK.SHEET}" stroke-width="1.6"/>` +
    `<rect x="962" y="672" width="220" height="74" fill="none" stroke="${INK.SHEET}" stroke-width="1.1"/>` +
    `<text x="974" y="700" fill="${INK.SHEET}" font-family="IBM Plex Mono, monospace" font-size="11">GAMCO-STR-001  R2</text>` +
    `<text x="974" y="722" fill="${INK.SHEET}" font-family="IBM Plex Mono, monospace" font-size="11">BOUNDARY WALL  1:50</text>`;
  return (
    `<svg viewBox="0 0 1200 760" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Boundary wall demo sheet">` +
    `<g data-layer="SHEET">${sheet}</g>` +
    `<g data-layer="CONC">${tie}${bays.join('')}</g>` +
    `<g data-layer="RBAR">${rbar.join('')}</g>` +
    `<g data-layer="GRND">${ground}</g>` +
    `<g data-layer="DIMS">${dims}</g>` +
    `<g data-layer="TEXT">${text}</g>` +
    `</svg>`
  );
}

function demoSheet(partial: Partial<StudioSheet> & Pick<StudioSheet, 'id' | 'tab' | 'title' | 'number' | 'rev'>): StudioSheet {
  return {
    discipline: 'Structural',
    entities: 48213,
    grounded: false,
    issues: 0,
    hasModel: false,
    panels: [],
    model: { widthUnits: 1200, heightUnits: 760, mmPerUnit: 100, x0Mm: 0, y0Mm: 0 },
    svg: demoWallSvg(),
    ...partial,
  };
}

const SHEETS: Record<string, StudioSheet> = {
  gamco: demoSheet({
    id: 'gamco',
    tab: 'GAMCO-STR-001 R2 boundary wall',
    title: 'Boundary wall — general arrangement & reinforcement detail',
    number: 'GAMCO-STR-001',
    rev: 'R2',
    grounded: true,
    panels: [
      'panel 01 — elevation bays 1–3',
      'panel 02 — elevation bays 4–6',
      'panel 04 — detail A, C1 section',
      'panel 05 — detail B, F1 and starter',
    ],
  }),
  str002: demoSheet({
    id: 'str002',
    tab: 'GAMCO-STR-002 R1 gate & pier',
    title: 'Gate & pier detail',
    number: 'GAMCO-STR-002',
    rev: 'R1',
    entities: 21042,
  }),
  oswl: demoSheet({
    id: 'oswl',
    tab: 'OSWL foundation R7',
    title: 'Foundation GA & reinforcement detail',
    number: 'OSWL-STR-101',
    rev: 'R7',
    entities: 36110,
    issues: 2,
  }),
};

// --- demo schedule ----------------------------------------------------------

let seq = 0;
function row(partial: Partial<ScheduleRow> & Pick<ScheduleRow, 'mark' | 'member' | 'diaMm'>): ScheduleRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    barType: 'Fe500D',
    shapeCode: '00',
    segments: [],
    cuttingLengthMm: null,
    lengthWorking: '',
    lengthSource: 'SHAPE_FORMULA',
    barsPerMember: null,
    memberCount: null,
    totalBars: 0,
    spacingMm: null,
    occurrenceBand: null,
    totalLengthM: null,
    unitWeightKgPerM: null,
    weightKg: null,
    warnings: [],
    fromCallout: null,
    handles: [],
    status: 'verified',
    ...partial,
  };
}

const SCHEDULE_ROWS: ScheduleRow[] = [
  row({
    mark: 'C1', member: 'C1 column', diaMm: 16, shapeCode: '00',
    segments: [{ label: 'a', mm: 3450 }],
    cuttingLengthMm: 3450, lengthWorking: '3450 = 3450', lengthSource: 'SHAPE_FORMULA',
    barsPerMember: 8, memberCount: 19, totalBars: 152,
    occurrenceBand: 'BAND-01', countWorking: '8 verticals × 19 occurrences of C1 in BAND-01 = 152',
    totalLengthM: 524.4, unitWeightKgPerM: 1.58, weightKg: 828.4,
    weightWorking: '16² ÷ 162 = 1.580 kg/m × 524.4 m = 828.4 kg',
    fromCallout: 'C1 4-16TOR VERT (2 faces)', handles: ['2F1A', '2F1B', '2F1C'],
  }),
  row({
    mark: 'C1', member: 'C1 column', diaMm: 8, shapeCode: '51',
    segments: [
      { label: 'a', mm: 380 }, { label: 'b', mm: 180 },
      { label: '—', mm: -36, note: 'bend deduction, 3 × 90° · IS 2502 Table 1' },
      { label: 'hooks', mm: 150, note: '2 × 75 mm end hooks' },
    ],
    cuttingLengthMm: 1080, lengthWorking: '2×(380 + 180) + 2×75 − 3×2d = 1080',
    barsPerMember: 64, memberCount: 19, totalBars: 1216, spacingMm: 150,
    countWorking: 'height 3450 ÷ 150 c/c ⇒ 24 per leg zone × … = 64 per member × 19 = 1216',
    totalLengthM: 1313.3, unitWeightKgPerM: 0.395, weightKg: 518.7,
    weightWorking: '8² ÷ 162 = 0.395 kg/m × 1313.3 m = 518.7 kg',
    fromCallout: '8TOR@150 LINKS', handles: ['2F20', '2F21'],
    zone: 'full height',
    warnings: ['Link zones counted full height — zone extents are not dimensioned on this sheet.'],
    status: 'inferred',
  }),
  row({
    mark: 'F1', member: 'F1 footing', diaMm: 12, shapeCode: '21',
    segments: [
      { label: 'a', mm: 1120 }, { label: 'b', mm: 150 }, { label: 'c', mm: 150 },
      { label: '—', mm: -48, note: 'bend deduction, 2 × 90° · IS 2502 Table 1' },
    ],
    cuttingLengthMm: 1420, lengthWorking: '1120 + 150 + 150 − (2 × 2d) = 1372 ≈ 1420 with cover taken flat',
    barsPerMember: 12, memberCount: 25, totalBars: 300, spacingMm: 100,
    direction: 'both ways',
    totalLengthM: 426.0, unitWeightKgPerM: 0.889, weightKg: 378.4,
    weightWorking: '12² ÷ 162 = 0.889 kg/m × 426.0 m = 378.4 kg',
    fromCallout: 'F1 12TOR@100 B/W', handles: ['31A0', '31A1'],
    warnings: ['Cover taken flat at 50 mm — the sheet names cover in prose.'],
  }),
  row({
    mark: 'TB', member: 'TB tie beam', diaMm: 16, shapeCode: '21',
    segments: [
      { label: 'a', mm: 11400 }, { label: 'b', mm: 400 }, { label: 'c', mm: 300 },
      { label: '—', mm: -100, note: 'bend deduction, 2 × 90° · IS 2502 Table 1' },
    ],
    cuttingLengthMm: 12000, lengthWorking: '11400 + 400 + 300 − (2 × 2d) = 12000',
    barsPerMember: 4, memberCount: null, totalBars: 18,
    countWorking: '2 top + 2 bottom = 4 · continuous over 100 000 mm run · laps 50Ø per 12 m stock = 18',
    totalLengthM: 216.0, unitWeightKgPerM: 1.58, weightKg: 341.0,
    weightWorking: '16² ÷ 162 = 1.580 kg/m × 216.0 m = 341.0 kg',
    fromCallout: 'TB 2-16TOR + 2-12TOR T&B, 4L-8TOR@150', handles: ['41B0', '41B1', '41B2'],
  }),
  row({
    mark: 'TB', member: 'TB tie beam', diaMm: 8, shapeCode: '51',
    segments: [
      { label: 'a', mm: 340 }, { label: 'b', mm: 180 },
      { label: '—', mm: -36, note: 'bend deduction · IS 2502 Table 1' },
      { label: 'hooks', mm: 150 },
    ],
    cuttingLengthMm: 1240, lengthWorking: '2×(340 + 180) + hooks − deductions = 1240',
    barsPerMember: null, memberCount: null, totalBars: 668, spacingMm: 150,
    totalLengthM: 828.3, unitWeightKgPerM: 0.395, weightKg: 264.5,
    weightWorking: '8² ÷ 162 = 0.395 kg/m × 828.3 m = 264.5 kg',
    fromCallout: '4L-8TOR@150', handles: ['41C0'],
  }),
  row({
    mark: 'WALL', member: 'WALL panel', diaMm: 10, shapeCode: '00',
    segments: [{ label: 'a', mm: 2100 }],
    cuttingLengthMm: null, lengthWorking: 'vertical length = panel height + Ld — panel height not stated on this sheet',
    lengthSource: 'UNAVAILABLE',
    barsPerMember: null, memberCount: null, totalBars: 0, spacingMm: 200,
    face: 'both faces',
    totalLengthM: null, unitWeightKgPerM: 0.617, weightKg: null,
    fromCallout: 'WALL 10TOR@200 B/F', handles: [],
    status: 'unavailable',
    missing: 'Panel height above GL — answer the open question "What is the wall panel height?" to complete this row.',
    warnings: ['Row blocked: panel height is a named gap, not a guess.'],
  }),
];

/**
 * Fixed moments, never `Date.now()`.
 *
 * The demo is what tests and screenshots read, and a fixture whose dates move
 * every second cannot be asserted against or compared between two runs. These
 * are the same times on every machine; only the reader's zone shifts them.
 */
const at = (day: number, hour: number, minute: number): number =>
  Date.UTC(2026, 7, day, hour, minute);

export const demoStudioData: StudioData = {
  projectName: 'GAMCO Boundary Wall',
  groups: [
    {
      id: 'g-drawings',
      name: 'Drawings',
      folders: [
        {
          kind: 'folder', id: 'f-str', name: 'Structural',
          children: [
            { kind: 'file', id: 'd-str001', name: 'GAMCO-STR-001 boundary wall', rev: 'R2', current: true, state: 'ok', sheetId: 'gamco', discipline: 'Structural', at: at(12, 9, 24) },
            { kind: 'file', id: 'd-str002', name: 'GAMCO-STR-002 gate & pier detail', rev: 'R1', state: 'ok', sheetId: 'str002', discipline: 'Structural', at: at(12, 9, 31) },
            { kind: 'file', id: 'd-str003', name: 'GAMCO-STR-003 tie beam & coping sections', rev: 'R1', state: 'idle', discipline: 'Structural', ext: 'dxf', at: at(14, 16, 5) },
            { kind: 'file', id: 'd-oswl', name: 'OSWL foundation GA & reinf detail', rev: 'R7', current: true, state: 'warn', sheetId: 'oswl', discipline: 'Structural', at: at(21, 11, 47) },
          ],
        },
        {
          kind: 'folder', id: 'f-arc', name: 'Architectural',
          children: [
            { kind: 'file', id: 'd-arc001', name: 'GAMCO-ARC-001 site layout plan', rev: 'R3', current: true, state: 'ok', discipline: 'Architectural', ext: 'dxf', at: at(12, 9, 18) },
            { kind: 'file', id: 'd-arc002', name: 'GAMCO-ARC-002 boundary gate elevation', rev: 'R1', state: 'idle', discipline: 'Architectural', ext: 'dxf', at: at(13, 14, 2) },
          ],
        },
        {
          kind: 'folder', id: 'f-mep', name: 'MEP',
          children: [
            { kind: 'file', id: 'd-sld', name: 'Indore BTS HUB SLD', rev: 'R0', current: true, state: 'idle', discipline: 'MEP', ext: 'dxf', at: at(19, 10, 9) },
            { kind: 'file', id: 'd-mep001', name: 'GAMCO-MEP-001 external lighting layout', rev: 'R1', state: 'idle', discipline: 'MEP', ext: 'dxf', at: at(19, 10, 12) },
          ],
        },
      ],
    },
    {
      id: 'g-outputs',
      name: 'Outputs',
      folders: [
        {
          kind: 'folder', id: 'f-bbs', name: 'BBS',
          children: [
            { kind: 'file', id: 'o-bbs7', name: 'gamco-bbs-v7.csv', tag: 'v7', state: 'ok', dockTab: 'ask', ext: 'csv', at: at(29, 15, 41) },
            { kind: 'file', id: 'o-bbs6', name: 'gamco-bbs-v6.csv', tag: 'v6', state: 'idle', dockTab: 'ask', ext: 'csv', at: at(26, 12, 3) },
          ],
        },
        {
          kind: 'folder', id: 'f-qty', name: 'Quantities',
          children: [
            { kind: 'file', id: 'o-qty3', name: 'gamco-quantities-v3.csv', tag: 'v3', state: 'ok', dockTab: 'ask', ext: 'csv', at: at(28, 17, 22) },
            { kind: 'file', id: 'o-steel', name: 'steel-summary-by-diameter.csv', tag: 'v3', state: 'idle', dockTab: 'ask', ext: 'csv', at: at(28, 17, 22) },
          ],
        },
        {
          kind: 'folder', id: 'f-tender', name: 'Tender',
          children: [
            { kind: 'file', id: 'o-boq', name: 'BOQ — GAMCO boundary wall.xlsx', tag: 'xlsx', state: 'ok', ext: 'xlsx', at: at(30, 10, 55) },
            {
              kind: 'folder', id: 'f-addenda', name: 'Addenda', at: at(31, 9, 5),
              children: [
                { kind: 'file', id: 'o-add1', name: 'Addendum 1 — item corrections.pdf', tag: 'pdf', state: 'idle', ext: 'pdf', at: at(31, 9, 5) },
              ],
            },
          ],
        },
      ],
    },
  ],
  sheets: SHEETS,
  scheduleRows: SCHEDULE_ROWS,
  scheduleVersion: 'v7',
};
