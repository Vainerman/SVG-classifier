import { describe, it, expect } from 'vitest';
import { float32ToBase64, base64ToFloat32, checksumTensor } from '@/shared/tensor';
import {
  imageToTensor,
  getSvgRenderSize,
  getSvgTextFromImg,
  type RGBAImage,
} from '@/content/rasterize';

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

describe('imageToTensor — luminance + polarity + normalize (lab parity)', () => {
  // Build a w×h RGBA buffer from a per-pixel [r,g,b] generator.
  function rgba(w: number, h: number, px: (x: number, y: number) => [number, number, number]): RGBAImage {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const [r, g, b] = px(x, y);
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    return { width: w, height: h, data };
  }

  it('outputs [3*H*W] with the luminance replicated across channels', () => {
    const img = rgba(4, 4, () => [255, 255, 255]); // all white
    const out = imageToTensor(img);
    const n = 16;
    expect(out.length).toBe(3 * n);
    // white → lum 255 → (1-0.5)/0.5 = 1; all three channels identical.
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[n]).toBeCloseTo(1, 5);
    expect(out[2 * n]).toBeCloseTo(1, 5);
  });

  it('uses BT.601 luminance weights', () => {
    const img = rgba(2, 2, () => [255, 0, 0]); // pure red → lum 0.299*255
    const out = imageToTensor(img);
    // border is all-red (lum ~76 < 127.5) → polarity flips → lum 255-76=179.
    const lum = 255 - 0.299 * 255;
    expect(out[0]).toBeCloseTo((lum / 255 - 0.5) / 0.5, 4);
  });

  it('does NOT flip when the border is light (dark glyph on white)', () => {
    // White border, one dark center pixel — border mean ~ white → no flip.
    const img = rgba(3, 3, (x, y) => (x === 1 && y === 1 ? [0, 0, 0] : [255, 255, 255]));
    const out = imageToTensor(img);
    const center = 1 * 3 + 1; // index 4
    expect(out[center]).toBeCloseTo(-1, 5); // black stays black → (0-0.5)/0.5 = -1
    expect(out[0]).toBeCloseTo(1, 5); // corner white → +1
  });

  it('FLIPS when the border is dark (light glyph on dark = dark-mode icon)', () => {
    // Black border, one white center — border dark → invert so border→light.
    const img = rgba(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0]));
    const out = imageToTensor(img);
    const center = 4;
    // center was white(255) → flipped to 0 → (0-0.5)/0.5 = -1 (now the dark glyph)
    expect(out[center]).toBeCloseTo(-1, 5);
    // border was black(0) → flipped to 255 → +1 (now light background)
    expect(out[0]).toBeCloseTo(1, 5);
  });
});

describe('getSvgTextFromImg — recover <img> SVG source (the img-svg raster fix)', () => {
  function img(src: string): HTMLImageElement {
    const el = document.createElement('img');
    el.setAttribute('src', src);
    return el;
  }

  it('decodes a url-encoded data: URI (incl. %23 → #)', async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><circle fill='#334155'/></svg>";
    const src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    expect(await getSvgTextFromImg(img(src))).toBe(svg);
  });

  it('decodes a base64 data: URI', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const src = 'data:image/svg+xml;base64,' + btoa(svg);
    expect(await getSvgTextFromImg(img(src))).toBe(svg);
  });
});

describe('getSvgRenderSize — the inline-SVG raster fix', () => {
  function svgEl(html: string): SVGElement {
    document.body.innerHTML = html;
    return document.body.querySelector('svg') as unknown as SVGElement;
  }

  it('derives size from viewBox when width/height are absent (the bug case)', () => {
    expect(getSvgRenderSize(svgEl('<svg viewBox="0 0 24 24"></svg>'))).toEqual({ w: 24, h: 24 });
  });

  it('handles non-square viewBoxes', () => {
    expect(getSvgRenderSize(svgEl('<svg viewBox="0 0 48 16"></svg>'))).toEqual({ w: 48, h: 16 });
  });

  it('prefers numeric width/height when there is no viewBox', () => {
    expect(getSvgRenderSize(svgEl('<svg width="32" height="20"></svg>'))).toEqual({ w: 32, h: 20 });
  });

  it('falls back to a non-zero default when nothing is specified', () => {
    const { w, h } = getSvgRenderSize(svgEl('<svg></svg>'));
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });
});
