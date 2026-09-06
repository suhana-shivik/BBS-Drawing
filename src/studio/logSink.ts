// Sending a log to the dev server to be written as a file.
//
// FIRE AND FORGET, ALWAYS. Writing the record of a run must never be able to
// affect the run: the endpoint only exists under `npm run dev`, so a built
// bundle has nothing to post to, and a 404 there is the normal case rather
// than a fault. Every failure is swallowed and the caller is told whether it
// landed, so a UI can say "also written to logs/…" honestly and say nothing
// when it was not.
//
// The browser copy in IndexedDB stays the source of truth either way. This is
// a second, durable copy for a human to read outside the browser — not a
// replacement for the first.

/** Where the dev server writes; mirrored from `vite-plugins/logWriter.ts`. */
export const LOG_ENDPOINT = '/api/logs';

/**
 * Write one Markdown file under `logs/`.
 *
 * Returns the path written, or null when there was nowhere to write it — which
 * is not an error and is never reported as one.
 */
export async function writeLogFile(relPath: string, markdown: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, markdown }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; path?: string };
    return json.ok && typeof json.path === 'string' ? json.path : null;
  } catch {
    // No dev server, offline, blocked — all the same thing here: no file.
    return null;
  }
}

/**
 * A file name for one run: sortable by time, and saying what it was about.
 *
 * The timestamp leads so a directory listing is chronological without anything
 * having to sort it, and it is written out rather than left as an epoch number
 * because a person reads these.
 */
export function runLogPath(projectName: string, drawingName: string, at: number): string {
  const clean = (s: string) =>
    (s || 'unknown').replace(/\.(dxf|dwg|pdf)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return `interviews/${clean(projectName)}/${stamp}-${clean(drawingName)}.md`;
}
