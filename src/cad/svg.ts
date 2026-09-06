// DisplayList → SVG.
//
// Consumes exactly the same display list the screen renderer paints, so an
// exported sheet cannot disagree with what the user was looking at.
import type { DisplayList, DisplayPath, DisplayText } from './types';

export interface SvgOptions {
  /** output width in px; height follows the content aspect ratio */
  width?: number;
  /** page background; null = transparent */
  background?: string | null;
  /** margin in px */
  margin?: number;
  fontFamily?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

export function displayListToSVG(list: DisplayList, opts: SvgOptions = {}): string {
  const width = opts.width ?? 2000;
  const margin = opts.margin ?? 20;
  const bg = opts.background === undefined ? '#ffffff' : opts.background;
  const font = opts.fontFamily ?? 'Helvetica, Arial, sans-serif';

  const w = Math.max(1e-6, list.max.x - list.min.x);
  const h = Math.max(1e-6, list.max.y - list.min.y);
  const scale = (width - margin * 2) / w;
  const height = Math.round(h * scale + margin * 2);

  // model → paper: y flips, because SVG y grows downward
  const X = (x: number): number => margin + (x - list.min.x) * scale;
  const Y = (y: number): number => margin + (list.max.y - y) * scale;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" ` +
      `width="${n(width)}" height="${n(height)}" font-family="${font}">`,
  );
  if (bg) out.push(`<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="${bg}"/>`);

  for (const op of list.ops) {
    if (op.kind === 'path') {
      const p = op as DisplayPath;
      let d = '';
      for (const sub of p.subpaths) {
        if (sub.length < 2) continue;
        d += `M${n(X(sub[0].x))} ${n(Y(sub[0].y))}`;
        for (let i = 1; i < sub.length; i++) d += `L${n(X(sub[i].x))} ${n(Y(sub[i].y))}`;
        if (p.closed) d += 'Z';
      }
      if (!d) continue;
      // lineweight is mm; 0 means hairline
      const lw = p.lineweight > 0 ? Math.max(0.1, p.lineweight * scale) : 0.35;
      const attrs: string[] = [
        `d="${d}"`,
        `fill="${p.fill ?? 'none'}"`,
        p.fill ? 'fill-rule="evenodd"' : '',
        `stroke="${p.stroke ?? 'none'}"`,
        `stroke-width="${n(lw)}"`,
        'stroke-linecap="round"',
        'stroke-linejoin="round"',
      ];
      if (p.dash.length) {
        attrs.push(`stroke-dasharray="${p.dash.map((v) => n(Math.max(0.1, v * scale))).join(' ')}"`);
      }
      if (p.alpha < 1) attrs.push(`opacity="${n(p.alpha)}"`);
      out.push(`<path ${attrs.filter(Boolean).join(' ')}/>`);
    } else {
      const t = op as DisplayText;
      const size = t.height * scale;
      if (size < 1.2) continue; // unreadable at this scale
      const anchor = t.hAlign === 'left' ? 'start' : t.hAlign === 'right' ? 'end' : 'middle';
      const baseline =
        t.vAlign === 'top' ? 'hanging' : t.vAlign === 'middle' ? 'central' : 'alphabetic';
      const x = X(t.position.x);
      const y = Y(t.position.y);
      const lines = t.text.split('\n');
      const lh = size * 1.25;
      const y0 =
        lines.length > 1
          ? t.vAlign === 'middle'
            ? -((lines.length - 1) * lh) / 2
            : t.vAlign === 'bottom' || t.vAlign === 'baseline'
              ? -(lines.length - 1) * lh
              : 0
          : 0;
      const spans = lines
        .map(
          (ln, i) =>
            `<tspan x="${n(x)}" dy="${n(i === 0 ? y0 : lh)}">${esc(ln)}</tspan>`,
        )
        .join('');
      const rot = -(t.rotation * 180) / Math.PI;
      const transform = Math.abs(rot) > 0.01 ? ` transform="rotate(${n(rot)} ${n(x)} ${n(y)})"` : '';
      const stretch = t.widthFactor !== 1 ? ` textLength="${n(size * 0.55 * t.text.length * t.widthFactor)}"` : '';
      out.push(
        `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${t.color}" ` +
          `text-anchor="${anchor}" dominant-baseline="${baseline}"` +
          (t.alpha < 1 ? ` opacity="${n(t.alpha)}"` : '') +
          transform +
          stretch +
          `>${spans}</text>`,
      );
    }
  }

  out.push('</svg>');
  return out.join('');
}
