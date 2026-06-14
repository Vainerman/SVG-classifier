/**
 * Typed message contracts for the three-process flow:
 *   content script  →  service worker  →  offscreen document
 *
 * This contract must survive the mock→ONNX swap UNCHANGED. The classifier is
 * mocked; the plumbing is real.
 *
 * NOTE ON THE TENSOR WIRE FORMAT: chrome.runtime messaging serializes payloads
 * as JSON — ArrayBuffers and typed arrays do NOT survive (they'd arrive as `{}`).
 * So the rasterized tensor travels as a base64 string of its little-endian
 * Float32 bytes (see shared/tensor.ts). The real model decodes it the same way.
 */
import type { BehaviorSettings } from '@/shared/config';

export interface IconTensor {
  /** base64 of the little-endian Float32 buffer (JSON-safe; see note above). */
  data: string;
  /** [N, C, H, W]; N is 1 per item (items are batched as an array). */
  shape: [number, number, number, number];
  dtype: 'float32';
  /** Must equal CONFIG_VERSION on the receiver, or the tensor is rejected. */
  configVersion: number;
}

export interface ClassifyItem {
  /** Canonical-SVG hash: the cache key AND the mock's deterministic seed. */
  hash: string;
  tensor: IconTensor;
}

export type ResultSource = 'model' | 'cache';

export interface ClassifyResult {
  hash: string;
  /** Canonical label from labels.json, or 'unknown' when below threshold. */
  label: string;
  confidence: number;
  source: ResultSource;
}

// ── content → service worker (awaited via sendResponse) ──────────────────────
export type ContentRequest =
  | { type: 'CACHE_LOOKUP'; target: 'background'; hashes: string[] }
  | { type: 'CLASSIFY_BATCH'; target: 'background'; items: ClassifyItem[] };

export interface CacheLookupResponse {
  results: ClassifyResult[];
  misses: string[];
}
export interface ClassifyResponse {
  results: ClassifyResult[];
}

// ── service worker → offscreen (awaited via sendResponse) ────────────────────
export type OffscreenRequest = {
  type: 'OFFSCREEN_CLASSIFY';
  target: 'offscreen';
  items: ClassifyItem[];
};
export interface OffscreenClassifyResponse {
  results: ClassifyResult[];
}

/** Broadcast by the offscreen doc once the (mock) classifier is loaded. */
export type OffscreenBroadcast = { type: 'OFFSCREEN_READY'; target: 'background' };

// ── popup → active-tab content script (stats + icon readout) ─────────────────
export type PopupRequest =
  | { type: 'GET_STATS'; target: 'content' }
  | { type: 'GET_READOUT'; target: 'content' };

/** Mirrors content/extract.ts IconKind (inlined to keep shared/ free of content deps). */
export type IconRenderKind = 'inline-svg' | 'sprite-svg' | 'img-svg';

/**
 * One detected icon, for the popup's off-page readout. `src` is renderable in an
 * `<img>` (a `data:image/svg+xml` URI for inline/sprite SVG; the original `src`
 * for `<img>`-of-SVG) — SVG in an `<img>` can't execute script, so it's safe to
 * show page-derived markup in the privileged popup. Showing this in extension UI
 * means we verify what the model sees WITHOUT touching the page DOM.
 */
export interface ReadoutItem {
  src: string;
  kind: IconRenderKind;
  /** Predicted/adopted label; '' while still pending classification. */
  label: string;
  confidence: number;
  /** 'model' | 'cache' | 'free-label'. */
  source: string;
  /** 'labeled' = delivered name; 'low' = below threshold (no aria); 'pending'. */
  state: 'labeled' | 'low' | 'pending';
}

export interface ReadoutResponse {
  stats: PipelineStats;
  items: ReadoutItem[];
  /** True if more icons were detected than the readout cap. */
  truncated: boolean;
}

export interface PipelineStats {
  /** Candidate icons discovered. */
  seen: number;
  /** Icons we wrote an aria label onto (model + free-label). */
  labeled: number;
  /** Icons deliberately left alone (already accessible / decorative). */
  skipped: number;
  /** Cache hits (memory + IndexedDB). */
  cacheHits: number;
  /** Below-threshold abstentions (no aria written). */
  unknown: number;
}
export type StatsResponse = { stats: PipelineStats };

/** Settings travel via chrome.storage (see shared/settings.ts), not messages. */
export type AnySettings = BehaviorSettings;
