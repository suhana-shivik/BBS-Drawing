// Node-only SVG rasterisation for live/headless BBS runs.
// Kept outside render.ts so the browser build never follows the native resvg
// binary into Vite's module graph.

import type { Rasteriser } from './render';

export const nodeRasteriser: Rasteriser = async (svg: string, maxPx = 1600): Promise<string> => {
  if (!svg) return '';
  try {
    const mod = (await import('@resvg/resvg-js')) as unknown as {
      Resvg: new (svg: string, opts?: Record<string, unknown>) => { render(): { asPng(): Buffer } };
    };
    const r = new mod.Resvg(svg, { fitTo: { mode: 'width', value: maxPx } });
    const png = r.render().asPng();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return '';
  }
};
