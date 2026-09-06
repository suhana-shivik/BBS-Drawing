// AN ENDPOINT THAT TAKES A FILENAME FROM A BROWSER AND WRITES IT.
//
// That is a directory traversal waiting to happen, and it is the only part of
// the log writer that can do damage — everything else fails by writing nothing.
// So the name is REBUILT rather than checked: rejecting bad input means
// enumerating what is bad, and the list of ways to spell `..` is longer than it
// looks. Each segment is reduced to a safe alphabet, anything left that is all
// dots is dropped, and what survives cannot be anything but a plain name.
//
// The tests below are the list of ways somebody would try.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeLogPath } from '../../vite-plugins/logWriter';
import { runLogPath } from '../../src/studio/logSink';

describe('the path can never leave the log directory', () => {
  it('keeps an ordinary nested name', () => {
    expect(safeLogPath('interviews/demo/2026-09-03-101500-BBS-TEST.md')).toBe(
      'interviews/demo/2026-09-03-101500-BBS-TEST.md',
    );
  });

  it('drops every form of "up one level"', () => {
    // `..` as a segment, doubled, and the `....//` trick that survives a naive
    // single-pass strip.
    expect(safeLogPath('../secrets.md')).toBe('secrets.md');
    expect(safeLogPath('../../../../etc/passwd')).toBe('etc/passwd.md');
    expect(safeLogPath('a/../../b.md')).toBe('a/b.md');
    expect(safeLogPath('....//....//x.md')).toBe('x.md');
    expect(safeLogPath('..')).toBeNull();
    expect(safeLogPath('../..')).toBeNull();
  });

  it('refuses to be absolute, on either platform', () => {
    expect(safeLogPath('/etc/passwd')).toBe('etc/passwd.md');
    // A drive letter is not a path root once the colon is gone.
    expect(safeLogPath('C:\\Windows\\system32\\x.md')).toBe('C-/Windows/system32/x.md');
    expect(safeLogPath('\\\\server\\share\\x.md')).toBe('server/share/x.md');
  });

  it('strips anything that is not a plain name character', () => {
    // NULs, newlines, semicolons, wildcards, url-encoded slashes.
    expect(safeLogPath('a\u0000b.md')).toBe('a-b.md');
    // Every unsafe run collapses to dashes. What matters is not the exact
    // spelling of the result but that a shell fragment cannot survive as one —
    // and nothing here is ever handed to a shell in any case.
    expect(safeLogPath('note\n; rm -rf /.md')).toBe('note---rm--rf-/.md');
    // `%2f` stops being a slash once `%` is gone, so this stays ONE filename.
    // It keeps its leading dots, and that is fine: a file NAMED "..-2f…" is
    // not the SEGMENT `..`, and it resolves inside the root like any other.
    expect(safeLogPath('..%2f..%2fx.md')).toBe('..-2f..-2fx.md');
  });

  it('resolves inside the root for every one of those, which is the real test', () => {
    // The spelling of a sanitised name is a detail; where it lands is not.
    // This is the property the writer's own final guard checks, asserted here
    // against everything a caller might try.
    const root = path.resolve('/srv/app/logs');
    for (const attempt of [
      '../secrets.md',
      '../../../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\system32\\x.md',
      '\\\\server\\share\\x.md',
      '....//....//x.md',
      '..%2f..%2fx.md',
      'a\u0000b.md',
    ]) {
      const rel = safeLogPath(attempt);
      expect(rel, attempt).not.toBeNull();
      const full = path.resolve(root, rel!);
      expect(full.startsWith(root + path.sep), `${attempt} -> ${full}`).toBe(true);
    }
  });

  it('always ends in .md, whatever was asked for', () => {
    // The endpoint writes Markdown. A request for a .js or a .html is a
    // request to plant a file that something else might execute or serve.
    expect(safeLogPath('run')).toBe('run.md');
    expect(safeLogPath('evil.html')).toBe('evil.html.md');
    expect(safeLogPath('evil.js')).toBe('evil.js.md');
    expect(safeLogPath('fine.MD')).toBe('fine.MD');
  });

  it('refuses what is left of nothing', () => {
    expect(safeLogPath('')).toBeNull();
    expect(safeLogPath('///')).toBeNull();
    expect(safeLogPath('.')).toBeNull();
  });

  it('refuses a name too deep or too long to be one of ours', () => {
    expect(safeLogPath('a/b/c/d/e/f/g/h/i/j.md')).toBeNull();
    expect(safeLogPath(`${'x'.repeat(300)}.md`)).toBeNull();
  });
});

describe('the name a run is filed under', () => {
  it('leads with a sortable timestamp, so a listing is chronological', () => {
    const at = new Date(2026, 8, 3, 10, 15, 0).getTime();
    expect(runLogPath('Demo', 'BBS-TEST-columns.dxf', at)).toBe(
      'interviews/Demo/2026-09-03-101500-BBS-TEST-columns.md',
    );
  });

  it('drops the CAD extension rather than turning it into a word', () => {
    const at = new Date(2026, 0, 9, 5, 6, 7).getTime();
    expect(runLogPath('P', 'Foundations drawings.DWG', at)).toBe(
      'interviews/P/2026-01-09-050607-Foundations-drawings.md',
    );
  });

  it('survives a project or drawing name a file manager would refuse', () => {
    const at = new Date(2026, 0, 1, 0, 0, 0).getTime();
    // A run of unsafe characters collapses to ONE dash, so " / " and " (" do
    // not each leave a scar in the directory name.
    const p = runLogPath('GAMCO / site (R2)', '', at);
    expect(p).toBe('interviews/GAMCO-site-R2/2026-01-01-000000-unknown.md');
    // and whatever it produced must still survive the writer's own rebuild
    expect(safeLogPath(p)).toBe(p);
  });
});
