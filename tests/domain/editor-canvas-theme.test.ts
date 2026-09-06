// Chrome drawn ON the sheet must not follow the UI theme.
//
// STUDIO_DESIGN §2.1: "The viewport is #101216 in both themes. A drawing sheet
// is not a panel." The editor's labels obeyed half of that — `--canvas-text` is
// correctly near-white under BOTH themes — while the pill behind them borrowed
// `--floating`, a UI *panel* token that goes near-white in the light theme. The
// result was near-white text on a near-white pill: the live measurement, the
// one number the Measure tool exists to report, was invisible in light mode.
//
// A typecheck cannot see this and a render test would not have caught it either
// (both colours are perfectly valid strings). What makes it a bug is the
// RELATIONSHIP between two tokens, so that is what is pinned here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME = readFileSync(path.resolve(__dirname, '../../src/styles/theme.css'), 'utf8');
const CONTROLLER = readFileSync(path.resolve(__dirname, '../../src/editor/controller.ts'), 'utf8');
const EDITOR_CSS = readFileSync(path.resolve(__dirname, '../../src/editor/editor.css'), 'utf8');

/** every `--name: value;` declaration, in file order, so duplicates survive */
function declarations(css: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'g');
  for (const m of css.matchAll(re)) out.push(m[1].trim());
  return out;
}

describe('canvas chrome does not follow the UI theme', () => {
  it('defines the canvas tokens identically in the light and dark blocks', () => {
    // theme.css carries a light block and a dark block. A token used on the
    // sheet must read the same in both, or it flips with a theme the sheet
    // deliberately ignores.
    for (const token of ['bg-canvas', 'canvas-text', 'canvas-floating', 'canvas-floating-border']) {
      const values = declarations(THEME, token);
      expect(values.length, `--${token} should be declared in both theme blocks`).toBe(2);
      expect(values[0], `--${token} must not differ between themes`).toBe(values[1]);
    }
  });

  it('keeps the UI panel token theme-dependent — it is not a canvas token', () => {
    // The counterpart of the rule above: --floating SHOULD flip. This is why
    // the editor may not use it, and asserting it keeps the test honest if
    // someone "fixes" the bug by flattening the panel token instead.
    const floating = declarations(THEME, 'floating');
    expect(floating.length).toBe(2);
    expect(floating[0]).not.toBe(floating[1]);
  });

  it('reads canvas tokens, never UI panel tokens, for label chrome', () => {
    const colours = CONTROLLER.slice(CONTROLLER.indexOf('this.colors = {'));
    const block = colours.slice(0, colours.indexOf('};') + 2);
    expect(block).toContain("cvar('--canvas-floating'");
    expect(block).toContain("cvar('--canvas-floating-border'");
    // the regression itself: the pill must not be painted with the panel token
    expect(block).not.toMatch(/cvar\('--floating'/);
    expect(block).not.toMatch(/cvar\('--panel'/);
  });

  it('styles the typed-coordinate readout with canvas tokens too', () => {
    const rule = EDITOR_CSS.slice(EDITOR_CSS.indexOf('.editor2d-precision'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('var(--canvas-floating)');
    expect(body).toContain('var(--canvas-text)');
    expect(body).not.toContain('var(--floating)');
  });
});
