// ============================================================
// The hand-off: BBS consumes a package, and never rebuilds one.
//
// §15 and §21 are the same promise from two sides — SPLIT ONCE, SAVE, USE
// MANY TIMES. The failure mode this guards is subtle and expensive: a BBS run
// that quietly re-segments the sheet still produces an answer, so nothing
// looks broken, and every run pays for a layout somebody already worked out.
// ============================================================
import { describe, expect, it } from 'vitest';
import { splitDrawing, type ChatReply, type ChatTransport } from '../../src/cad/understanding/orchestrator';
import { stalenessOf } from '../../src/cad/understanding/store';
import { hashDocument } from '../../src/cad/understanding/hash';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';
import { threeAreaDoc } from '../helpers/cadDoc';

/** Build a real package from the real splitter, driven by a scripted model. */
async function buildPackage(): Promise<DrawingUnderstandingPackage> {
  const script: ChatReply[] = [
    {
      content: '',
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'propose_section',
            arguments: JSON.stringify({
              label: 'SECTION AT 1-1',
              kind: 'detail',
              handles: ['AAA1', 'AAA2'],
              memberHints: [{ mark: 'C1', basis: 'label visible in region' }],
            }),
          },
        },
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'propose_section',
            arguments: JSON.stringify({ label: 'GENERAL NOTES', kind: 'note', handles: ['CCC1', 'CCC2'] }),
          },
        },
      ],
    },
    { content: JSON.stringify({ summary: 'A three-area sheet.', relationships: [], unresolved: [] }), toolCalls: [] },
  ];
  let i = 0;
  const transport: ChatTransport = async () => script[Math.min(i++, script.length - 1)];
  const pkg = await splitDrawing(threeAreaDoc(), {
    projectId: 'p1',
    skipPng: true,
    maxRounds: 4,
    transport,
  });
  // give one section an image so the panel path is exercised too
  pkg.sections[0].png = 'data:image/png;base64,AAAA';
  return pkg;
}

// v1: legacy path not ported — the 'BBS consumes a saved package' suite drove
// readDrawingWithTools from src/cad/bbs/agent (the legacy tool-loop reader).
// The orchestrated BBS path has its own consumption tests; what remains here
// is the pure staleness rule, which uses only ported modules.

describe('a package is tied to the drawing version', () => {
  // The storage round-trip needs IndexedDB, which this environment does not
  // provide; the RULE that decides whether a package may be trusted is pure
  // and is what is tested here.
  it('accepts a package whose hash still matches the drawing', async () => {
    const pkg = await buildPackage();
    const status = stalenessOf(pkg, pkg.sourceDrawingHash);
    expect(status.stale).toBe(false);
    expect(status.reason).toBeUndefined();
  });

  it('reports a changed drawing as stale rather than using the old sections', async () => {
    const pkg = await buildPackage();
    const revised = threeAreaDoc();
    revised.entities.push(revised.entities[0]);
    revised.extents = { min: { x: -500, y: -500 }, max: { x: 2000, y: 2000 } };

    const status = stalenessOf(pkg, await hashDocument(revised));
    expect(status.stale).toBe(true);
    expect(status.reason).toMatch(/older version/i);
    // the package still comes back, so a caller can SAY it is stale rather
    // than silently having nothing
    expect(status.package.sections).toHaveLength(2);
  });

  it('does not cry wolf when the two hashes are different KINDS', async () => {
    const pkg = await buildPackage();
    const status = stalenessOf(pkg, 'a'.repeat(64)); // a byte hash vs a doc: hash
    expect(status.stale).toBe(true);
    expect(status.reason).toMatch(/different kind of source fingerprint/i);
  });

  it('the drawing hash really does change when the drawing changes', async () => {
    const a = threeAreaDoc();
    const b = threeAreaDoc();
    b.entities.push(b.entities[0]);
    expect(await hashDocument(a)).not.toBe(await hashDocument(b));
  });
});
