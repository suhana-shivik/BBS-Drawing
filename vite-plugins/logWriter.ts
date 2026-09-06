// Writing the app's logs to disk, as Markdown.
//
// The app has no server: everything it knows lives in the browser's IndexedDB,
// which means one machine, one browser profile, and gone the moment site data
// is cleared. That is fine for working state and wrong for a RECORD — an
// interview log exists to be read later, by somebody else, after the browser
// that made it has been reset.
//
// So this is the smallest backend that solves it: a dev-server endpoint that
// writes files under one directory. No database, no process to run, no service
// to deploy. It follows the pattern already here — `/dwg-convert` proxies to a
// local service — but needs no service at all, because writing a file is
// something the dev server can already do.
//
// WHAT THIS IS NOT. It is a DEV-SERVER endpoint: it exists under `npm run dev`
// and nowhere else. A built bundle served from a static host has no backend and
// the client falls back to doing nothing, which is why `logSink` never treats a
// failed write as an error. If these logs ever need to outlive one workstation,
// that is a real service and a real decision about where drawing content is
// allowed to go — not this file grown larger.
//
// THE PATH IS THE DANGEROUS PART. An endpoint that takes a filename from a
// browser and writes it is a directory traversal waiting to happen, so the
// name is rebuilt from scratch rather than checked: every segment is filtered
// down to a safe alphabet, `..` cannot survive it, and the result is verified
// to sit under the log root before anything is written.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Everything is written under this, relative to the project root. */
export const LOG_DIR = 'logs';
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A relative, `.md` path that cannot escape the log directory — or null.
 *
 * REBUILT, NOT VALIDATED. Rejecting bad input means enumerating what is bad,
 * and the list of ways to write `..` is longer than it looks: `..%2f`, `....//`,
 * a backslash on Windows, a NUL, a leading drive letter. So each segment is
 * reduced to `[A-Za-z0-9._-]`, anything that is then empty or all dots is
 * dropped, and what remains cannot be anything but a plain name.
 */
export function safeLogPath(requested: string): string | null {
  const segments = String(requested)
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[^A-Za-z0-9._-]/g, '-'))
    // A segment of nothing but dots is `.` or `..` however it was spelled.
    .filter((s) => s.length > 0 && !/^\.+$/.test(s));

  if (!segments.length || segments.length > 8) return null;
  const name = segments[segments.length - 1];
  segments[segments.length - 1] = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
  const joined = segments.join('/');
  return joined.length <= 200 ? joined : null;
}

interface WriteRequest {
  path?: unknown;
  markdown?: unknown;
}

async function readBody(req: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) throw new Error('too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Adds `POST /api/logs` to the dev server. */
export function logWriter(): Plugin {
  return {
    name: 'bimcad-log-writer',
    configureServer(server) {
      const root = path.resolve(server.config.root, LOG_DIR);
      server.middlewares.use('/api/logs', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const body = JSON.parse(await readBody(req, MAX_BYTES)) as WriteRequest;
            const rel = typeof body.path === 'string' ? safeLogPath(body.path) : null;
            const markdown = typeof body.markdown === 'string' ? body.markdown : null;
            if (!rel || markdown === null) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'a path and markdown are required' }));
              return;
            }
            const full = path.resolve(root, rel);
            // Belt as well as braces: the rebuild above should make this
            // impossible, and a traversal that reached the filesystem would be
            // the one bug in this file that actually matters.
            if (full !== root && !full.startsWith(root + path.sep)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'path escapes the log directory' }));
              return;
            }
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, markdown, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: `${LOG_DIR}/${rel}` }));
          } catch (err) {
            res.statusCode = 500;
            res.end(
              JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
            );
          }
        })();
      });
    },
  };
}
