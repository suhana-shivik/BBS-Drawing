// ============================================================
// One box in, one section out.
//
// THE INVARIANT THIS FILE EXISTS TO ENFORCE (§8):
//
//     The PNG and the DXF are produced from the SAME `SectionBounds`, in the
//     same call, and there is no path through this module that lets them
//     disagree.
//
// The previous implementation had two copies of the band-box arithmetic and
// one produced a zero-height crop, so the caller cannot supply two boxes here
// even by accident: `exportSection` takes exactly one, uses it for entity
// selection, hands the same object to the rasteriser, and stores it on the
// result. A degenerate box is refused up front rather than rendered blank.
// ============================================================
import type { CadDocument } from '../types';
import {
  boundsKey,
  clampToSheet,
  connectedEntitiesInBounds,
  isDegenerate,
  normaliseBounds,
  sheetBounds,
  type SectionPolicy,
} from './bounds';
import { writeSectionDxf } from './dxfWrite';
import type {
  DrawingSection,
  MemberHint,
  SectionBounds,
  SectionLimitation,
} from './types';

/** longest side of a section PNG, px */
export const SECTION_PX = 1400;

/**
 * Render one model-space box to a PNG data URL.
 *
 * Injectable so the whole splitter can run — and be tested — with no
 * rasteriser at all. A headless run produces sections with real DXFs and
 * empty PNGs, and says so in `limitations`, rather than failing.
 */
export type SectionRenderer = (
  doc: CadDocument,
  bounds: SectionBounds,
  px: number,
) => Promise<string | null>;

/**
 * The default renderer: the app's own display list, cropped to the box.
 *
 * Imported lazily because it pulls in the rasteriser, and a DXF-only run
 * should not pay for it. Coordinates need no conversion — `buildDisplayList`
 * applies `unitScale`, so the list is in millimetres, exactly like the box.
 */
export const defaultRenderer: SectionRenderer = async (doc, bounds, px) => {
  try {
    const { cropList, simplifyForRaster, rasterise } = await import('../ai/crops');
    const { buildDisplayList } = await import('../displayList');
    const { displayListToSVG } = await import('../svg');
    const list = buildDisplayList(doc, {
      regionId: null,
      hiddenLayers: new Set<string>(),
      // colour flip only — the display list is model space either way
      paper: true,
    });
    const cropped = cropList(
      list,
      { x: bounds.xMin, y: bounds.yMin },
      { x: bounds.xMax, y: bounds.yMax },
    );
    if (!cropped.ops.length) return null;
    const simple = simplifyForRaster(cropped, px, 24_000);
    return await rasterise(
      displayListToSVG(simple, { background: '#ffffff', margin: 8, width: px }),
      px,
    );
  } catch {
    return null;
  }
};

export interface SectionMeta {
  sectionId: string;
  label: string;
  kind: string;
  sourceDrawingHash: string;
  orchestratorStep: number;
  confidence: number;
  evidenceIds?: string[];
  memberHints?: MemberHint[];
  calloutHints?: string[];
}

export interface ExportOptions {
  policy?: SectionPolicy;
  px?: number;
  renderer?: SectionRenderer;
  /** skip rasterising entirely — DXF-only runs and tests */
  skipPng?: boolean;
}

function merge(...groups: SectionLimitation[][]): SectionLimitation[] {
  const acc = new Map<string, SectionLimitation>();
  for (const group of groups) {
    for (const l of group) {
      const key = `${l.code}:${l.message}`;
      const hit = acc.get(key);
      if (hit) hit.count += l.count;
      else acc.set(key, { ...l });
    }
  }
  return [...acc.values()];
}

/**
 * Cut one section: select entities, write the DXF, render the PNG.
 *
 * `bounds` is clamped to the sheet first — a coordinate outside the drawing is
 * a mistake, not an instruction. What is selected inside it can still shrink
 * once more, if `connectedEntitiesInBounds` finds the box spans two
 * disconnected things — see that function's doc comment. Whatever bounds
 * result from that is what both outputs, and the returned section, agree on.
 */
export async function exportSection(
  doc: CadDocument,
  bounds: SectionBounds,
  meta: SectionMeta,
  opts: ExportOptions = {},
): Promise<DrawingSection> {
  // ONE box, resolved once, from here on treated as immutable
  const box = clampToSheet(normaliseBounds(bounds), sheetBounds(doc));

  if (isDegenerate(box)) {
    return {
      sectionId: meta.sectionId,
      label: meta.label,
      kind: meta.kind,
      sourceDrawing: doc.sourceFile,
      sourceDrawingHash: meta.sourceDrawingHash,
      bounds: box,
      png: '',
      dxf: '',
      entityIds: [],
      evidenceIds: meta.evidenceIds ?? [],
      memberHints: meta.memberHints ?? [],
      calloutHints: meta.calloutHints ?? [],
      orchestratorStep: meta.orchestratorStep,
      confidence: meta.confidence,
      entityCount: 0,
      limitations: [
        {
          code: 'degenerate-bounds',
          message: `bounds ${boundsKey(box)} has no area after clamping to the sheet; nothing was cut`,
          count: 1,
        },
      ],
    };
  }

  // §8's own words: PNG, DXF and the stored bounds must all describe the
  // SAME region. connectedEntitiesInBounds can tighten `box` (see its doc
  // comment) — everything downstream from here uses its returned bounds,
  // never the caller's original one, or that invariant breaks silently the
  // first time a handle list mixes in a neighbour's caption.
  const selection = connectedEntitiesInBounds(doc, box, opts.policy ?? 'intersect');
  const finalBox = selection.bounds;
  const written = writeSectionDxf(doc, selection.entities, finalBox);

  let png = '';
  const renderLimits: SectionLimitation[] = [];
  if (!opts.skipPng) {
    const render = opts.renderer ?? defaultRenderer;
    const image = await render(doc, finalBox, opts.px ?? SECTION_PX);
    if (image) {
      png = image;
    } else {
      renderLimits.push({
        code: 'render-unavailable',
        message:
          'no PNG was produced for this section — the DXF is complete and the box is recorded',
        count: 1,
      });
    }
  }

  return {
    sectionId: meta.sectionId,
    label: meta.label,
    kind: meta.kind,
    sourceDrawing: doc.sourceFile,
    sourceDrawingHash: meta.sourceDrawingHash,
    bounds: finalBox,
    png,
    dxf: written.text,
    entityIds: written.handles,
    evidenceIds: meta.evidenceIds ?? [],
    memberHints: meta.memberHints ?? [],
    calloutHints: meta.calloutHints ?? [],
    orchestratorStep: meta.orchestratorStep,
    confidence: meta.confidence,
    entityCount: written.entityCount,
    limitations: merge(selection.limitations, written.limitations, renderLimits),
  };
}

/** `REGION-01`, `REGION-02`, … — stable within a package. */
export function sectionIdFor(index: number): string {
  return `REGION-${String(index + 1).padStart(2, '0')}`;
}
