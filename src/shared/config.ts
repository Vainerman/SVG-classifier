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

/**
 * How the label reaches the screen reader:
 *  - 'ephemeral' (default): write a single aria-label onto a control ONLY while
 *    it holds keyboard focus, then strip it on blur. The page DOM stays pristine
 *    during the bot-challenge window; the one transient mutation is correlated
 *    with genuine user focus. Covers keyboard-reachable icons (icon buttons/
 *    links). See content/ephemeral.ts.
 *  - 'persistent': legacy — write aria/role/title/alt into the DOM at load and
 *    leave it. Labels every icon (incl. non-focusable) but is visible to page
 *    integrity monitors. Kept for comparison/testing.
 */
export type InjectionMode = 'ephemeral' | 'persistent';

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
  /** Debug: run the model on EVERY icon (incl. ones we normally skip) and show a
   *  badge with the existing accessible name + the generated label. Visual only —
   *  never writes aria onto already-named icons (do-no-harm is preserved). */
  debugLabelAll: boolean;
  /** IndexedDB result-cache size cap (entries). */
  idbMaxEntries: number;
  /** Hosts (exact or subdomain) where the extension stays fully off — never
   *  touches the DOM. Use for sites whose bot challenges we trip. See denylist.ts. */
  siteDenylist: string[];
  /** Delay ALL activity (scan, same-origin SVG fetches, offscreen WASM load) until
   *  the page settles or the user first interacts, so invisible bot challenges
   *  resolve first. On by default — belt-and-suspenders on top of ephemeral mode's
   *  no-DOM-writes guarantee; costs a little label latency. */
  deferActivation: boolean;
  /** When deferActivation is on: ms to wait (or until first interaction) before scanning. */
  deferDelayMs: number;
  /** How labels reach the screen reader. Default 'ephemeral' (focus-driven, leaves
   *  the load-time DOM untouched so bot-challenge integrity checks don't trip). */
  injectionMode: InjectionMode;
}

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  enabled: true,
  // Lowered to 0.1 to favor coverage (label more icons) over precision; the
  // model is mildly over-confident (ECE ~0.19), so this is a floor, not a calibration.
  confidenceThreshold: 0.1,
  attribution: 'suffix',
  attributionText: '(auto-labeled)',
  mockAttributionText: '(mock label)',
  useFreeLabelHints: true,
  debugBadge: MOCK_MODE, // on by default during the mock phase for sighted verification
  debugLabelAll: false,
  idbMaxEntries: 10_000,
  siteDenylist: [],
  deferActivation: true,
  deferDelayMs: 3000,
  injectionMode: 'ephemeral',
};

/** Dedup/batch window: accumulate unique icons, then one batched classify call. */
export const BATCH = {
  windowMs: 16, // ~1 animation frame
  maxBatch: 32,
};

/** Historical name of our DOM sentinel. NO LONGER WRITTEN to the page — the
 *  "have we processed this node" state now lives off-DOM in content/handled.ts
 *  (a WeakSet) so we leave no foreign attribute for integrity monitors to hash.
 *  Kept only as a defensive entry in extract.ts's volatile-attribute stripper. */
export const SENTINEL_ATTR = 'data-icon-labeler';

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
