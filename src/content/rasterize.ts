/**
 * Rasterize an on-page icon to the model's input tensor, mirroring the lab's
 * FIXED transform byte-for-byte (lab/iconlab/preprocess.py + render.py;
 * lab/artifacts/model/preprocess.json). Train/serve rendering skew is the #1
 * project risk — this file is the deploy-side half of that contract.
 *
 * Pipeline (matches the lab):
 *   1. Force the SVG to a square (supersample×inputSize), currentColor → black,
 *      draw it over white. The SVG's own preserveAspectRatio letterboxes the art.
 *   2. Downscale to inputSize (Canvas high-quality ≈ the lab's PIL bilinear).
 *   3. Weighted luminance (0.299/0.587/0.114).
 *   4. Border-ring polarity: if the border is the dark side, invert.
 *   5. Replicate luminance to 3 channels, normalize (x-0.5)/0.5, NCHW.
 *
 * Runs in the content script (has OffscreenCanvas + createImageBitmap). The
 * pixel path needs a real browser; `imageToTensor` (steps 3-5) is a pure
 * function, unit-tested against the Python reference.
 */
import { CONFIG_VERSION, PREPROCESS } from '@/shared/config';
import { resolveUses, type IconKind } from '@/content/extract';
import type { IconTensor } from '@/shared/messages';
import { float32ToBase64 } from '@/shared/tensor';

const SIZE = PREPROCESS.inputSize;
const RENDER = SIZE * PREPROCESS.supersample; // e.g. 128
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Minimal ImageData shape so the tensor math is testable without a DOM. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

/**
 * RGBA (composited-over-white) image → normalized NCHW Float32Array
 * [1,3,SIZE,SIZE]: weighted luminance → border polarity → (x-0.5)/0.5,
 * replicated across 3 channels. Pure + deterministic.
 */
export function imageToTensor(img: RGBAImage): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lum = new Float32Array(n);
  const [wr, wg, wb] = PREPROCESS.luminanceWeights;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = wr * (data[p] as number) + wg * (data[p + 1] as number) + wb * (data[p + 2] as number);
  }

  // Polarity: make the border ring the light side.
  if (PREPROCESS.autoPolarity && borderMean(lum, w, h) < PREPROCESS.polarityThreshold) {
    for (let i = 0; i < n; i++) lum[i] = 255 - lum[i];
  }

  // Normalize once, then replicate identical luminance to all channels (NCHW).
  const mean = PREPROCESS.mean[0];
  const std = PREPROCESS.std[0];
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = (lum[i] / 255 - mean) / std;
    out[i] = v;
    out[n + i] = v;
    out[2 * n + i] = v;
  }
  return out;
}

function borderMean(lum: Float32Array, w: number, h: number): number {
  if (w < 2 || h < 2) {
    let s = 0;
    for (let i = 0; i < lum.length; i++) s += lum[i];
    return s / lum.length;
  }
  let sum = 0;
  let count = 0;
  for (let x = 0; x < w; x++) {
    sum += lum[x] + lum[(h - 1) * w + x]; // top + bottom rows
    count += 2;
  }
  for (let y = 0; y < h; y++) {
    sum += lum[y * w] + lum[y * w + (w - 1)]; // left + right cols
    count += 2;
  }
  return sum / count;
}

function tensorFrom(arr: Float32Array): IconTensor {
  return {
    data: float32ToBase64(arr),
    shape: [1, PREPROCESS.channels, SIZE, SIZE],
    dtype: 'float32',
    configVersion: CONFIG_VERSION,
  };
}

/** Intrinsic SVG size (viewBox → numeric w/h → bounding box → default). */
export function getSvgRenderSize(svg: SVGElement): { w: number; h: number } {
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
  }
  const wAttr = parseFloat(svg.getAttribute('width') ?? '');
  const hAttr = parseFloat(svg.getAttribute('height') ?? '');
  if (wAttr > 0 && hAttr > 0) return { w: wAttr, h: hAttr };
  try {
    const r = (svg as unknown as Element).getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  } catch {
    /* detached / jsdom */
  }
  return { w: SIZE, h: SIZE };
}

/**
 * Standalone SVG string: <use> inlined, currentColor → black, forced to a square
 * RENDER×RENDER (the SVG's viewBox + preserveAspectRatio letterbox the art, just
 * like the lab's normalize_svg_dimensions).
 */
function prepareSvgString(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  resolveUses(clone);

  // currentColor → black (do NOT use the page color; the model never saw it).
  clone.setAttribute('color', PREPROCESS.renderColor);
  clone.style.color = PREPROCESS.renderColor;

  const { w, h } = getSvgRenderSize(svg);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  clone.setAttribute('width', String(RENDER));
  clone.setAttribute('height', String(RENDER));
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NS);
  return new XMLSerializer().serializeToString(clone);
}

function fillWhite(ctx: OffscreenCanvasRenderingContext2D): void {
  ctx.fillStyle = PREPROCESS.background;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

/** Contain-pad draw (preserve aspect) — for <img>, which has no preserveAspectRatio. */
function drawContain(
  ctx: OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): void {
  if (srcW <= 0 || srcH <= 0) return;
  const scale = Math.min(SIZE / srcW, SIZE / srcH);
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  ctx.drawImage(source, Math.floor((SIZE - dw) / 2), Math.floor((SIZE - dh) / 2), dw, dh);
}

function loadSvgImage(svgString: string): Promise<HTMLImageElement> {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG image decode failed'));
    img.src = url;
  });
}

/**
 * Rasterize an icon to a tensor, or null if it can't be drawn (e.g. a tainted
 * cross-origin <img> SVG). Async: createImageBitmap / image decode.
 */
export async function rasterizeIcon(
  el: Element,
  kind: IconKind,
): Promise<IconTensor | null> {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    fillWhite(ctx);
    if (kind === 'img-svg') {
      const img = el as HTMLImageElement;
      const w = img.naturalWidth || img.width || SIZE;
      const h = img.naturalHeight || img.height || SIZE;
      drawContain(ctx, img, w, h);
    } else {
      const svg = el as unknown as SVGElement;
      const svgString = prepareSvgString(svg);
      try {
        const bitmap = await createImageBitmap(
          new Blob([svgString], { type: 'image/svg+xml' }),
        );
        // bitmap is RENDER×RENDER (square, art letterboxed) → fill the SIZE canvas.
        ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
        bitmap.close();
      } catch {
        const img = await loadSvgImage(svgString);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
      }
    }
    // getImageData throws (SecurityError) if tainted by a cross-origin <img>.
    const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
    return tensorFrom(imageToTensor(imageData));
  } catch (err) {
    console.debug('[icon-labeler] rasterize failed, skipping icon', err);
    return null;
  }
}
