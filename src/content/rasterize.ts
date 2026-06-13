/**
 * Rasterize an on-page icon to the model's input tensor, per the FROZEN
 * shared/config.ts preprocessing. Runs in the content script, which has
 * OffscreenCanvas + createImageBitmap + getComputedStyle (to resolve
 * currentColor exactly as the user sees it).
 *
 * (Note: the content-script `OffscreenCanvas` here is NOT the MV3 *offscreen
 * document* — that hosts inference. Two different "offscreen" things.)
 *
 * The pixel path needs a real browser; `packNCHW` (the tensor math) is factored
 * out as a pure function and unit-tested with a synthetic ImageData.
 */
import { PREPROCESS } from '@/shared/config';
import { resolveUses, type IconKind } from '@/content/extract';
import { CONFIG_VERSION } from '@/shared/config';
import type { IconTensor } from '@/shared/messages';
import { float32ToBase64 } from '@/shared/tensor';

const SIZE = PREPROCESS.inputSize;

/** Minimal ImageData shape so this is testable without a DOM. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

/**
 * Pack an SIZE×SIZE RGBA image into a normalized NCHW Float32Array
 * ([1, 3, SIZE, SIZE]) using ImageNet mean/std. Pure + deterministic.
 */
export function packNCHW(img: RGBAImage): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(3 * h * w);
  const { mean, std } = PREPROCESS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (data[px + c] as number) / 255;
        out[c * h * w + y * w + x] = (v - mean[c]) / std[c];
      }
    }
  }
  return out;
}

function tensorFrom(arr: Float32Array): IconTensor {
  return {
    data: float32ToBase64(arr),
    shape: [1, PREPROCESS.channels, SIZE, SIZE],
    dtype: 'float32',
    configVersion: CONFIG_VERSION,
  };
}

/** Render size to target — bigger than the canvas for crisp downscaling. */
const RENDER_TARGET = 128;

/**
 * Intrinsic SVG size in user units. Prefer viewBox (unit-agnostic), then numeric
 * width/height, then the rendered box, then a default. Many real icons set ONLY
 * a viewBox — and createImageBitmap throws on an SVG with no explicit pixel size,
 * which is exactly why inline SVGs must get width/height before rasterizing.
 */
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

/** Resolve currentColor and force explicit dimensions into a standalone SVG string. */
function prepareSvgString(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  let color: string = PREPROCESS.foregroundFallback;
  try {
    const computed = svg.ownerDocument?.defaultView?.getComputedStyle(svg);
    if (computed?.color) color = computed.color;
  } catch {
    /* fall back to default foreground */
  }
  // Inline <use> sprite geometry so the standalone SVG isn't blank.
  resolveUses(clone);

  // currentColor in the markup resolves against the root `color`.
  clone.setAttribute('color', color);
  clone.style.color = color;

  const { w, h } = getSvgRenderSize(svg);
  // A viewBox is required for the content to scale to the new width/height.
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const k = RENDER_TARGET / Math.max(w, h);
  clone.setAttribute('width', String(Math.max(1, Math.round(w * k))));
  clone.setAttribute('height', String(Math.max(1, Math.round(h * k))));
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  return new XMLSerializer().serializeToString(clone);
}

/** Fallback for environments/SVGs where createImageBitmap(blob) is unreliable. */
function loadSvgImage(svgString: string): Promise<HTMLImageElement> {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG image decode failed'));
    img.src = url;
  });
}

/** Draw a source onto a white SIZE×SIZE canvas, contain-padded, → ImageData. */
function drawContain(
  ctx: OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): void {
  ctx.fillStyle = PREPROCESS.background;
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (srcW <= 0 || srcH <= 0) return;
  const scale = Math.min(SIZE / srcW, SIZE / srcH);
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const dx = Math.floor((SIZE - dw) / 2);
  const dy = Math.floor((SIZE - dh) / 2);
  ctx.drawImage(source, dx, dy, dw, dh);
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
    if (kind === 'img-svg') {
      const img = el as HTMLImageElement;
      const w = img.naturalWidth || img.width || SIZE;
      const h = img.naturalHeight || img.height || SIZE;
      drawContain(ctx, img, w, h);
    } else {
      const svg = el as unknown as SVGElement;
      const svgString = prepareSvgString(svg);
      try {
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const bitmap = await createImageBitmap(blob);
        drawContain(ctx, bitmap, bitmap.width || SIZE, bitmap.height || SIZE);
        bitmap.close();
      } catch {
        // Some Chrome builds reject SVG blobs in createImageBitmap; the <img>
        // data-URL path is more forgiving.
        const img = await loadSvgImage(svgString);
        drawContain(ctx, img, img.naturalWidth || SIZE, img.naturalHeight || SIZE);
      }
    }
    // getImageData throws (SecurityError) if the canvas is tainted by a
    // cross-origin <img> SVG — caught below → null → skip classification.
    const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
    return tensorFrom(packNCHW(imageData));
  } catch (err) {
    console.debug('[icon-labeler] rasterize failed, skipping icon', err);
    return null;
  }
}
