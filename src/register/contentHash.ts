// Is this the same file we already hold?
//
// The register answers "same drawing" from the title block (identityKey), which
// is the right question for a REVISION: PCD-…-803 R0 and R1 are one drawing in
// two states. It is the wrong question for a re-upload, where the answer has to
// be about the bytes — the same file dropped in twice is not a second version
// of anything, and calling it one would supersede a sheet with itself.
//
// FNV-1a over the source text, mixed with its length. Not a cryptographic
// digest and not trying to be: nothing here defends against a crafted
// collision, it only has to tell two DXF files apart, and a 64-bit value seeded
// by length does that for any register a practice will ever hold. It is
// synchronous, which SubtleCrypto is not — the import path needs the answer
// before it decides whether to parse at all.

const OFFSET_LO = 0x84222325;
const OFFSET_HI = 0x8dc5c88b;

/** Stable 64-bit content fingerprint, as 16 hex characters. */
export function contentHash(text: string): string {
  // Two 32-bit lanes with different primes stand in for one 64-bit FNV: JS
  // bitwise maths is 32-bit, and a single lane collides far too readily across
  // the thousands of near-identical sheets one project holds.
  let lo = OFFSET_LO;
  let hi = OFFSET_HI;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    lo = Math.imul(lo ^ c, 0x01000193);
    hi = Math.imul(hi ^ (c + i), 0x01000193);
  }
  const len = text.length >>> 0;
  lo = Math.imul(lo ^ len, 0x01000193);
  hi = Math.imul(hi ^ len, 0x01000193);
  return `${(hi >>> 0).toString(16).padStart(8, '0')}${(lo >>> 0).toString(16).padStart(8, '0')}`;
}
