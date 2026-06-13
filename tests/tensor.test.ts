import { describe, it, expect } from 'vitest';
import { float32ToBase64, base64ToFloat32, checksumTensor } from '@/shared/tensor';
import { packNCHW, type RGBAImage } from '@/content/rasterize';
import { PREPROCESS } from '@/shared/config';

describe('tensor base64 round-trip (chrome.runtime is JSON-only)', () => {
  it('survives encode → decode', () => {
    const arr = new Float32Array([0, 1, -1, 0.5, 1234.5, -0.001]);
    const back = base64ToFloat32(float32ToBase64(arr));
    expect(Array.from(back)).toEqual(Array.from(arr));
  });

  it('checksum flags a fully-zero (failed-raster) tensor', () => {
    expect(checksumTensor(new Float32Array(16)).nonZero).toBe(0);
    expect(checksumTensor(new Float32Array([0, 0, 3])).nonZero).toBe(1);
    expect(checksumTensor(new Float32Array([NaN])).finite).toBe(false);
  });
});

describe('packNCHW', () => {
  it('produces [3*H*W] in NCHW with ImageNet normalization', () => {
    // 2x1 white image (RGBA).
    const img: RGBAImage = {
      width: 2,
      height: 1,
      data: [255, 255, 255, 255, 255, 255, 255, 255],
    };
    const out = packNCHW(img);
    expect(out.length).toBe(3 * 1 * 2);
    // white pixel: (1 - mean)/std per channel.
    const { mean, std } = PREPROCESS;
    expect(out[0]).toBeCloseTo((1 - mean[0]) / std[0], 5); // R, x=0
    expect(out[2]).toBeCloseTo((1 - mean[1]) / std[1], 5); // G channel offset
    expect(out[4]).toBeCloseTo((1 - mean[2]) / std[2], 5); // B channel offset
  });

  it('lays out channels then rows (NCHW)', () => {
    const img: RGBAImage = {
      width: 2,
      height: 1,
      data: [0, 0, 0, 255, 255, 255, 255, 255], // px0 black, px1 white
    };
    const out = packNCHW(img);
    const { mean, std } = PREPROCESS;
    // R channel: index 0 = px0 (black), index 1 = px1 (white)
    expect(out[0]).toBeCloseTo((0 - mean[0]) / std[0], 5);
    expect(out[1]).toBeCloseTo((1 - mean[0]) / std[0], 5);
  });
});
