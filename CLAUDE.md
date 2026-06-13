# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state: extension built, mock model (pre-real-model)

The full **extension side** is implemented and runs end-to-end against a **mock classifier** (deterministic label-from-hash); the real fine-tuned ONNX model does not exist yet. The `icon-labeler-extension-plan.md` remains the source of truth for the overall design; this codebase is an **accessibility-first** realization of it (the primary deliverable is screen-reader ARIA injection, not visual overlays — see below). The model fine-tuning lab (plan §5) is still un-scaffolded.

**Toolchain (installed):** TypeScript + **WXT** (Vite/Rollup under the hood; chosen over CRXJS for first-class offscreen-document entrypoints + manifest generation) + Vitest/jsdom. `onnxruntime-web` is NOT yet a dependency — it drops in later behind the `Classifier` seam. The model lab will be PyTorch + `timm`, separate from the bundle.

**Commands:** `npm run dev` (WXT dev server → load unpacked from `.output/chrome-mv3`), `npm run build`, `npm run compile` (tsc typecheck), `npm test` (Vitest). After `npm install`, `postinstall` runs `wxt prepare` to generate `.wxt/` types.

**Mock → real model swap:** flip `MOCK_MODE` in `src/shared/config.ts` and replace the `createClassifier()` factory body in `src/offscreen/inference.ts` with `new OnnxClassifier(...)`. The message contracts, pipeline, rasterization, and caching do NOT change — only the classifier and `public/models/labels.json` + the `.onnx` file.

**Accessibility model (the product):** every *genuinely unlabeled* icon gets `role="img"` + `aria-label` + an injected `<title>` (or `alt` for `<img>`), suffixed to attribute us as the source (`"home (mock label)"` now, `"home (auto-labeled)"` in the real build). The do-no-harm gate in `src/content/freeLabel.ts` leaves already-accessible icons untouched — including the ancestor-context check that prevents screen-reader "double-speak" for icons inside already-named buttons/links. Below the confidence threshold → no ARIA written.

**Actual layout (WXT):** entrypoints in `src/entrypoints/{background.ts, content/index.ts, offscreen/, popup/, options/}`; logic modules in `src/{shared,content,offscreen}/`; bundled assets in `src/public/models/`; tests + `tests/fixtures/demo.html` (manual browser/screen-reader test page).

## What this is

A **Manifest V3 Chrome extension** that detects icons (inline `<svg>`, `<img>`-of-SVG, `<use>` sprite refs) on any web page and overlays human-readable labels (house glyph → `home`). All inference is **fully on-device** — no network calls at inference time, the ONNX model is bundled. There are two distinct halves:

1. The **extension** (`src/`, `public/models/`) — runtime detection, rasterization, inference plumbing, overlay UX.
2. The **model fine-tuning lab** (not yet scaffolded) — data sourcing, taxonomy, training, ONNX export/quantization. See plan §5.

## Architecture: the constraints that shape everything

These are the non-obvious decisions. Violating them breaks the project.

- **Inference cannot live in the service worker.** MV3 service workers cannot access WebGPU or WASM. Inference therefore runs in a hidden **offscreen document** (`chrome.offscreen`), the only place WebGPU/WASM/Canvas are available. The service worker is *only* a message broker + offscreen-lifecycle owner + IndexedDB cache; it holds no DOM and runs no model. (Plan §4.2.)

- **Three-process message flow:** content script (DOM, the only component touching the page) → service worker (broker + cross-page cache) → offscreen document (ORT session). Typed message contracts live in `src/shared/messages.ts`. The offscreen doc can be torn down by the browser at any time — handle re-init and model reload gracefully (plan §7).

- **Train/serve rendering skew is the #1 risk.** The extension rasterizes SVGs via **Canvas** (`OffscreenCanvas`). Training data must be rendered the same way (headless-browser/Canvas path, matching anti-aliasing/color normalization) or deployment accuracy collapses. The exact preprocessing (input size, channel order, normalization) is fixed in `src/shared/config.ts` and **must be reused byte-for-byte in the training lab**. (Plan §5.5, §5.8.)

- **`labels.json` is the single shared source of truth** for the index↔label map, used by both training and the extension. Keep them identical.

- **Dedup + free-label short-circuit are what make it "live."** Most candidate icons never hit the model: identical SVG path strings are hashed and cached (per-tab `Map` → IndexedDB), and nodes already exposing a trustworthy name (`aria-label`, `<title>`, `class="icon-home"`, source filename) skip inference entirely. Run the model once per *unique* icon, batch pending ones over a short window, classify visible-first. (Plan §4.6–4.8.)

- **`unknown` via confidence threshold.** Out-of-taxonomy icons are handled by abstaining below a threshold τ chosen from the risk–coverage curve — not by forcing a top-1 label. Whether `unknown` is also an explicit trained class is an open decision (plan §5.11).

## Intended project structure (target, per plan §4.3)

```
src/content/      DOM scan, SVG extract/normalize, hash, free-label, rasterize, overlay, per-tab cache
src/background/   serviceWorker.ts — broker, offscreen mgmt, IndexedDB
src/offscreen/    offscreen.html + inference.ts — ORT session, preprocess→infer→softmax
src/shared/       messages.ts, hash.ts, config.ts (preprocessing!), idb.ts
src/ui/           popup (on/off, threshold, stats)
public/models/    icon-classifier.onnx (int8) + labels.json
tests/            extract/rasterize unit tests + SVG fixtures
```

## Phasing (plan §6)

Build in this order — each phase de-risks the next: (1) MV3 scaffold + content↔SW↔offscreen messaging with a **stub ONNX model** to prove the pipeline before the real model exists; (2) extraction/normalization/rasterization/caching/overlay; (3) model v1 (taxonomy → data → train → export → integrate, tune τ); (4) hardening (sprite resolution, WASM fallback, perf, privacy); (5) deferred: icon fonts, CSS-background SVGs.

## Scope guardrails (plan §2)

v1 is **inline SVG, img-of-SVG, and `<use>` sprites only**. Explicitly out of scope: icon fonts (Font Awesome/Material font glyphs), raster/PNG icons, CSS `background-image` SVGs (all phase-2), and open-vocabulary description of novel icons (would need a VLM — wrong tool for this closed-set classifier). Don't expand scope without checking the plan.
