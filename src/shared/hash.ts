/**
 * FNV-1a 32-bit hash → 8-char hex string. Fast, dependency-free, non-crypto.
 *
 * Used to dedup identical icons by their canonical SVG string. Collisions are
 * cosmetically acceptable (worst case: two distinct icons share a label); a
 * typical page has only ~10-30 unique icons. The hex string is also parsed back
 * to a uint32 by the MockClassifier as its deterministic seed.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    // Also fold in the high byte so multibyte chars affect the hash.
    h = Math.imul(h, 0x01000193);
    h ^= (input.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Parse an 8-hex-char FNV-1a hash back to a uint32 (the mock's seed). */
export function hashToUint32(hash: string): number {
  return parseInt(hash, 16) >>> 0;
}
