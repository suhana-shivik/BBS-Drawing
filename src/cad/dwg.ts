// DWG import — the browser half of the DWG→DXF conversion service.
//
// BIMCAD parses DXF and only DXF. The group-code parser in src/cad/dxf/ carries
// years of hard-won behaviour — OCS transforms, bulge arcs, hatch patterns,
// block expansion, text justification — and it is the single source of truth.
// A DWG is therefore not parsed here or anywhere else in the app: it is handed
// to a small .NET service (services/dwg-convert, ACadSharp) that converts it to
// ASCII DXF, and the resulting text goes into the existing import path
// unchanged. Nothing about a DWG is interpreted on either side of the wire.
//
// Service contract (services/dwg-convert/Program.cs):
//   GET  /health   -> {"ok":true,"acadsharp":"<version>",...}
//   POST /convert  -> multipart/form-data with a `file` field, returns the DXF
//                     as text/plain; charset=utf-8. Failures are 4xx/5xx with a
//                     JSON {"error":"..."} body naming what went wrong.
//
// In this app the service is reached through the vite dev proxy: `/dwg-convert`
// forwards to http://localhost:5179 with the prefix stripped, so the endpoints
// become POST /dwg-convert/convert and GET /dwg-convert/health.
//
// The service is optional. When it is not running, DWG import fails with an
// actionable message and DXF import is completely unaffected.

const DEFAULT_SERVICE_URL = '/dwg-convert';

/** Health probes must not make the UI wait; a dead service is the common case. */
const HEALTH_TIMEOUT_MS = 2500;

/** Backstop so a black-holed connection cannot hang the import forever. */
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000;

export const DWG_SERVICE_OFFLINE =
  'DWG conversion service is not running — start it (services/dwg-convert) or import a DXF instead.';

// ---------------------------------------------------------------- config

function rawServiceUrl(): string | undefined {
  // Typed structurally rather than via vite/client so this module does not
  // depend on the app's ambient type declarations.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.VITE_DWG_SERVICE_URL;
  return typeof v === 'string' ? v.trim() : undefined;
}

/**
 * Base URL of the conversion service, without a trailing slash. Unset falls
 * back to the `/dwg-convert` vite proxy; set explicitly blank to disable DWG
 * import; set to an absolute URL to reach a converter somewhere else.
 */
export function dwgServiceUrl(): string {
  const raw = rawServiceUrl();
  const url = raw === undefined ? DEFAULT_SERVICE_URL : raw;
  return url.replace(/\/+$/, '');
}

/** False only when `VITE_DWG_SERVICE_URL` is explicitly blank — DWG import off. */
export function isDwgServiceConfigured(): boolean {
  return dwgServiceUrl().length > 0;
}

// ---------------------------------------------------------------- errors

export type DwgErrorKind = 'unconfigured' | 'unreachable' | 'not-dwg' | 'service' | 'aborted';

/**
 * Carries a message that is already fit to show the user. Import handlers
 * surface `.message` verbatim rather than wrapping it in "DXF import failed",
 * which would be both wrong and unhelpful for a DWG.
 */
export class DwgError extends Error {
  readonly kind: DwgErrorKind;
  readonly status?: number;

  constructor(kind: DwgErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DwgError';
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------- sniffing

// Every DWG opens with a six-byte ASCII version stamp. AC1002…AC1032 covers
// everything from AutoCAD 2.5 to 2026; the dotted forms are pre-R9 relics kept
// so an ancient file is still recognised as a DWG and gets the service's
// specific "version not supported" message instead of "this is not a DWG".
const DWG_SIGNATURE = /^(?:AC10\d{2}|AC[12]\.\d|MC0\.\d)/;

/**
 * True when `bytes` starts with a DWG version stamp. Checked before uploading
 * so an obviously wrong file never costs a round trip.
 */
export function looksLikeDwg(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 6) return false;
  const head = new Uint8Array(bytes, 0, 6);
  let signature = '';
  for (let i = 0; i < head.length; i += 1) signature += String.fromCharCode(head[i]);
  return DWG_SIGNATURE.test(signature);
}

// ---------------------------------------------------------------- health

export interface DwgServiceStatus {
  ok: boolean;
  version?: string;
  /**
   * Something IS listening on the port, but the browser refused the response.
   * Almost always CORS: the service allow-lists an origin the app is not being
   * served from. Distinct from `ok: false` alone, which means nothing answered
   * at all — and the two need different things doing about them.
   */
  blocked?: boolean;
}

/**
 * Probe `/health`. Never throws and never waits long: an unreachable service is
 * an expected state, not an exceptional one.
 */
export async function checkDwgService(signal?: AbortSignal): Promise<DwgServiceStatus> {
  if (!isDwgServiceConfigured()) return { ok: false };

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = window.setTimeout(abort, HEALTH_TIMEOUT_MS);
  signal?.addEventListener('abort', abort);

  try {
    const res = await fetch(`${dwgServiceUrl()}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };

    const body = (await res.json()) as { ok?: unknown; acadsharp?: unknown };
    if (body?.ok !== true) return { ok: false };
    return {
      ok: true,
      version: typeof body.acadsharp === 'string' ? body.acadsharp : undefined,
    };
  } catch {
    // A dead port and a CORS refusal both arrive as the same opaque TypeError,
    // and collapsing them cost real time: a converter that had been up for two
    // days read as "not running" because the dev server had drifted to a port
    // the container did not allow. Somebody then restarts a container that was
    // never down. (Through the vite proxy this cannot happen — the request is
    // same-origin — but the probe survives for direct-URL configurations.)
    //
    // A `no-cors` probe separates them. It returns an opaque response — no
    // status, no body, nothing readable — but it RESOLVES when something is
    // listening and rejects when nothing is. That is the whole question.
    try {
      await fetch(`${dwgServiceUrl()}/health`, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      return { ok: false, blocked: true };
    } catch {
      return { ok: false };
    }
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// ---------------------------------------------------------------- convert

export interface DwgProgress {
  /** 'upload' while the DWG is going out, 'convert' once the server has it. */
  phase: 'upload' | 'convert';
  pct: number;
}

export interface DwgConvertOptions {
  signal?: AbortSignal;
  onProgress?: (p: DwgProgress) => void;
  /** Name reported to the service when converting raw bytes. */
  fileName?: string;
}

/**
 * POST the DWG to `${dwgServiceUrl()}/convert` as multipart/form-data with a
 * `file` field, and resolve with the DXF text the service returns.
 *
 * Accepts the raw bytes of the drawing (or a picked File). The resolved value
 * is always the ASCII DXF as a string — ready for the DXF import path.
 *
 * Uses XMLHttpRequest rather than fetch purely for `upload.onprogress` — a
 * 150 MB DWG on a slow link is otherwise a silent minute of nothing.
 */
export function convertDwgToDxf(
  bytes: ArrayBuffer | File,
  opts: DwgConvertOptions = {},
): Promise<string> {
  if (!isDwgServiceConfigured()) {
    return Promise.reject(new DwgError('unconfigured', DWG_SERVICE_OFFLINE));
  }
  if (opts.signal?.aborted) {
    return Promise.reject(new DwgError('aborted', 'DWG conversion cancelled.'));
  }

  const name = bytes instanceof File ? bytes.name : opts.fileName ?? 'drawing.dwg';
  const payload: Blob = bytes instanceof File ? bytes : new Blob([bytes], { type: 'application/octet-stream' });

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const detach = () => opts.signal?.removeEventListener('abort', abort);

    xhr.open('POST', `${dwgServiceUrl()}/convert`);
    xhr.responseType = 'text';
    xhr.timeout = CONVERT_TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || e.total === 0) return;
      opts.onProgress?.({ phase: 'upload', pct: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.upload.onload = () => opts.onProgress?.({ phase: 'convert', pct: 0 });

    xhr.onload = () => {
      detach();
      const body = xhr.responseText ?? '';
      if (xhr.status >= 200 && xhr.status < 300) {
        if (body.trim() === '') {
          reject(new DwgError('service', 'The DWG conversion service returned an empty file.', xhr.status));
          return;
        }
        opts.onProgress?.({ phase: 'convert', pct: 100 });
        resolve(body);
        return;
      }
      reject(new DwgError('service', serviceErrorMessage(body, xhr.status), xhr.status));
    };

    // Status 0 with no response: not running, refused, or blocked by CORS.
    // XHR cannot tell us which, so ask — and say which, because the two need
    // opposite things doing. "Start the service" sent somebody to restart a
    // container that had been up for two days; the real fault was the dev
    // server having drifted to a port the service does not allow.
    xhr.onerror = () => {
      detach();
      void checkDwgService().then((status) => {
        reject(
          new DwgError(
            'unreachable',
            status.blocked
              ? `The DWG conversion service is running, but it refused a request from ${window.location.origin}. ` +
                'Add that origin to ALLOWED_ORIGINS in services/dwg-convert/docker-compose.yml and ' +
                'restart it with "docker compose up -d".'
              : DWG_SERVICE_OFFLINE,
          ),
        );
      });
    };
    xhr.ontimeout = () => {
      detach();
      reject(
        new DwgError(
          'unreachable',
          `The DWG conversion service did not answer within ${Math.round(CONVERT_TIMEOUT_MS / 60000)} minutes.`,
        ),
      );
    };
    xhr.onabort = () => {
      detach();
      reject(new DwgError('aborted', 'DWG conversion cancelled.'));
    };

    opts.signal?.addEventListener('abort', abort);

    const form = new FormData();
    form.append('file', payload, name);
    xhr.send(form);
  });
}

/** The service names its own failures; repeat that wording rather than guess. */
function serviceErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim() !== '') return parsed.error.trim();
  } catch {
    /* not JSON — fall through to the raw body */
  }
  const snippet = body.trim().slice(0, 300);
  return snippet
    ? `DWG conversion failed (HTTP ${status}): ${snippet}`
    : `DWG conversion failed (HTTP ${status}).`;
}

// ---------------------------------------------------------------- picking

export interface PickedDrawing {
  name: string;
  /** DXF text, ready for the import path — converted first if it was a DWG. */
  text: string;
  /** exact bytes selected by the user; for DWG this is not the converted DXF */
  sourceBytes: ArrayBuffer;
  convertedFromDwg: boolean;
}

export interface PickDrawingOptions {
  /** Progress line for the UI, e.g. "Converting DWG…". */
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}

/** File picker accepting both formats. Resolves null if nothing is chosen. */
export function pickCadFile(accept = '.dxf,.dwg'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/**
 * Turn a picked file into DXF text.
 *
 * Routing is by magic bytes, not file extension, so a DWG that someone renamed
 * `.dxf` is converted instead of being fed to the group-code parser as binary
 * noise. Anything that is not a DWG is read as text exactly as before — the DXF
 * path is untouched.
 */
export async function readCadDrawing(
  file: File,
  opts: PickDrawingOptions = {},
): Promise<PickedDrawing> {
  const head = await file.slice(0, 6).arrayBuffer();
  const isDwg = looksLikeDwg(head);

  if (!isDwg) {
    if (/\.dwg$/i.test(file.name)) {
      throw new DwgError(
        'not-dwg',
        `${file.name} is named .dwg but has no DWG signature — the file is truncated or is not really a drawing.`,
      );
    }
    const sourceBytes = await file.arrayBuffer();
    return {
      name: file.name,
      text: new TextDecoder().decode(sourceBytes),
      sourceBytes,
      convertedFromDwg: false,
    };
  }

  if (!isDwgServiceConfigured()) throw new DwgError('unconfigured', DWG_SERVICE_OFFLINE);

  opts.onStatus?.('Checking DWG conversion service…');
  const status = await checkDwgService(opts.signal);
  if (!status.ok) throw new DwgError('unreachable', DWG_SERVICE_OFFLINE);

  opts.onStatus?.(`Converting ${file.name} to DXF…`);
  const text = await convertDwgToDxf(file, {
    signal: opts.signal,
    onProgress: (p) => {
      if (p.phase === 'upload' && p.pct < 100) opts.onStatus?.(`Uploading ${file.name} — ${p.pct}%`);
    },
  });

  // Keep the name the user picked; the underlay is theirs, not the converter's.
  return {
    name: file.name,
    text,
    sourceBytes: await file.arrayBuffer(),
    convertedFromDwg: true,
  };
}

/** Pick a .dxf or .dwg and return DXF text. Null when the picker is dismissed. */
export async function pickCadDrawing(opts: PickDrawingOptions = {}): Promise<PickedDrawing | null> {
  const file = await pickCadFile();
  if (!file) return null;
  return readCadDrawing(file, opts);
}
