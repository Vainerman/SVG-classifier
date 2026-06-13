# Training & eval pipeline

The §5.5–§5.9 half of the lab: render/augment → fine-tune (`timm`) → ONNX int8
export with a PyTorch↔ONNX parity gate → full metric suite. Runs on the real
collected dataset; `scripts/smoke.py` exercises the whole chain on a small
subsample. The data-collection half (`scripts/fetch_icons.sh`, `data/raw/`,
`data/provenance.*`, `data/concepts.tsv`) is documented in `data/README.md`, and
the canonical taxonomy is built from it by `data/relabel/` (see below).

## The contract with the extension (single source of truth — do not drift)

Two files in `config/` are shared **byte-for-byte** with the extension; changing
either is a model-breaking change (retrain + re-export):

| File | What | Extension side |
|---|---|---|
| `config/preprocess.json` | input size, Canvas render path, luminance + polarity, normalization, tensor layout | reproduce exactly in `src/shared/config.ts` + the OffscreenCanvas rasterizer |
| `config/labels.json` | index ↔ canonical label, synonyms, `unknown` handling | copied verbatim to `public/models/labels.json` |

`export.py` copies both next to the model into `artifacts/model/` — that directory
*is* the drop-in for the extension's `public/models/`. The default renderer is
**Chromium/Playwright**, rendering SVGs through a real Chromium canvas to match the
extension's anti-aliasing (the #1 train/serve-skew risk, plan §7).

## Install

```bash
cd lab
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[render-chromium,dev]"
playwright install chromium          # ~150 MB, one-time
```

Renderer extras: `render-chromium` (default, deployment-faithful),
`render-cairo` (needs `brew install cairo`), `render-svglib` (pure-Python fallback,
low fidelity). The code auto-falls-back through whatever is installed.

## Prove the plumbing (fast real-data subsample)

```bash
python scripts/smoke.py     # subsample real data -> manifest -> render -> train -> export(int8) -> eval
pytest                      # unit tests (render/export tests skip if deps absent)
```

`smoke.py` subsamples a few classes from the real data and runs the full chain
(random-init, CPU, a few epochs), writing the shipping bundle to `artifacts/model/`.
**Numbers on the subsample are meaningless** — it verifies wiring, not accuracy.

## Building the taxonomy — `config/labels.json` (`data/relabel/`)

The canonical concept set is derived from the collected data, not hand-written.
`concept_key` in `provenance.jsonl` is granular (~13.7k keys; synonyms like
`magnifying-glass`/`search` stay separate), so a relabel pipeline canonicalizes
them into screen-reader labels, then a support floor selects the trained classes:

```bash
python data/relabel/build_inventory.py        # provenance -> inventory.jsonl (per concept_key)
python data/relabel/relabel.py                 # local gemma4:e2b: concept_key -> canonical label (concept_labels.jsonl)
python data/relabel/prep_review.py             # candidate classes -> review/chunk_*.json
#   -> run Sonnet subagents to audit membership -> review/out_*.json  (kept/evicted/reassigned)
python data/relabel/apply_review.py --min-svgs 20 --min-libs 2 --write   # -> config/labels.json (271 classes)
```

The two expensive LLM outputs (`concept_labels.jsonl`, `review/out_*.json`) are
committed; everything else regenerates. Re-cut the taxonomy size by re-running
`apply_review.py` with a different floor (`--min-svgs`/`--min-libs`).

## Run on the real dataset (per stage)

`data/raw/` is populated by `fetch_icons.sh`; `config/train.yaml` already points at
it (`data.raw_root: data/raw`) and reads `data/provenance.jsonl` as the manifest
source (labels resolve off `concept_key` → `labels.json` synonyms, so no
filename-vs-index drift). To train for real:

```bash
python scripts/build_dataset.py                # provenance-resolved manifest + render + bake splits
python scripts/train.py                        # -> artifacts/checkpoint.pt
python scripts/export.py                        # -> artifacts/model/ (int8 + parity gate)
python scripts/evaluate.py                      # acc / macro-F1 / ECE / risk-coverage / OOD AUROC
```

Pick the abstention threshold τ from the risk–coverage table in
`artifacts/model/eval_report.json` and record it in `labels.json`
(`unknown.default_threshold`).

## Manifests — two distinct files, no collision

- `data/provenance.csv` / `.jsonl` — the **data-collection** index (per-SVG
  provenance: library, original name, license, variant). Built by the data half.
- `data/manifest.csv` — the **training** manifest built by `build_dataset.py`:
  provenance **plus** resolved canonical label and split role. Regenerated, gitignored.

`iconlab/manifest.py` reads `provenance.jsonl` directly via
`build_manifest_from_provenance` (resolving labels off `concept_key`); the
tree-walking `build_manifest` is a fallback for trees without provenance.

## Splits (plan §5.6)

| Split | Source | Set by |
|---|---|---|
| train / val / test_id | in-taxonomy icons from non-OOD libraries, stratified per concept by source icon | `assign_splits` |
| test_ood | whole libraries in `train.yaml: data.ood_libraries` | manifest flag |
| unknown | concepts in `train.yaml: data.unknown_pool_concepts` | taxonomy → `unknown` role |
| test_wild | hand-labeled real-site icons (`data/wild/`) — **primary KPI** | TODO: not yet wired |

## Module map

```
iconlab/config.py      load preprocess.json / labels.json / train.yaml
iconlab/taxonomy.py    source-name -> canonical label (+ variant stripping)
iconlab/render.py      SVG -> RGBA, backends: chromium | cairosvg | svglib
iconlab/preprocess.py  the FIXED deploy transform (must match the extension)
iconlab/augment.py     train-only color/geometry/realism augmentation
iconlab/manifest.py    raw tree -> taxonomy-resolved records (data/manifest.csv)
iconlab/dataset.py     split assignment + render-bake to npz + loaders
iconlab/model.py       timm backbone factory
iconlab/train.py       AdamW / cosine / label-smoothing fine-tune
iconlab/export.py      torch -> ONNX -> int8 + parity gate + ship bundle
iconlab/evaluate.py    top1/3, macro-F1, confusion, ECE, risk-coverage, OOD AUROC
```

## Open / deferred (plan §5.11)

- Final backbone + input resolution (accuracy/latency/size sweep).
- `unknown` as an explicit trained class vs pure threshold abstention
  (`labels.json: unknown.explicit_class`).
- Static vs dynamic int8 + calibration-set construction.
- **Test-Wild** wiring (`data/wild/`) — the primary KPI slot.
- **ORT *Web* load check**: `export.py` verifies the model under Python
  onnxruntime; the WebGPU/WASM load+run check can only run in JS and must be wired
  once the extension's offscreen harness exists (plan §5.8 step 4).
```
