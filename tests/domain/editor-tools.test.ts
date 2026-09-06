// The tool table — EDITOR_TOOLS_NOTE §8 and defect D3.
//
// D3: SOURCE kept the strip's TOOL_GROUPS and the status bar's TOOL_NAMES as
// two maps, and the second omitted scale, rotate, mirror, line, polyline,
// rectangle, circle and arc — so the bar printed the raw lowercase id. These
// tests exist to make a second, partial copy impossible to add quietly.
import { describe, expect, it } from 'vitest';
import {
  TOOL_DEFS,
  TOOL_GROUPS,
  TOOL_KEYS,
  TOOL_NAMES,
  isToolId,
  toolForKey,
  toolName,
  type ToolId,
} from '../../src/editor/tools';

/** the 22 tools §8 tabulates, with the letter that reaches them */
const EXPECTED: [ToolId, string, string][] = [
  ['select', 'Select', 'V'],
  ['pan', 'Pan', 'H'],
  ['scale', 'Scale', 'E'],
  ['rotate', 'Rotate', 'O'],
  ['mirror', 'Mirror', 'J'],
  ['line', 'Line', 'L'],
  ['polyline', 'Polyline', 'P'],
  ['rectangle', 'Rectangle', 'G'],
  ['circle', 'Circle', 'Q'],
  ['arc', 'Arc', 'K'],
  ['wall', 'Wall', 'W'],
  ['door', 'Door', 'D'],
  ['window', 'Window', 'N'],
  ['column', 'Column', 'C'],
  ['beam', 'Beam', 'B'],
  ['slab', 'Slab', 'S'],
  ['room', 'Room', 'R'],
  ['stair', 'Stair', 'T'],
  ['furniture', 'Furniture', 'F'],
  ['dimension', 'Dimension', 'I'],
  ['measure', 'Measure', 'M'],
  ['text', 'Text', 'X'],
];

describe('one source for tool ids, names and keys (D3)', () => {
  it('has all 22 tools, with the documented name and key', () => {
    expect(TOOL_DEFS).toHaveLength(22);
    for (const [id, name, key] of EXPECTED) {
      expect(TOOL_NAMES[id]).toBe(name);
      expect(TOOL_KEYS[key.toLowerCase()]).toBe(id);
    }
  });

  it('names the eight tools the old status bar could not name', () => {
    // the exact D3 list, verbatim from §13
    for (const id of [
      'scale',
      'rotate',
      'mirror',
      'line',
      'polyline',
      'rectangle',
      'circle',
      'arc',
    ] as ToolId[]) {
      expect(toolName(id)).not.toBe(id);
      expect(toolName(id)[0]).toBe(toolName(id)[0].toUpperCase());
    }
  });

  it('never falls through to a raw lowercase id', () => {
    for (const t of TOOL_DEFS) expect(toolName(t.id)).not.toBe(t.id);
    expect(toolName('not-a-tool')).toBe('Unknown tool');
    expect(isToolId('polyline')).toBe(true);
    expect(isToolId('nope')).toBe(false);
  });

  it('the groups are the flat list — one table, not two', () => {
    expect(TOOL_GROUPS.flat()).toEqual(TOOL_DEFS);
    expect(new Set(TOOL_DEFS.map((t) => t.id)).size).toBe(22);
  });

  it('every shortcut is unique and single-letter', () => {
    const keys = TOOL_DEFS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[A-Z]$/);
  });

  it('toolForKey is case-insensitive and rejects non-shortcuts', () => {
    expect(toolForKey('w')).toBe('wall');
    expect(toolForKey('W')).toBe('wall');
    expect(toolForKey('z')).toBeNull();
    expect(toolForKey('Enter')).toBeNull();
  });
});
