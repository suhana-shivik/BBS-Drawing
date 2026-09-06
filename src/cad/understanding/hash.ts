// ============================================================
// Drawing identity.
//
// A section package describes ONE version of ONE drawing. When the drawing is
// re-issued, the sections it describes may no longer exist — a detail moves,
// a layout is redrawn, a schedule gains a row. Using those sections anyway
// would produce a confident answer about a sheet nobody is building from.
//
// So every package carries the hash of what it was built from, and the loader
// compares before it trusts. §16: "Do NOT silently use stale sections."
// ============================================================
import type { CadDocument } from '../types';

/** hex SHA-256 of bytes or text, via WebCrypto (browser and Node 18+). */
async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `fnv1a:${fnv1a(bytes)}`;
  // BufferSource wants a plain ArrayBuffer view; a Uint8Array is one
  const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Non-cryptographic fallback for environments with no WebCrypto.
 *
 * It only has to CHANGE when the drawing changes — nothing here is a security
 * boundary — but the prefix makes it obvious in stored data which was used.
 */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The hash of the original upload — the strongest identity available. */
export function hashSourceBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return sha256(bytes);
}

/**
 * A structural fingerprint of a parsed document, for when the original bytes
 * are not to hand.
 *
 * Deliberately built from things that move when a drawing is re-issued: the
 * entity count, the sheet extents, the layer roster, and a sample of handles
 * spread across the document rather than clustered at its start. It is weaker
 * than hashing the file and is marked as such by its `doc:` prefix, but it
 * still fails the comparison when the drawing changes, which is the whole job.
 */
export function hashDocument(doc: CadDocument): Promise<string> {
  const parts: string[] = [
    `n=${doc.entities.length}`,
    `u=${doc.unitScale}`,
    `b=${doc.blocks.size}`,
    `l=${[...doc.layers.keys()].sort().join(',')}`,
  ];
  if (doc.extents) {
    const { min, max } = doc.extents;
    parts.push(`e=${min.x.toFixed(3)},${min.y.toFixed(3)},${max.x.toFixed(3)},${max.y.toFixed(3)}`);
  }
  const step = Math.max(1, Math.floor(doc.entities.length / 64));
  const sample: string[] = [];
  for (let i = 0; i < doc.entities.length; i += step) {
    const e = doc.entities[i];
    sample.push(`${e.type}#${e.style.handle}@${e.style.layer}`);
  }
  parts.push(`s=${sample.join('|')}`);
  return sha256(parts.join(';')).then((h) => `doc:${h}`);
}

/**
 * The identity to store on a package.
 *
 * Prefers the original bytes; falls back to the structural fingerprint. Both
 * satisfy invalidation; only the first survives a re-parse by a different
 * parser version, which is why it is preferred.
 */
export async function drawingHash(
  doc: CadDocument,
  sourceBytes?: ArrayBuffer | Uint8Array | null,
): Promise<string> {
  if (sourceBytes && (sourceBytes as ArrayBuffer).byteLength !== 0) {
    return hashSourceBytes(sourceBytes);
  }
  return hashDocument(doc);
}
