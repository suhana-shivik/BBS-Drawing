// ============================================================
// AI semantic labelling — public surface.
//
// The pipeline, in order:
//
//   applyDictionary(doc)   what this office's block library already means
//   buildDigest(doc)       the unknown keys + the drawing's own legend text
//   buildCrops(doc, …)     the legend, the sheet, one thumbnail per symbol
//   analyseDrawing(doc)    one request; the response is validated against OUR
//                          key list and stripped of any quantity field
//   applyAnalysis(result)  merged behind human corrections, then persisted
//   correctLabel(k, v)     a human overrules it, forever and everywhere
//
// THE RULE, restated because it is the whole design: the model assigns MEANING
// ONLY. Counts, lengths and areas are computed from geometry by `metrics.ts`
// and `takeoff.ts`. A wrong label is visible and one click from fixed; a wrong
// number would be invisible poison in a bill of quantities.
//
// Known contract gaps (documented, not worked around):
//  - `renderBlockThumbnail` / `renderLegendCrop` / `renderOverview` return
//    `Promise<string>`, not `string`: `Image` decoding is asynchronous and the
//    quality bar forbids blocking the UI. The pure SVG halves
//    (`blockThumbnailSvg`, `legendSvg`, `overviewSvg`) are synchronous and
//    node-testable.
//  - `session.cadBounds()` frames the SESSION's document, so it cannot frame an
//    arbitrary one. `crops.frameBounds(list)` is a port of the same percentile
//    logic; if `cadBounds` is ever refactored to take a DisplayList, delete it.
//  - `store.ts` has no store suitable for small keyed records, and bumping its
//    DB_VERSION from here would race `openDB()`. `labels.ts` probes for a
//    `cadLabels` store and otherwise uses localStorage — see its header.
// ============================================================
import { partitionKeys } from '../../domain/india';
import type { CadDocument, CadLabel } from '../types';
import type { AnalysisResult } from './contract';
import { analyseDrawingDetailed, type AiProgress, type AnalyseOptions } from './openrouter';
import { applyAnalysis, applyDictionary, rememberLabels } from './labels';
import { buildDigest, digestKeys } from './digest';
import { getCadSession, setCadLabels } from '../session';

export * from './contract';
export * from './config';
export * from './digest';
export * from './crops';
export * from './labels';
export * from './openrouter';

export interface LabelDrawingResult {
  /** everything named before any request — dictionary hits plus rule decodes */
  preLabelled: string[];
  /** the subset named by Indian-construction naming rules alone */
  ruleLabelled: string[];
  /** what the model added, already validated */
  result: AnalysisResult;
  /** the merged, persisted label set now in the session */
  labels: Map<string, CadLabel>;
  model: string;
  payloadBytes: number;
}

/**
 * The whole loop, in one call: dictionary first, then a single request about
 * whatever is left, then persistence with human corrections still on top.
 *
 * Callers that want the steps separately can use them directly — this is the
 * convenience path, not a hidden layer.
 */
export async function labelDrawing(
  doc: CadDocument,
  opts: AnalyseOptions = {},
): Promise<LabelDrawingResult> {
  const report = (p: AiProgress): void => opts.onProgress?.(p);

  report({ phase: 'Reading drawing', pct: 1 });
  const { labelled } = await applyDictionary(doc);

  // Indian construction naming is largely rule-decodable: ACDB-R1 is an AC
  // Distribution Board on the Red phase, circuit 1. Decoding those locally is
  // free, certain and auditable, and on a real drawing it removes roughly
  // 40% of the keys before a single token is spent.
  report({ phase: 'Decoding known conventions', pct: 4 });
  const { decoded } = partitionKeys(digestKeys(buildDigest(doc)));
  const domainLabels = new Map<string, CadLabel>();
  for (const [key, label] of decoded) {
    // never override a human correction or a dictionary hit
    if (labelled.includes(key)) continue;
    domainLabels.set(key, label);
  }
  if (domainLabels.size) {
    await rememberLabels(domainLabels);
    setCadLabels(new Map([...getCadSession().labels, ...domainLabels]));
  }

  // whatever the dictionary or the rules already named is not worth a request
  const skip = opts.skipKeys ?? new Set([...labelled, ...domainLabels.keys()]);
  const detailed = await analyseDrawingDetailed(doc, { ...opts, skipKeys: skip });
  const labels = await applyAnalysis(detailed.result);

  return {
    preLabelled: [...labelled, ...domainLabels.keys()],
    ruleLabelled: [...domainLabels.keys()],
    result: detailed.result,
    labels,
    model: detailed.model,
    payloadBytes: detailed.payloadBytes,
  };
}
