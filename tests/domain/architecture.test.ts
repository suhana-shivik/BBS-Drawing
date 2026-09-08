// ============================================================
// THE LAYERS, MADE EXECUTABLE.
//
// The pipeline has a direction:
//
//   DRAWING INPUT → PARSER → VISUAL REGIONS → LOGICAL SECTIONS
//     → SEMANTIC INTERPRETATION → DATAFACTS → BBS INPUT MODEL
//     → CALCULATION ENGINE → SUMMARY → RECONCILIATION → VALIDATION
//     → FILE / EDITOR
//
// A layer may depend on what comes BEFORE it and on the shared model. It may
// not reach forward, and it may not reach sideways into the app or the UI.
// Written down in prose, that rule lasts until the first hurried import.
// Written down here, it is checked on every run.
//
// These tests read the import statements. They are deliberately dumb: a rule
// a reader cannot verify by eye is a rule nobody will keep.
// ============================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    const full = path.join(ROOT, rel);
    if (statSync(full).isDirectory()) filesUnder(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

interface Import {
  file: string;
  spec: string;
  /** `import type { … }` — a shape, not a dependency on behaviour */
  typeOnly: boolean;
}

function importsOf(files: readonly string[]): Import[] {
  const out: Import[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of source.matchAll(/^import\s+(type\s+)?([\s\S]*?)from\s+'([^']+)'/gm)) {
      out.push({ file, spec: m[3], typeOnly: Boolean(m[1]) || /^\s*type\s/.test(m[2]) });
    }
  }
  return out;
}

const describeViolations = (bad: readonly Import[]): string =>
  bad.map((i) => `${i.file} → ${i.spec}`).join('\n');

// ------------------------------------------------------------
// the calculation engine
// ------------------------------------------------------------
describe('the calculation engine depends on nothing above it', () => {
  const engine = importsOf(filesUnder('calculations'));

  it('never imports the app, the UI, or the persistence layer', () => {
    const forward = engine.filter((i) => /\/(studio|components|data|register|auth|editor|interview)\//.test(i.spec));
    expect(describeViolations(forward)).toBe('');
  });

  it('takes only SHAPES from the drawing-reading layer, never behaviour', () => {
    // `src/cad/bbs/types.ts` is the shared model both sides are written
    // against; importing its types is not a dependency on the reader. Pulling
    // a FUNCTION out of `cad/` would be: that is how `isLinearMember` and
    // `describeBar` ended up making the engine impossible to run without the
    // drawing reader behind it, which is why they now live here.
    const behaviour = engine.filter((i) => i.spec.includes('/cad/') && !i.typeOnly);
    expect(describeViolations(behaviour)).toBe('');
  });

  it('is computed from its inputs alone — no clock, no randomness', () => {
    // The same rows in must give the same schedule out, or a rebuild can
    // differ from the build it is checked against and nobody can tell which
    // is right. (`Date.now` is fine in a TIMESTAMP; it is not fine in a
    // calculation, and the engine has no business with either.)
    for (const file of filesUnder('calculations')) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      expect(source, `${file} reads the clock`).not.toMatch(/\bDate\.now\(|new Date\(/);
      expect(source, `${file} uses randomness`).not.toMatch(/Math\.random\(/);
    }
  });
});

// ------------------------------------------------------------
// the domain: IS 456 / IS 2502 / IS 1786
// ------------------------------------------------------------
describe('the domain layer knows the codes, not the app', () => {
  const domain = importsOf(filesUnder('src/domain'));

  it('never imports the app, the UI or the BBS pipeline', () => {
    const bad = domain.filter((i) => /\/(studio|components|data|register|auth|cad\/bbs)\//.test(i.spec));
    expect(describeViolations(bad)).toBe('');
  });
});

// ------------------------------------------------------------
// the drawing-reading layer
// ------------------------------------------------------------
describe('the drawing reader does not reach into the app', () => {
  const reader = importsOf([...filesUnder('src/cad'), ...filesUnder('src/facts')]);

  it('never imports the studio, the components or the auth layer', () => {
    const bad = reader.filter((i) => /\/(studio|components|auth)\//.test(i.spec));
    expect(describeViolations(bad)).toBe('');
  });
});

// ------------------------------------------------------------
// one engine
// ------------------------------------------------------------
describe('there is exactly one calculation engine', () => {
  it('nothing in the app imports `core/bbs/engine`', () => {
    // It carries its own cutting-length and weight arithmetic (`d²/162`) and
    // is reachable only from its own test. Left in place — it is covered, and
    // deleting a test to tidy a file is a bad trade — but nothing may build on
    // it. `calculations/schedule.ts` is the one place a row becomes a BbsRow.
    const everything = importsOf([...filesUnder('src'), ...filesUnder('calculations')]);
    const users = everything.filter((i) => i.spec.includes('core/bbs/engine'));
    expect(describeViolations(users)).toBe('');
  });

  it('only the engine and the domain compute a unit weight', () => {
    // `d² ÷ 162` is IS 1786's nominal mass. Every appearance outside the
    // domain table and a printed working line is a second implementation of
    // the same rule, and two of them drift.
    const offenders: string[] = [];
    for (const file of [...filesUnder('src'), ...filesUnder('calculations')]) {
      if (file.startsWith('src/domain/india/')) continue;
      if (file.startsWith('src/studio/demoData')) continue; // fixture prose, not arithmetic
      if (file.startsWith('src/core/bbs/')) continue; // the unused engine, pinned above
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const line of source.split('\n')) {
        if (/^\s*(\/\/|\*)/.test(line)) continue; // a comment explaining the rule is not the rule
        if (/\/\s*162\b/.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

// ------------------------------------------------------------
// no drawing is special
// ------------------------------------------------------------
describe('no real drawing is hardcoded in the engine', () => {
  it('the calculation layer names no member from any sheet', () => {
    // F1…F9, P1, C1, PB03 are marks off the drawings this was built against.
    // A mark in the engine is a rule that works for one client's sheet and
    // silently misreads everyone else's.
    const offenders: string[] = [];
    for (const file of filesUnder('calculations')) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const [i, line] of source.split('\n').entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        // a quoted mark-shaped literal: 'F1', "P1", `C12`
        const hit = line.match(/['"`](F\d{1,2}|P\d{1,2}|C\d{1,2}|PB\d{2,3}|TB\d{1,2})['"`]/);
        if (hit) offenders.push(`${file}:${i + 1} ${hit[1]}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});
