// The 22 drafting tools — ONE source for the id, the display name, the
// keyboard letter and the icon name of every tool in the strip.
//
// DEFECT D3 (EDITOR_TOOLS_NOTE §13): in SOURCE the strip's TOOL_GROUPS
// (ToolPalette.tsx) and the status bar's TOOL_NAMES (StatusBar.tsx) were two
// separate maps, and the second one omitted scale, rotate, mirror, line,
// polyline, rectangle, circle and arc — so the bar fell through to the raw
// lowercase id and read "polyline" beside properly-cased neighbours. There is
// now exactly one table. `toolName()` is total over ToolId, so no consumer can
// fall through to an id again.
//
// DEFECT D1/D2 (§13): the tool letters live here as data, not as a second
// `window` keydown listener. The EditorController is the single keyboard owner
// (see controller.ts `onKeyDown`); a UI strip renders `TOOL_DEFS[].key` for the
// tooltip and must NOT register a listener of its own.

/** Every tool the editor can be switched to. */
export type ToolId =
  | 'select'
  | 'pan'
  | 'scale'
  | 'rotate'
  | 'mirror'
  | 'line'
  | 'polyline'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'wall'
  | 'door'
  | 'window'
  | 'column'
  | 'beam'
  | 'slab'
  | 'room'
  | 'stair'
  | 'furniture'
  | 'dimension'
  | 'measure'
  | 'text';

export interface ToolDef {
  id: ToolId;
  /** display name — the status bar and the strip both read THIS */
  name: string;
  /** single-letter shortcut, upper case for display */
  key: string;
  /** icon name for the shell's icon set; the editor never draws it */
  icon: string;
}

/**
 * Grouped exactly as the strip renders them (dividers between groups):
 * pointer · transforms · drafting primitives · building · spatial · annotation.
 */
export const TOOL_GROUPS: readonly (readonly ToolDef[])[] = [
  [
    { id: 'select', name: 'Select', key: 'V', icon: 'select' },
    { id: 'pan', name: 'Pan', key: 'H', icon: 'pan' },
  ],
  [
    { id: 'scale', name: 'Scale', key: 'E', icon: 'scale' },
    { id: 'rotate', name: 'Rotate', key: 'O', icon: 'rotate' },
    { id: 'mirror', name: 'Mirror', key: 'J', icon: 'mirror' },
  ],
  [
    { id: 'line', name: 'Line', key: 'L', icon: 'line' },
    { id: 'polyline', name: 'Polyline', key: 'P', icon: 'polyline' },
    { id: 'rectangle', name: 'Rectangle', key: 'G', icon: 'rectangle' },
    { id: 'circle', name: 'Circle', key: 'Q', icon: 'circle' },
    { id: 'arc', name: 'Arc', key: 'K', icon: 'arc' },
  ],
  [
    { id: 'wall', name: 'Wall', key: 'W', icon: 'wall' },
    { id: 'door', name: 'Door', key: 'D', icon: 'door' },
    { id: 'window', name: 'Window', key: 'N', icon: 'window' },
    { id: 'column', name: 'Column', key: 'C', icon: 'column' },
    { id: 'beam', name: 'Beam', key: 'B', icon: 'beam' },
    { id: 'slab', name: 'Slab', key: 'S', icon: 'slab' },
  ],
  [
    { id: 'room', name: 'Room', key: 'R', icon: 'room' },
    { id: 'stair', name: 'Stair', key: 'T', icon: 'stair' },
    { id: 'furniture', name: 'Furniture', key: 'F', icon: 'furniture' },
  ],
  [
    { id: 'dimension', name: 'Dimension', key: 'I', icon: 'dimension' },
    { id: 'measure', name: 'Measure', key: 'M', icon: 'measure' },
    { id: 'text', name: 'Text', key: 'X', icon: 'text' },
  ],
];

/** flat list, in strip order */
export const TOOL_DEFS: readonly ToolDef[] = TOOL_GROUPS.flat();

/** id -> definition. Complete by construction. */
export const TOOL_BY_ID: Readonly<Record<ToolId, ToolDef>> = Object.fromEntries(
  TOOL_DEFS.map((t) => [t.id, t]),
) as Record<ToolId, ToolDef>;

/**
 * lower-case letter -> tool id. Exported so a UI strip can render the same
 * letters it shows in tooltips WITHOUT registering a second window listener —
 * that second listener is the root cause of D1 and D2.
 */
export const TOOL_KEYS: Readonly<Record<string, ToolId>> = Object.fromEntries(
  TOOL_DEFS.map((t) => [t.key.toLowerCase(), t.id]),
);

/** id -> display name. Total over ToolId: D3 cannot come back. */
export const TOOL_NAMES: Readonly<Record<ToolId, string>> = Object.fromEntries(
  TOOL_DEFS.map((t) => [t.id, t.name]),
) as Record<ToolId, string>;

/** Display name for any string; unknown ids are reported, never printed raw. */
export function toolName(id: string): string {
  return TOOL_NAMES[id as ToolId] ?? 'Unknown tool';
}

export function isToolId(id: string): id is ToolId {
  return Object.prototype.hasOwnProperty.call(TOOL_NAMES, id);
}

/** The tool a bare key press selects, or null when the key is not a shortcut. */
export function toolForKey(key: string): ToolId | null {
  return TOOL_KEYS[key.toLowerCase()] ?? null;
}
