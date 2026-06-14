# Icon Labeler

A **Manifest V3 Chrome extension** that finds unlabeled SVG icons on any web page and
gives them a human-readable accessible name for screen readers — a house glyph becomes
`home`, a magnifier becomes `search`. **All inference is on-device**: a 271-class image
classifier ships bundled in the extension and runs locally via
[onnxruntime-web](https://onnxruntime.ai/). No page content, no icon, and no telemetry
ever leaves the browser.

This is an **accessibility tool**, not a visual overlay. When it recognizes a *genuinely
unlabeled* icon it injects `role="img"` + an `aria-label` (and an SVG `<title>`, or `alt`
for an `<img>`), suffixed to disclose the source (`"home (auto-labeled)"`). Icons that are
already accessible are left untouched.

The repo has two halves:

| | Where | What |
|---|---|---|
| **Extension** | `src/`, `scripts/`, root configs | The runtime: DOM scan → rasterize → classify → inject ARIA. **The trained model is committed** — you can build and run without the lab. |
| **Training lab** | `lab/` | The model factory: collect icons → build taxonomy → render → fine-tune (PyTorch/`timm`) → export ONNX. Only needed if you want to re-create or improve the model. |

Design source of truth: [`icon-labeler-extension-plan.md`](./icon-labeler-extension-plan.md).

---

## Quick start (run the extension)

The model is already in the repo, so this is all you need.

**Requirements:** Node 18+ (developed on 26), npm, and Chrome/Chromium **116+**.

```bash
git clone <this-repo> && cd SVG-classifier
npm install          # postinstall runs `wxt prepare` + copies the ORT WASM runtime
npm run dev          # builds to .output/chrome-mv3-dev and watches for changes
```

Then load it unpacked:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select **`.output/chrome-mv3-dev`** (or `.output/chrome-mv3` for a production build)
4. Pin **Icon Labeler** and open any icon-heavy page (GitHub, Gmail, a docs site). Unlabeled icons get named.

For a production build instead of the dev watcher:

```bash
npm run build        # -> .output/chrome-mv3
npm run zip          # -> a distributable .zip
```

### What `npm install` pulls in (and why the model is *not* a download)

| Asset | Size | In git? | How it gets there |
|---|---|---|---|
| **Trained model** `src/public/models/icon-classifier.onnx` | ~7 MB | ✅ **committed** | Already in the clone — it is not reproducible without the lab, so it is checked in. |
| **Label map** `src/public/models/labels.json` | ~75 KB | ✅ committed | The index↔label source of truth, copied from the lab. |
| **ORT WASM runtime** `src/public/ort/*.{wasm,mjs}` | ~13 MB | ❌ gitignored | Copied from `node_modules/onnxruntime-web` by `scripts/copy-ort.mjs` on every `npm install`. Reproducible, so not committed. |

If you ever see a session-create failure, re-run `node scripts/copy-ort.mjs` — both
`ort-wasm-simd-threaded.wasm` **and** its `.mjs` Emscripten glue must be present in
`src/public/ort/`.

---

## Usage

Click the toolbar icon for the **popup**:

- **Enabled** — master on/off.
- **Disable on this site** — adds the current host to your denylist (the extension then never touches that page).
- **Debug badge** — draw a subtle outline + tooltip on every icon it labeled, for sighted verification (`aria-hidden`, never announced).
- **Source attribution** — how the auto-label is disclosed in the accessible name: `Suffix` (`home (auto-labeled)`), `Role description`, or `None` (`home`).
- **Confidence threshold** — below this softmax probability the icon is treated as **unknown** and *no* ARIA is written. Default `0.50` (the model's recommended τ).
- **Stats** for the current tab: *seen / labeled / already-ok / cache hits / unknown*.

**Advanced settings** (the options page) add:

- **Trust class/filename hints** — adopt obvious names like `class="icon-home"` or `home.svg` *without* running the model (fast, usually right).
- **Attribution suffix** text, **result-cache size**, and a **Clear result cache** button.
- **Disabled sites** — a hostname denylist (host + subdomains). Use this for sites whose invisible bot challenges (Vercel BotID, Cloudflare Turnstile, DataDome, …) the extension's DOM writes would otherwise trip. Known third-party challenge iframes are skipped automatically.
- **Defer until the page settles** — wait N ms (or until your first interaction) before scanning, so those challenges resolve before any attribute is written.

**Privacy:** everything runs in a hidden offscreen document on your machine. There are no
network calls at inference time. Permissions are `offscreen`, `storage`, and `<all_urls>`
host access (needed because the goal is "label icons on *any* page").

---

## How it works

MV3 service workers can't touch WebGPU/WASM/Canvas, so inference can't live there. The
pipeline is split across three processes:

```
content script  ──►  service worker  ──►  offscreen document
(DOM: scan, hash,     (broker + cross-      (ONNX session:
 free-label, raster,   page IndexedDB         preprocess → infer
 inject ARIA)          cache, offscreen       → softmax → argmax
                       lifecycle)             → abstain < τ)
```

Most candidate icons never reach the model: identical SVG path strings are **hashed and
cached** (per-tab map → IndexedDB), and nodes already exposing a trustworthy name
(`aria-label`, `<title>`, an `icon-*` class, a source filename) **short-circuit** inference
entirely. Unique icons are batched over ~1 frame and classified visible-first. Out-of-taxonomy
icons are handled by **abstaining below the confidence threshold** rather than forcing a wrong
top-1 label.

**Train/serve rendering parity is the project's #1 risk and is load-bearing.** The extension
rasterizes SVGs through an `OffscreenCanvas` and the lab must render training data the *same
way*. The exact transform is frozen in [`src/shared/config.ts`](./src/shared/config.ts)
(`PREPROCESS`) and mirrored byte-for-byte by `lab/config/preprocess.json`: render to a square
(`currentColor`→black, 2× supersample), composite over white, collapse to **weighted luminance**
(0.299/0.587/0.114), **border-ring polarity flip** for dark-mode invariance, resize to 64,
replicate to 3 channels, normalize `(x−0.5)/0.5`. **Not** RGB/ImageNet. Changing any value
means retrain + re-export + bump `CONFIG_VERSION` (which invalidates the cache). `config.test.ts`
and `tensor.test.ts` pin this.

### Repository layout

```
src/
  content/        DOM scan, SVG extract/normalize, hash, free-label, rasterize, overlay, per-tab cache
  entrypoints/    WXT entrypoints: background.ts, content/, offscreen/, popup/, options/
  offscreen/      inference.ts (Classifier interface + Mock) + onnx.ts (ORT session, dynamically imported)
  shared/         config.ts (the frozen preprocess contract!), messages.ts, settings.ts, denylist.ts, hash.ts, idb.ts, tensor.ts
  public/
    models/       icon-classifier.onnx + labels.json   (committed)
    ort/          onnxruntime-web WASM runtime          (gitignored, copied on install)
tests/            Vitest unit tests + tests/fixtures/demo.html (manual screen-reader page)
lab/              the model fine-tuning lab (see below)
```

### Dev commands

```bash
npm run dev        # WXT dev server, load unpacked from .output/chrome-mv3-dev
npm run build      # production build -> .output/chrome-mv3
npm run zip        # zip a distributable
npm run compile    # tsc --noEmit (type-check)
npm test           # Vitest (unit tests, jsdom)
```

A `MockClassifier` lives behind the same `Classifier` interface for pipeline tests; the real
model is gated by `MOCK_MODE = false` in `src/shared/config.ts`.

---

## The training lab (`lab/`)

You only need this to **re-collect the data** or **re-create / improve the model**. The shipped
model is already committed, so skip this section to just use the extension.

Full details: [`lab/TRAINING.md`](./lab/TRAINING.md) and [`lab/data/README.md`](./lab/data/README.md).

### 1. Set up the lab

```bash
cd lab
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[render-chromium,dev]"
playwright install chromium          # ~150 MB, one-time — the deployment-faithful renderer
```

The Chromium renderer matches the extension's Canvas anti-aliasing (the parity risk above).
Lower-fidelity fallbacks exist as extras: `render-cairo` (needs `brew install cairo`) and
`render-svglib` (pure-Python).

### 2. Re-collect the icon data

The raw icon corpus (**49,045 SVGs, ~192 MB**) is **gitignored** because it's fully
reproducible: `fetch_icons.sh` `npm pack`s 9 permissively-licensed icon libraries at the exact
versions pinned in [`lab/data/SOURCES.tsv`](./lab/data/SOURCES.tsv). What *is* committed is the
**provenance index** (`lab/data/provenance.jsonl`, `concepts.tsv`, `summary.json`, per-library
`licenses/`) — the durable record of what was collected.

```bash
cd lab
bash scripts/fetch_icons.sh            # re-fetch all 9 libraries -> data/raw/<library>/
# bash scripts/fetch_icons.sh lucide   # or just one library
python scripts/build_provenance.py     # rebuild provenance.{jsonl,csv} + concepts.tsv + summary.json
```

Libraries fetched: lucide · heroicons · feather · tabler · bootstrap · phosphor · remix ·
iconoir · material-symbols (all MIT / ISC / Apache-2.0; each library's LICENSE is captured).

> Prefer a frozen snapshot over re-fetching? `data/raw/` is a plain SVG tree — archive it with
> `tar czf icons-raw.tar.gz -C lab/data raw` and distribute that; unpack it back to
> `lab/data/raw/`. Re-fetching from npm is the canonical, smaller-in-git path, so the tree
> itself is intentionally not committed.

### 3. Build the taxonomy (271 classes)

`labels.json` is **derived from the data**, not hand-written. `concept_key`s in the provenance
(~13.7k granular keys) are canonicalized into screen-reader labels by the relabel pipeline in
`data/relabel/`, then a support floor selects the trained classes. The two expensive LLM outputs
(`concept_labels.jsonl`, `review/out_*.json`) are committed; everything else regenerates.

```bash
python data/relabel/build_inventory.py
python data/relabel/relabel.py                       # concept_key -> canonical label
python data/relabel/prep_review.py                   # -> review chunks for the audit pass
python data/relabel/apply_review.py --min-svgs 20 --min-libs 2 --write   # -> config/labels.json
```

### 4. Train, export, evaluate

```bash
python scripts/smoke.py     # OPTIONAL: full chain on a tiny subsample — proves wiring, NOT accuracy
pytest                      # unit tests (render/export tests skip if deps absent)

# Real run (also bundled as: bash run_full_training.sh)
python scripts/build_dataset.py     # provenance -> manifest -> render -> bake splits
python scripts/train.py             # timm fine-tune -> artifacts/checkpoint.pt
python scripts/export.py            # ONNX export + PyTorch↔ONNX parity gate -> artifacts/model/
python scripts/evaluate.py          # top-1/3, macro-F1, ECE, risk-coverage, OOD AUROC
```

`export.py` writes the **drop-in bundle** to `lab/artifacts/model/` (model + `labels.json` +
`preprocess.json`). To ship a new model, copy that model and `labels.json` into
`src/public/models/` and bump `CONFIG_VERSION` if `preprocess.json` changed.

**Last full real-data run** (MobileNetV3-Small, 30 epochs):

| Split | n | Top-1 | Top-3 | macro-F1 |
|---|---|---|---|---|
| val | 2153 | 0.903 | 0.959 | 0.878 |
| test (in-distribution) | 2149 | 0.904 | 0.961 | 0.873 |
| test (OOD, unseen library) | 3798 | 0.505 | 0.662 | 0.438 |

At **τ = 0.5**: 81% coverage on known icons, **97.0%** accuracy on accepted labels, **87.3%** of
out-of-taxonomy icons correctly abstained (unknown-detection AUROC 0.884). The shipped model is
**fp32** (~7 MB); see `lab/TRAINING.md` for why int8 fails the parity gate on this backbone and
fp16 is the recommended smaller alternative.

---

## Scope & limitations

**v1 detects:** inline `<svg>`, `<img>`-of-SVG, and `<use>` sprite references.

**Out of scope** (by design — this is a closed-set 271-class classifier): icon *fonts*
(Font Awesome / Material font glyphs), raster/PNG icons, CSS `background-image` SVGs, and
open-vocabulary description of novel icons (that would need a VLM). The model abstains rather
than guess when it doesn't recognize an icon.

## License

[MIT](./LICENSE). Bundled icon-library data used for training is redistributed under each
library's own permissive license (MIT / ISC / Apache-2.0); see `lab/data/licenses/`.
