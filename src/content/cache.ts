/**
 * Per-tab in-memory result cache + pending-node fan-out. Checked before any
 * messaging to the service worker. A single classify result for a hash is
 * applied to EVERY duplicate node that shares it (dedup).
 */
import type { ClassifyResult } from '@/shared/messages';

const memCache = new Map<string, ClassifyResult>();

export function getCached(hash: string): ClassifyResult | undefined {
  return memCache.get(hash);
}

export function setCached(result: ClassifyResult): void {
  memCache.set(result.hash, result);
}

export function hasCached(hash: string): boolean {
  return memCache.has(hash);
}

export function cacheSize(): number {
  return memCache.size;
}
