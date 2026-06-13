import { describe, it, expect } from 'vitest';
import { MockClassifier } from '@/offscreen/inference';
import { fnv1a } from '@/shared/hash';
import { float32ToBase64 } from '@/shared/tensor';
import type { ClassifyItem } from '@/shared/messages';

const LABELS = ['home', 'search', 'menu', 'close', 'settings'];

function item(seedStr: string): ClassifyItem {
  const tensor = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  return {
    hash: fnv1a(seedStr),
    tensor: {
      data: float32ToBase64(tensor),
      shape: [1, 3, 1, 1],
      dtype: 'float32',
      configVersion: 1,
    },
  };
}

describe('MockClassifier', () => {
  it('is deterministic: same hash → same label + confidence', async () => {
    const c = new MockClassifier(LABELS);
    const [a] = await c.classify([item('alpha')]);
    const [b] = await c.classify([item('alpha')]);
    expect(a).toEqual(b);
  });

  it('always returns a label from the taxonomy and confidence in [0.5,1)', async () => {
    const c = new MockClassifier(LABELS);
    const results = await c.classify(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(item),
    );
    for (const r of results) {
      expect(LABELS).toContain(r.label);
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.confidence).toBeLessThan(1);
      expect(r.source).toBe('model');
    }
  });

  it('ready() rejects on empty labels', async () => {
    await expect(new MockClassifier([]).ready()).rejects.toThrow();
  });

  it('decodes tensors when verifyTensors is on (no throw on valid data)', async () => {
    const c = new MockClassifier(LABELS, { verifyTensors: true });
    const results = await c.classify([item('verify-me')]);
    expect(results).toHaveLength(1);
  });
});
