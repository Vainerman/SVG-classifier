# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state: extension built, REAL model wired (271-class ONNX)

The full **extension side** is implemented and runs end-to-end against the **real fine-tuned model** (`MOCK_MODE = false`): a 271-class fp32 ONNX classifier (~7 MB, opset 17) trained in `lab/` and copied to `src/public/models/`, served via **onnxruntime-web** (WASM CPU EP, `numThreads=1`) in the offscreen document. A `MockClassifier` remains behind the same `Classifier` interface for pipeline tests. The `icon-labeler-extension-plan.md` is the design source of truth; the `lab/` dir is the (separately-built) training lab. This codebase is **accessibility-first** (the product is screen-reader ARIA injection, not visual overlays).

**Toolchain:** TypeScript + **WXT** (Vite/Rollup; chosen over CRXJS for first-class offscreen entrypoints) + Vitest/jsdom + **onnxruntime-web**. The model lab is PyTorch + `timm` under `lab/`.

**Commands:** `npm run dev` (load unpacked from `.output/chrome-mv3`), `npm run build`, `npm run compile` (tsc), `npm test` (Vitest). `postinstall` runs `wxt prepare` **and `scripts/copy-ort.mjs`** (copies the ORT `.wasm`+`.mjs` runtime into `src/public/ort/`, gitignored, ~13 MB, reproducible from npm). The trained model IS committed (`src/public/models/`, ~7 MB **fp32**, not reproducible without the lab) — it is NOT gitignored. Only `src/public/ort/` (ORT runtime) and `lab/data/raw/` (192 MB icon corpus) are gitignored, and both regenerate.

## Setup — route a fresh clone by intent (the user-facing `README.md` is the canonical setup doc)

`README.md` is the public setup/usage doc; keep it and this file in sync. Three setup paths:

- **Extension only** (most common — the model is committed, so no lab needed): `npm install` (postinstall fetches the ORT WASM) → `npm run dev` → load unpacked from `.output/chrome-mv3-dev`. Needs Node 18+ and Chrome 116+.
- **Lab only** (re-collect data / retrain): `cd lab` → venv → `pip install -e ".[render-chromium,dev]"` → `playwright install chromium`. Re-collect data with `bash scripts/fetch_icons.sh` + `python scripts/build_provenance.py`. Train chain: `build_dataset.py → train.py → export.py → evaluate.py` (or `bash run_full_training.sh`); `scripts/smoke.py` proves wiring on a subsample. See `lab/TRAINING.md` + `lab/data/README.md`.
- **Both / ship a new model:** retrain in the lab, then copy `lab/artifacts/model/{icon-classifier.onnx,labels.json}` → `src/public/models/` and bump `CONFIG_VERSION` if `preprocess.json` changed.

**Train/serve parity is the #1 risk and is LOAD-BEARING.** `src/shared/config.ts` `PREPROCESS` mirrors `lab/artifacts/model/preprocess.json` byte-for-byte and `src/content/rasterize.ts` reproduces `lab/iconlab/preprocess.py`: render the SVG to a square (currentColor→**black**, supersample 2×), composite over white, **weighted luminance** (0.299/0.587/0.114), **border-ring polarity flip** (dark-mode invariance), resize to 64, replicate to 3 channels, normalize `(x-0.5)/0.5`. NOT RGB/ImageNet. Changing any value = retrain + re-export + bump `CONFIG_VERSION` (invalidates IDB cache). `config.test.ts` + `tensor.test.ts` pin this.

**ORT wasm bundling:** `wxt.config.ts` sets the Vite resolve condition `onnxruntime-web-use-extern-wasm` so Vite does NOT bundle its own copy of the wasm; we ship + load it from `ort/` via `ort.env.wasm.wasmPaths`. The extern build needs BOTH `ort-wasm-simd-threaded.{mjs,wasm}` at that path (the `.mjs` Emscripten glue is required — shipping only `.wasm` fails at session create).

**Model → labels:** `lab/artifacts/model/labels.json` (rich schema: `{index,name,display,synonyms}` + `unknown` threshold) is copied verbatim; `parseLabels()` in `inference.ts` flattens it to an index-ordered, screen-reader-humanized `string[]` (`arrow_right` → "arrow right"). `OnnxClassifier` (`src/offscreen/onnx.ts`, dynamically imported so ORT stays out of the test graph) softmaxes the `logits` output, argmaxes, and abstains below `confidenceThreshold` (default 0.5).

**Accessibility model (the product):** a *genuinely unlabeled* icon's computed name is delivered to the screen reader as `aria-label` (or `alt`/`<title>`), suffixed to attribute the source (`"home (auto-labeled)"`). The do-no-harm gate in `src/content/freeLabel.ts` leaves already-accessible icons untouched — incl. the ancestor-context check preventing screen-reader "double-speak" for icons inside already-named buttons/links. Below threshold → no ARIA written.

**Two delivery strategies (`settings.injectionMode`, `src/content/ephemeral.ts` + `overlay.ts`):**
- **`'ephemeral'` (DEFAULT) — Architecture A, anti-bot-safe.** Nothing is written to the DOM at load. All classification still happens off-DOM; the result is *registered* per focusable control. A single `aria-label` (+ `role="img"` only for a focusable bare `<svg>`) is injected onto the control **on `focusin` and stripped on `focusout`** (document-delegated, capture phase). The page DOM is byte-identical to the server's during the bot-challenge window; the only mutation is a transient attribute on the element the human just focused. Why you *can't* label an arbitrary node invisibly (verified): no `attachShadow` on svg/img, `attachInternals` is custom-element-only, AOM virtual nodes were dropped for privacy — so the win is collapsing *when/how much* you mutate, not hiding the mechanism. Scope: keyboard-reachable icons only (icon buttons/links); non-focusable standalone icons are deliberately uncovered → "Architecture B" (extension-owned reader surface) is the future follow-up. Scanner runs **eager** in this mode (`ScannerOptions.eager`) so labels are registered before the user can Tab to an off-screen control — eager processing makes no DOM writes, so it has no footprint cost. Open risk to validate on real SRs: the focusin name-race (some SR/browser pairs cache the name at focus); fallback is pre-arm on Tab keydown.
- **`'persistent'` — legacy.** `applyLabel()` writes `role`/`aria-label`/`<title>`/`alt` into the DOM at load and leaves them. Labels every icon (incl. non-focusable) but its writes are visible to site integrity monitors. Kept for comparison/testing.

**No DOM sentinel.** "Have we processed this node" state lives in a `WeakSet` (`src/content/handled.ts`), NOT a `data-icon-labeler` attribute — we leave no foreign attribute for integrity monitors to hash. `SENTINEL_ATTR` survives only as a defensive entry in `extract.ts`'s volatile-attribute stripper. `resetHandled()` clears the set on an ephemeral⇄persistent mode switch.

**Layout (WXT):** entrypoints in `src/entrypoints/{background.ts, content/index.ts, offscreen/, popup/, options/}`; logic in `src/{shared,content,offscreen}/`; bundled assets in `src/public/{models,ort}/`; tests + `tests/fixtures/demo.html` (manual browser/screen-reader page).

## What this is

A **Manifest V3 Chrome extension** that detects icons (inline `<svg>`, `<img>`-of-SVG, `<use>` sprite refs) on any web page and overlays human-readable labels (house glyph → `home`). All inference is **fully on-device** — no network calls at inference time, the ONNX model is bundled. There are two distinct halves:

1. The **extension** (`src/`, `public/models/`) — runtime detection, rasterization, inference plumbing, overlay UX.
2. The **model fine-tuning lab** (`lab/`, fully scaffolded and run) — data sourcing, taxonomy, training, ONNX export/quantization. See `lab/TRAINING.md` and plan §5.

## Architecture: the constraints that shape everything

These are the non-obvious decisions. Violating them breaks the project.

- **Inference cannot live in the service worker.** MV3 service workers cannot access WebGPU or WASM. Inference therefore runs in a hidden **offscreen document** (`chrome.offscreen`), the only place WebGPU/WASM/Canvas are available. The service worker is *only* a message broker + offscreen-lifecycle owner + IndexedDB cache; it holds no DOM and runs no model. (Plan §4.2.)

- **Three-process message flow:** content script (DOM, the only component touching the page) → service worker (broker + cross-page cache) → offscreen document (ORT session). Typed message contracts live in `src/shared/messages.ts`. The offscreen doc can be torn down by the browser at any time — handle re-init and model reload gracefully (plan §7).

- **Train/serve rendering skew is the #1 risk.** The extension rasterizes SVGs via **Canvas** (`OffscreenCanvas`). Training data must be rendered the same way (headless-browser/Canvas path, matching anti-aliasing/color normalization) or deployment accuracy collapses. The exact preprocessing (input size, channel order, normalization) is fixed in `src/shared/config.ts` and **must be reused byte-for-byte in the training lab**. (Plan §5.5, §5.8.)

- **`labels.json` is the single shared source of truth** for the index↔label map, used by both training and the extension. Keep them identical.

- **Dedup + free-label short-circuit are what make it "live."** Most candidate icons never hit the model: identical SVG path strings are hashed and cached (per-tab `Map` → IndexedDB), and nodes already exposing a trustworthy name (`aria-label`, `<title>`, `class="icon-home"`, source filename) skip inference entirely. Run the model once per *unique* icon, batch pending ones over a short window, classify visible-first. (Plan §4.6–4.8.)

- **`unknown` via confidence threshold.** Out-of-taxonomy icons are handled by abstaining below a threshold τ chosen from the risk–coverage curve — not by forcing a top-1 label. Whether `unknown` is also an explicit trained class is an open decision (plan §5.11).

## Project structure (actual — see "Layout (WXT)" above for the live map)

The plan's §4.3 target (`src/background/`, `src/ui/`) was realized under WXT's entrypoint
convention; the real tree is:

```
src/content/      DOM scan, SVG extract/normalize, hash, free-label, rasterize, overlay, per-tab cache
src/entrypoints/  WXT entrypoints: background.ts (broker, offscreen mgmt, IndexedDB), content/, offscreen/, popup/, options/
src/offscreen/    inference.ts (Classifier interface + Mock) + onnx.ts — ORT session, preprocess→infer→softmax
src/shared/       config.ts (preprocessing!), messages.ts, settings.ts, denylist.ts, hash.ts, idb.ts, tensor.ts
src/public/models/  icon-classifier.onnx (fp32, ~7 MB, committed) + labels.json
src/public/ort/     onnxruntime-web WASM runtime (gitignored, copied on install)
tests/            extract/rasterize unit tests + SVG fixtures + demo.html
```

## Phasing (plan §6)

Build in this order — each phase de-risks the next: (1) MV3 scaffold + content↔SW↔offscreen messaging with a **stub ONNX model** to prove the pipeline before the real model exists; (2) extraction/normalization/rasterization/caching/overlay; (3) model v1 (taxonomy → data → train → export → integrate, tune τ); (4) hardening (sprite resolution, WASM fallback, perf, privacy); (5) deferred: icon fonts, CSS-background SVGs.

## Scope guardrails (plan §2)

v1 is **inline SVG, img-of-SVG, and `<use>` sprites only**. Explicitly out of scope: icon fonts (Font Awesome/Material font glyphs), raster/PNG icons, CSS `background-image` SVGs (all phase-2), and open-vocabulary description of novel icons (would need a VLM — wrong tool for this closed-set classifier). Don't expand scope without checking the plan.
