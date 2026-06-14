/**
 * FROZEN SHARED CONTRACT.
 *
 * `PREPROCESS` and `CONFIG_VERSION` must be mirrored byte-for-byte by the future
 * training lab. Train/serve rendering skew is the project's #1 risk: any
 * divergence in input size, channel order, normalization, background, or resize
 * policy silently tanks deployment accuracy with NO error. Treat this object as
 * a contract, not a tweakable. A snapshot test pins it so a careless edit fails
 * CI loudly. Bumping CONFIG_VERSION invalidates the IndexedDB result cache.
 */
// Bumped from 1 → 2 when the real model landed: preprocessing changed from
// RGB+ImageNet to luminance+polarity+[-1,1]. The bump invalidates stale IDB cache.
export const CONFIG_VERSION = 2;

/**
 * Mirrors the lab's `lab/artifacts/model/preprocess.json` byte-for-byte. The
 * model was TRAINED on exactly this transform; any divergence collapses
 * accuracy. (See lab/iconlab/preprocess.py + render.py.)
 */
export const PREPROCESS = {
  /** Square input edge the model expects. */
  inputSize: 64,
  /** 3 channels, but all carry the SAME luminance (replicated) — see channelLayout. */
  channels: 3,
  /** PyTorch/ORT default; matches the timm ONNX export ([N,3,64,64]). */
  layout: 'NCHW',
  /** currentColor is forced to black to match the lab's img-loaded Chromium
   *  render (currentColor defaults to black there). We do NOT use the page's
   *  color — the model never saw it. */
  renderColor: '#000000',
  /** Opaque background the icon is composited onto. */
  background: '#FFFFFF',
  /** Render at inputSize*supersample, then downscale — approximates the lab's
   *  Canvas anti-aliasing (preprocess.json render.supersample). */
  supersample: 2,
  /** Collapse color → one luminance channel, then replicate to `channels`. */
  channelLayout: 'luminance_replicated',
  /** ITU-R BT.601 luminance weights (preprocess.json color.luminance_weights). */
  luminanceWeights: [0.299, 0.587, 0.114] as const,
  /** If the border ring is the dark side, invert so the background is light —
   *  makes the model invariant to dark-mode / inverted icons. */
  autoPolarity: true,
  polarityReference: 'border',
  /** Border-mean luminance below this (0..255) → flip polarity. */
  polarityThreshold: 127.5,
  resize: 'bilinear',
  dtype: 'float32',
  /** (x-0.5)/0.5 → [-1,1]; identical per channel. THE SKEW TRIPWIRE. */
  mean: [0.5, 0.5, 0.5] as const,
  std: [0.5, 0.5, 0.5] as const,
} as const;

/**
 * MOCK_MODE flips to false when the real ONNX model ships. It gates: the mock
 * attribution suffix, the "MOCK MODEL" popup banner, the debug-badge default,
 * and the classifier factory (offscreen/inference.ts).
 */
export const MOCK_MODE = false;

export type AttributionMode = 'suffix' | 'roledescription' | 'none';

export interface BehaviorSettings {
  enabled: boolean;
  /** Below this, the icon is treated as `unknown` and NO aria is written. */
  confidenceThreshold: number;
  attribution: AttributionMode;
  /** Appended to the accessible name in the real build, e.g. "home (auto-labeled)". */
  attributionText: string;
  /** Used instead during the mock phase so SR users are never misled. */
  mockAttributionText: string;
  /** Adopt class="icon-home" / data-icon / filename hints instead of the model. */
  useFreeLabelHints: boolean;
  /** Subtle on-screen outline+tooltip on labeled icons (aria-hidden). */
  debugBadge: boolean;
  /** IndexedDB result-cache size cap (entries). */
  idbMaxEntries: number;
  /** Hosts (exact or subdomain) where the extension stays fully off — never
   *  touches the DOM. Use for sites whose bot challenges we trip. See denylist.ts. */
  siteDenylist: string[];
  /** Delay scanning until the page settles, so invisible bot challenges resolve
   *  before we mutate the DOM. Off by default (adds label latency). */
  deferActivation: boolean;
  /** When deferActivation is on: ms to wait (or until first interaction) before scanning. */
  deferDelayMs: number;
}

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  enabled: true,
  // Model's recommended default (labels.json unknown.default_threshold). The
  // model is mildly over-confident (ECE ~0.19), so this is a floor, not a calibration.
  confidenceThreshold: 0.5,
  attribution: 'suffix',
  attributionText: '(auto-labeled)',
  mockAttributionText: '(mock label)',
  useFreeLabelHints: true,
  debugBadge: MOCK_MODE, // on by default during the mock phase for sighted verification
  idbMaxEntries: 10_000,
  siteDenylist: [],
  deferActivation: false,
  deferDelayMs: 3000,
};

/** Dedup/batch window: accumulate unique icons, then one batched classify call. */
export const BATCH = {
  windowMs: 16, // ~1 animation frame
  maxBatch: 32,
};

/** Marks nodes we've already processed; doubles as the MutationObserver self-loop guard. */
export const SENTINEL_ATTR = 'data-icon-labeler';
/** Stored value when we deliberately SKIP a node (already accessible / decorative). */
export const SENTINEL_SKIP = 'skip';

/** chrome.storage.local key for BehaviorSettings. */
export const STORAGE_KEY = 'iconLabeler.settings';

/** Bundled label map (single source of truth), resolved via chrome.runtime.getURL. */
export const LABELS_URL_PATH = 'models/labels.json';

/** Bundled ONNX model (fp32, WASM-safe), resolved via chrome.runtime.getURL. */
export const MODEL_URL_PATH = 'models/icon-classifier.onnx';

/** Attributes we write — the MutationObserver ignores mutations to these to
 *  avoid an infinite self-trigger loop. */
export const OWNED_ATTRS = [
  'aria-label',
  'aria-roledescription',
  'role',
  'alt',
  SENTINEL_ATTR,
] as const;
