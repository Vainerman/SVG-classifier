/**
 * The train/serve-skew tripwire. PREPROCESS is a FROZEN contract the training
 * lab must mirror byte-for-byte. If this snapshot changes, you MUST bump
 * CONFIG_VERSION (invalidating the cache) AND update the lab — so make the test
 * fail loudly on any accidental edit.
 */
import { describe, it, expect } from 'vitest';
import { PREPROCESS, CONFIG_VERSION } from '@/shared/config';

describe('frozen preprocessing contract', () => {
  it('matches the lab preprocess.json (bump CONFIG_VERSION + retrain if this changes)', () => {
    expect({ CONFIG_VERSION, ...PREPROCESS }).toEqual({
      CONFIG_VERSION: 2,
      inputSize: 64,
      channels: 3,
      layout: 'NCHW',
      renderColor: '#000000',
      background: '#FFFFFF',
      supersample: 2,
      channelLayout: 'luminance_replicated',
      luminanceWeights: [0.299, 0.587, 0.114],
      autoPolarity: true,
      polarityReference: 'border',
      polarityThreshold: 127.5,
      resize: 'bilinear',
      dtype: 'float32',
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    });
  });
});
