import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BbsChatResult, BbsChatRow } from '../../src/cad/bbs/chatResult';
import {
  ChatArtifactStore,
  artifactMessageFor,
  assistantTurn,
  questionMessage,
  retypedTableIn,
  versionId,
} from '../../src/interview/artifact';

const row = (over: Partial<BbsChatRow> = {}): BbsChatRow =>
  ({
    id: 'TB-M1',
    barMark: 'TB-M1',
    memberMark: 'TB',
    description: 'main T16',
    diameterMm: 16,
    barsPerMember: 4,
    memberCount: 1,
    totalBars: 18,
    cuttingLengthMm: 12000,
    totalLengthM: 216,
    unitWeightKgPerM: 1.58,
    totalWeightKg: 341,
    working: ['weight: 216.00 m × 1.58 kg/m = 341.28 kg'],
    evidenceIds: ['CALL-014'],
    status: 'verified',
    ...over,
  }) as BbsChatRow;

/**
 * Built with an assertion rather than a literal: BbsChatResult is owned by the
 * engine and gains fields; this test is about the STORE, not about that shape.
 */
const result = (over: Partial<BbsChatResult> = {}): BbsChatResult =>
  ({
    id: 'engine-run',
    status: 'partial',
    project: { drawingName: 'GAMCO-STR-001' },
    members: [],
    rows: [row()],
    diameterSummary: [],
    netWeightKg: 341,
    assumptions: [],
    warnings: [],
    gaps: [],
    verification: { passed: [], failures: [], ok: false },
    ...over,
  }) as BbsChatResult;

describe('§7.2 — the message carries a reference, and the store holds the schedule', () => {
  it('publishes a version and hands back a reference, never a table', () => {
    const store = new ChatArtifactStore();
    const artifact = store.publish('ask-tb', result(), { askedAs: 'give me the BBS for the tie beam' });

    expect(artifact.ref).toEqual({ type: 'bbs-result', resultId: versionId('ask-tb', 1) });
    expect(store.resolve(artifact.ref)?.rows[0].totalWeightKg).toBe(341);

    const message = artifactMessageFor(artifact);
    expect(message.artifact).toEqual(artifact.ref);
    expect(message.content).not.toMatch(/341|216|12000/);
  });

  it('is versioned: asking again after answering yields v8 ALONGSIDE v7', () => {
    const store = new ChatArtifactStore();
    for (let n = 1; n <= 8; n++) {
      store.publish('ask-tb', result({ netWeightKg: 300 + n, rows: [row({ totalWeightKg: 300 + n })] }));
    }

    const versions = store.versions('ask-tb');
    expect(versions).toHaveLength(8);
    expect(store.latest('ask-tb')?.version).toBe(8);

    const v7 = store.get(versionId('ask-tb', 7));
    const v8 = store.get(versionId('ask-tb', 8));
    expect(v7?.result.rows[0].totalWeightKg).toBe(307);
    expect(v8?.result.rows[0].totalWeightKg).toBe(308);
    // what the user saw when they made a decision is still exactly what it was
    expect(v7?.result.id).toBe(versionId('ask-tb', 7));
    expect(artifactMessageFor(v8!).content).toMatch(/v7 stays above it, unchanged/);
  });

  it('stores an immutable artifact — a published result cannot be edited in place', () => {
    const store = new ChatArtifactStore();
    const artifact = store.publish('ask-tb', result());
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.result)).toBe(true);
    expect(() => {
      (artifact.result as { netWeightKg?: number }).netWeightKg = 0;
    }).toThrow(TypeError);
  });

  it('keeps lineages apart', () => {
    const store = new ChatArtifactStore();
    store.publish('ask-tb', result());
    store.publish('ask-wall', result());
    store.publish('ask-tb', result());
    expect(store.versions('ask-tb')).toHaveLength(2);
    expect(store.versions('ask-wall')).toHaveLength(1);
    expect(store.lineages().sort()).toEqual(['ask-tb', 'ask-wall']);
  });

  it('carries a batch of questions with no artifact at all (§7.4)', () => {
    const message = questionMessage([
      {
        id: 'q1',
        question: 'What is the total run?',
        why: 'every quantity multiplies out of it',
        blocks: ['WALL'],
        evidence: [],
        answerType: 'number-m',
        writesTo: { field: 'run' },
      },
    ]);
    expect(message.artifact).toBeUndefined();
    expect(message.questions).toHaveLength(1);
  });
});

describe('§7.2 — the model never writes the table', () => {
  it('recognises a retyped schedule', () => {
    expect(
      retypedTableIn(
        ['| Mark | Ø | Weight |', '| --- | --- | --- |', '| TB-M1 | 16 | 341.0 |'].join('\n'),
      ),
    ).toBe(true);
    expect(retypedTableIn('| TB-M1 | 16 | 341.0 |\n| TB-M2 | 12 | 88.0 |')).toBe(true);
    expect(retypedTableIn('The bar bending schedule is ready, with gaps listed.')).toBe(false);
    expect(retypedTableIn('C1 and C2 carry link spacing | see the note')).toBe(false);
  });

  it('REFUSES to publish a message that retyped one, rather than repairing it', () => {
    const verdict = assistantTurn(
      ['Here is the schedule:', '| Mark | Weight |', '| --- | --- |', '| TB-M1 | 341.0 |'].join('\n'),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/never writes the table/);
  });

  it('publishes a plain message with its artifact reference', () => {
    const store = new ChatArtifactStore();
    const artifact = store.publish('ask-tb', result());
    const verdict = assistantTurn('The schedule is ready — six rows completed.', artifact);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.message.artifact).toEqual(artifact.ref);
  });

  it('has NO path anywhere in src/interview that renders a schedule as text', () => {
    const dir = join(process.cwd(), 'src', 'interview');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      // no column padding, no pipe-joined rows, no markdown fences: the three
      // ways a table gets built by hand
      expect(source, `${file} pads columns`).not.toMatch(/\.pad(?:End|Start)\(/);
      expect(source, `${file} joins cells with pipes`).not.toMatch(/\.join\(\s*['"`][^'"`]*\|/);
      expect(source, `${file} opens a code fence`).not.toMatch(/```/);
      // and nothing here reads a cell out of a row for display
      expect(source, `${file} formats a cell`).not.toMatch(/\bcellValue\b|\btoFixed\(/);
      expect(source, `${file} names a table renderer`).not.toMatch(
        /function\s+\w*(?:render|format|print)\w*(?:Table|Schedule|Rows)\b/i,
      );
    }
  });
});
