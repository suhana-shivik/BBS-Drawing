// View transform for the 2D editor: model mm (y up/north) <-> screen CSS px (y down).
import type { Vec2 } from '../core/types';
import { clamp } from '../core/geometry';

export interface View {
  /** pixels per millimetre */
  scale: number;
  /** screen x of model origin */
  tx: number;
  /** screen y of model origin */
  ty: number;
}

/**
 * px per model mm. The floor has to accommodate whole imported drawings:
 * a site or services sheet can span kilometres (one fixture here is 5.8 km
 * across), and at 0.0005 the view would clamp before it finished fitting.
 */
export const MIN_SCALE = 0.00002;
export const MAX_SCALE = 12;

export const toScreen = (v: View, p: Vec2): Vec2 => ({
  x: p.x * v.scale + v.tx,
  y: -p.y * v.scale + v.ty,
});

export const toModel = (v: View, s: Vec2): Vec2 => ({
  x: (s.x - v.tx) / v.scale,
  y: (v.ty - s.y) / v.scale,
});

/** zoom keeping the model point under `screen` fixed */
export function zoomAt(v: View, screen: Vec2, factor: number): View {
  const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
  if (scale === v.scale) return v;
  const m = toModel(v, screen);
  return { scale, tx: screen.x - m.x * scale, ty: screen.y + m.y * scale };
}

export const panBy = (v: View, dx: number, dy: number): View => ({
  scale: v.scale,
  tx: v.tx + dx,
  ty: v.ty + dy,
});

/** fit a model-space bounding box into a w×h px viewport with ~12% margin */
export function fitView(w: number, h: number, min: Vec2, max: Vec2): View {
  const bw = Math.max(max.x - min.x, 1000);
  const bh = Math.max(max.y - min.y, 1000);
  const scale = clamp(
    Math.min(w / (bw * 1.25), h / (bh * 1.25)),
    MIN_SCALE,
    MAX_SCALE,
  );
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  return { scale, tx: w / 2 - cx * scale, ty: h / 2 + cy * scale };
}
