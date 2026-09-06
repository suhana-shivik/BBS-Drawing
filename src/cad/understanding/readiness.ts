// ============================================================
// IS THIS DRAWING READ ENOUGH TO SCHEDULE FROM?
//
// The gate that was missing. Splitting, the second-pass residual read and
// section validation all existed, and all three were OPTIONAL actions sitting
// beside a Calculate BBS button that never consulted any of them. So a
// schedule could be built over a drawing whose sections had never been cut,
// or one where a fifth of the geometry sat outside every section box and
// nobody had ever looked at it. Steel that no section carries is steel the
// schedule cannot see, and its absence looks exactly like its absence being
// correct: the total is simply smaller, and nothing objects.
//
// WHAT THIS IS NOT
//
// It is not a quality score and it does not read meaning. It asks four
// questions of the record that already exists, in order, and stops at the
// first that fails:
//
//   1. has this drawing been split at all?
//   2. is that split still about THIS drawing? (the hash — a package built
//      from an older revision must never quietly govern a newer one)
//   3. is there geometry outside every section that nobody has read?
//   4. did the second pass leave pieces it could not read?
//
// Every one is answered from geometry and from statuses the pipeline already
// records. Nothing here calls a model, and nothing here decides whether an
// unread piece MATTERS — that judgement is the reader's, which is why the
// answer names the pieces rather than scoring them.
// ============================================================
import type { DrawingUnderstandingPackage } from './types';

/** What the gate found, worst first. */
export type ReadinessState =
  | 'ready'
  /** never split — there are no sections to read anything out of */
  | 'unsplit'
  /** a split or second pass is running right now */
  | 'working'
  /** the saved reading belongs to a different version of this drawing */
  | 'stale'
  /** geometry outside every section that the second pass has not read */
  | 'unread'
  /** the second pass ran and could not read some of it */
  | 'unreadable';

/** What the studio should offer to do about it. */
export type ReadinessRemedy = 'split' | 'second-pass' | 'wait' | null;

export interface DrawingReadiness {
  /** may a schedule be computed from this drawing? */
  ok: boolean;
  state: ReadinessState;
  /** the sentence shown where the run was refused */
  reason: string;
  remedy: ReadinessRemedy;
  /**
   * The pieces standing in the way, named — never a count on its own. "3
   * unread areas" tells a person nothing they can act on; "REGION-04 · 118
   * entities on layer RBAR" tells them where to look.
   */
  unread: string[];
}

export interface ReadinessInput {
  /** the saved split for this drawing, or null when it has never been split */
  pkg: DrawingUnderstandingPackage | null;
  /** the live split/second-pass job status, when one is running */
  jobStatus?: 'queued' | 'splitting' | 'split' | 'failed' | 'stale' | null;
  /** the fingerprint of the drawing as it is NOW */
  currentHash?: string | null;
}

const ready = (): DrawingReadiness => ({
  ok: true,
  state: 'ready',
  reason: 'Every part of this drawing has been read.',
  remedy: null,
  unread: [],
});

/**
 * Name one coverage gap the way a person would look for it: how much, on which
 * layer, and a phrase off the drawing if there is one.
 */
function describeGap(gap: {
  layer: string;
  count: number;
  sampleText?: readonly string[];
}): string {
  const sample = (gap.sampleText ?? []).filter((t) => t.trim()).slice(0, 2);
  const said = sample.length ? ` — "${sample.join('", "')}"` : '';
  return `${gap.count} entit${gap.count === 1 ? 'y' : 'ies'} on layer ${gap.layer}${said}`;
}

export function drawingReadiness(input: ReadinessInput): DrawingReadiness {
  const { pkg, jobStatus, currentHash } = input;

  // A run in flight is not a refusal, it is a wait. Said separately so the
  // studio can show a spinner rather than an error.
  if (jobStatus === 'queued' || jobStatus === 'splitting') {
    return {
      ok: false,
      state: 'working',
      reason: 'This drawing is still being read. The schedule can be built when that finishes.',
      remedy: 'wait',
      unread: [],
    };
  }

  if (!pkg) {
    return {
      ok: false,
      state: 'unsplit',
      reason:
        'This drawing has not been read into sections yet. A schedule built now would be built ' +
        'from whatever the extractor happened to find, with no record of what was looked at — ' +
        'split it first.',
      remedy: 'split',
      unread: [],
    };
  }

  // SOURCE INTEGRITY. A package carries the fingerprint of the drawing it was
  // read from; if the drawing has moved on, every section box in it describes
  // geometry that may no longer be there. Reusing it silently is the one
  // failure the hash exists to prevent.
  if (currentHash && pkg.sourceDrawingHash && currentHash !== pkg.sourceDrawingHash) {
    return {
      ok: false,
      state: 'stale',
      reason:
        'The saved reading of this drawing was taken from a different version of it. Section ' +
        'boundaries from the old version cannot be trusted against this one — read it again ' +
        'before scheduling from it.',
      remedy: 'split',
      unread: [],
    };
  }

  const residuals = pkg.residuals;
  const uncovered = pkg.coverage?.uncoveredEntities ?? 0;

  // The second pass has never run, and there IS something for it to read.
  // Coverage is pure geometry, so this cannot disagree with what the sections
  // measure: these entities sit outside every section box.
  if (uncovered > 0 && (residuals === undefined || residuals.length === 0)) {
    const gaps = (pkg.coverage?.gaps ?? []).slice(0, 6).map(describeGap);
    return {
      ok: false,
      state: 'unread',
      reason:
        `${uncovered} entit${uncovered === 1 ? 'y is' : 'ies are'} outside every section of this ` +
        'drawing and have never been read. Steel in there is steel the schedule cannot see, and ' +
        'a total that silently omits it looks exactly like a correct one — read the leftovers first.',
      remedy: 'second-pass',
      unread: gaps,
    };
  }

  // The second pass ran. Anything it could not read stands in the way, named.
  const stuck = (residuals ?? []).filter((r) => r.status !== 'read');
  if (stuck.length) {
    return {
      ok: false,
      state: 'unreadable',
      reason:
        `${stuck.length} part${stuck.length === 1 ? '' : 's'} of this drawing could not be read, ` +
        'even after a second pass. Nothing has been assumed about them and nothing will be: ' +
        'check them on the sheet, and if they carry no steel say so, or supply what they carry.',
      remedy: 'second-pass',
      unread: stuck.map(
        (r) =>
          `${r.gapId}${r.linkedTo ? ` (near ${r.linkedTo})` : ''} — ` +
          `${r.entityCount} entit${r.entityCount === 1 ? 'y' : 'ies'}, ${r.status}` +
          `${r.note ? `: ${r.note}` : ''}`,
      ),
    };
  }

  return ready();
}
