/**
 * The train/serve-skew tripwire. PREPROCESS is a FROZEN contract the training
 * lab must mirror byte-for-byte. If this snapshot changes, you MUST bump
 * CONFIG_VERSION (invalidating the cache) AND update the lab — so make the test
 * fail loudly on any accidental edit.
 */
import { describe, it, expect } from 'vitest';
import { PREPROCESS, CONFIG_VERSION } from '@/shared/config';

describe('frozen preprocessing contract', () => {
  it('matches the pinned snapshot (bump CONFIG_VERSION + update the lab if this changes)', () => {
    expect({ CONFIG_VERSION, ...PREPROCESS }).toEqual({
      CONFIG_VERSION: 1,
      inputSize: 64,
      channels: 3,
      layout: 'NCHW',
      background: '#FFFFFF',
      foregroundFallback: '#000000',
      resize: 'contain-pad',
      dtype: 'float32',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
    });
  });
});
