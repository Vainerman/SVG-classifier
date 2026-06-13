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
export const CONFIG_VERSION = 1;

export const PREPROCESS = {
  /** Square input edge. 48 is too lossy for thin 1px strokes; 96 is 2.25x the
   *  pixels for marginal gain. */
  inputSize: 64,
  /** RGB. The backbone is ImageNet-pretrained (3-channel); resolving
   *  currentColor onto white preserves real foreground/background contrast. */
  channels: 3,
  /** PyTorch/ORT default; matches a timm ONNX export. */
  layout: 'NCHW',
  /** Opaque background the icon is composited onto before tensorizing. */
  background: '#FFFFFF',
  /** Used when currentColor cannot be resolved from computed style. */
  foregroundFallback: '#000000',
  /** Aspect-preserving: pad to square, then resize (don't distort wide glyphs). */
  resize: 'contain-pad',
  dtype: 'float32',
  /** ImageNet normalization — the lab fine-tunes from ImageNet weights, so these
   *  are the train/serve match. THESE NUMBERS ARE THE SKEW TRIPWIRE. */
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
} as const;

/**
 * MOCK_MODE flips to false when the real ONNX model ships. It gates: the mock
 * attribution suffix, the "MOCK MODEL" popup banner, the debug-badge default,
 * and the classifier factory (offscreen/inference.ts).
 */
export const MOCK_MODE = true;

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
}

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  enabled: true,
  confidenceThreshold: 0.55,
  attribution: 'suffix',
  attributionText: '(auto-labeled)',
  mockAttributionText: '(mock label)',
  useFreeLabelHints: true,
  debugBadge: MOCK_MODE, // on by default during the mock phase for sighted verification
  idbMaxEntries: 10_000,
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

/** Attributes we write — the MutationObserver ignores mutations to these to
 *  avoid an infinite self-trigger loop. */
export const OWNED_ATTRS = [
  'aria-label',
  'aria-roledescription',
  'role',
  'alt',
  SENTINEL_ATTR,
] as const;
