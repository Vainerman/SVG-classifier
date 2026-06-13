import { describe, it, expect } from 'vitest';
import { fnv1a, hashToUint32 } from '@/shared/hash';

describe('fnv1a', () => {
  it('is deterministic and 8 hex chars', () => {
    expect(fnv1a('home')).toBe(fnv1a('home'));
    expect(fnv1a('home')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('distinguishes different strings', () => {
    expect(fnv1a('home')).not.toBe(fnv1a('search'));
    expect(fnv1a('')).not.toBe(fnv1a('a'));
  });

  it('round-trips to a uint32 seed', () => {
    const h = fnv1a('some-canonical-svg');
    const n = hashToUint32(h);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0xffffffff);
  });
});
