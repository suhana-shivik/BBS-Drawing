// AutoCAD Color Index (ACI) → RGB.
//
// 0   = BYBLOCK (inherit from the placing INSERT)
// 256 = BYLAYER (inherit from the entity's layer)
// 1–9 and 250–255 are fixed; 10–249 follow the standard 24-hue wheel where
// each hue has 10 entries stepping brightness down, alternating full and
// half saturation.

const FIXED: Record<number, string> = {
  1: '#ff0000', // red
  2: '#ffff00', // yellow
  3: '#00ff00', // green
  4: '#00ffff', // cyan
  5: '#0000ff', // blue
  6: '#ff00ff', // magenta
  7: '#ffffff', // white (black on paper — callers handle plot inversion)
  8: '#808080',
  9: '#c0c0c0',
  250: '#333333',
  251: '#505050',
  252: '#696969',
  253: '#828282',
  254: '#bebebe',
  255: '#ffffff',
};

/** brightness / saturation pairs for the 10 entries of each hue */
const VALUE = [1.0, 1.0, 0.75, 0.75, 0.55, 0.55, 0.42, 0.42, 0.3, 0.3];
const SAT = [1.0, 0.5, 1.0, 0.5, 1.0, 0.5, 1.0, 0.5, 1.0, 0.5];

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n * 255)))
    .toString(16)
    .padStart(2, '0');
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return `#${hex2(r + m)}${hex2(g + m)}${hex2(b + m)}`;
}

const cache = new Map<number, string>();

/** ACI index → '#rrggbb'. Returns undefined for BYLAYER/BYBLOCK sentinels. */
export function aciToHex(index: number): string | undefined {
  if (!Number.isFinite(index)) return undefined;
  const i = Math.abs(Math.trunc(index)); // negative = layer switched off
  if (i === 0 || i === 256) return undefined; // BYBLOCK / BYLAYER
  const hit = cache.get(i);
  if (hit) return hit;
  let out = FIXED[i];
  if (!out) {
    if (i < 10 || i > 249) {
      out = '#ffffff';
    } else {
      const k = i - 10;
      const hue = Math.floor(k / 10) * 15;
      const sub = k % 10;
      out = hsvToHex(hue, SAT[sub], VALUE[sub]);
    }
  }
  cache.set(i, out);
  return out;
}
