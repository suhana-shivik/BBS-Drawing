// Typed-coordinate precision input for point-based drawing tools.
//
// Grammar (all forms are evaluated relative to `ref`, the last placed
// point of the tool currently awaiting its next click):
//   "500"        distance along the current implied direction (the ray
//                from `ref` through the live cursor point — which already
//                reflects angle-snap/ortho-lock when the tool uses it)
//   "300,150"    relative dx,dy from ref
//   "@300,150"   same as above — the '@' prefix is accepted but optional
//   "500a90"     distance 500 at an explicit angle of 90 degrees,
//                measured the same way model angles are (CCW from +x)
//
// A simpler alternative to a two-field "distance, Tab, angle" UI: the
// whole expression lives in one buffer so a single floating overlay and a
// single onKeyDown handler can drive it.
import type { Vec2 } from '../core/types';
import { add, len, mul, norm, sub } from '../core/geometry';

const NUM = String.raw`-?\d*\.?\d+`;
const RE_DIST_ANGLE = new RegExp(`^@?(${NUM})a(${NUM})$`, 'i');
const RE_RELATIVE = new RegExp(`^@?(${NUM}),(${NUM})$`);
const RE_DISTANCE = new RegExp(`^(${NUM})$`);

/** returns the resolved model point, or null while the buffer is incomplete/invalid */
export function parsePrecisionInput(raw: string, ref: Vec2, dirPoint: Vec2): Vec2 | null {
  const s = raw.trim();
  if (!s) return null;

  let m = RE_DIST_ANGLE.exec(s);
  if (m) {
    const d = parseFloat(m[1]);
    const ang = (parseFloat(m[2]) * Math.PI) / 180;
    return { x: ref.x + d * Math.cos(ang), y: ref.y + d * Math.sin(ang) };
  }

  m = RE_RELATIVE.exec(s);
  if (m) {
    return add(ref, { x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }

  m = RE_DISTANCE.exec(s);
  if (m) {
    const dir = norm(sub(dirPoint, ref));
    if (len(dir) < 1e-9) return null;
    return add(ref, mul(dir, parseFloat(m[1])));
  }

  return null;
}

/**
 * Bare-number path for the transform tools, whose typed value is a scale
 * factor or an angle in degrees rather than a point: the coordinate grammar
 * above has nothing to resolve them against. Returns null while the buffer is
 * still incomplete or not a plain number.
 */
export function parseNumberInput(raw: string): number | null {
  const m = RE_DISTANCE.exec(raw.trim());
  return m ? parseFloat(m[1]) : null;
}
