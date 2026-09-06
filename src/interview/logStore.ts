// The interview log, kept.
//
// One append-only array per project, beside the ledger it is about. IndexedDB
// rather than localStorage on purpose: this grows with every run, it is a
// record rather than a convenience, and localStorage is a single-digit-megabyte
// budget shared by the whole origin — the first thing to go when it fills.
//
// APPEND-ONLY, AND NEVER REWRITTEN. A run that went badly is exactly the run
// worth reading later, so nothing here amends or tidies an earlier entry. The
// only bound is a cap on how many runs are kept, and it drops the OLDEST,
// because a log that silently discards the newest is worse than no log.

import * as repo from '../cad/store';
import * as remote from '../data/interviewLogs';
import { isSupabaseConfigured } from '../lib/supabase';
import type { AuditLog } from './audit';

/** Runs kept per project. A working record, not an archive. */
const MAX_RUNS = 60;

export interface StoredInterviewLog extends AuditLog {
  /** which drawing the run was about, for reading the file back */
  drawingName: string;
  /**
   * The parsed document the run was about — the thing `drawing_id` is
   * resolved from.
   *
   * `drawingName` is a LABEL: it is the drawing number when one was read and
   * the file name when one was not, and neither can be joined on. Without
   * this field every interview log filed a null drawing, so the question
   * "what was asked about this sheet" had no answer the database could give.
   * Optional because a run can start with no sheet open.
   */
  documentId?: string;
  /** the artifact the run published, when it published one */
  artifactId?: string;
  /** why it stopped, when it did not publish */
  stoppedBecause?: string;
}

export async function loadInterviewLogs(projectId: string): Promise<StoredInterviewLog[]> {
  if (isSupabaseConfigured()) {
    try {
      const rows = await remote.listInterviewLogs(projectId);
      // The stored `log` IS the AuditLog; the three columns beside it are the
      // fields this module adds on top of it.
      if (rows.length) {
        return rows.map((row) => ({
          ...(row.log as AuditLog),
          drawingName: row.drawingName,
          ...(row.artifactId ? { artifactId: row.artifactId } : {}),
          ...(row.stoppedBecause ? { stoppedBecause: row.stoppedBecause } : {}),
        }));
      }
    } catch {
      // fall through to the browser copy rather than showing no history
    }
  }
  try {
    return (await repo.getInterviewLogs<StoredInterviewLog>(projectId)) ?? [];
  } catch {
    // Storage being unavailable must never take a run down with it — the log
    // is a record OF the work, not part of it.
    return [];
  }
}

/** Add one run's log. Newest first; oldest dropped past the cap. */
export async function appendInterviewLog(
  projectId: string,
  log: StoredInterviewLog,
): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      const { drawingName, documentId, artifactId, stoppedBecause, ...audit } = log;
      await remote.insertInterviewLog(projectId, {
        drawingName,
        ...(artifactId ? { artifactId } : {}),
        ...(stoppedBecause ? { stoppedBecause } : {}),
        log: audit,
        ...(documentId ? { documentId } : {}),
      });
    } catch {
      // Same rule as below: a failed write is not a failed run.
    }
  }
  try {
    const existing = await repo.getInterviewLogs<StoredInterviewLog>(projectId).catch(() => []);
    await repo.putInterviewLogs(projectId, [log, ...(existing ?? [])].slice(0, MAX_RUNS));
  } catch {
    // Same rule: a failed write is not a failed run.
  }
}

export async function clearInterviewLogs(projectId: string): Promise<void> {
  try {
    await repo.putInterviewLogs(projectId, []);
  } catch {
    // ignore
  }
}
