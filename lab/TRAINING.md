# Training & eval pipeline

The §5.5–§5.9 half of the lab: render/augment → fine-tune (`timm`) → ONNX int8
export with a PyTorch↔ONNX parity gate → full metric suite. Scaffolded with a
**mock dataset** so the whole chain runs before the real taxonomy is final. The
data-collection half (`scripts/fetch_icons.sh`, `data/raw/`, `data/provenance.*`,
`data/concepts.tsv`) is documented in `data/README.md`.

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

## Prove the plumbing on mock data

```bash
python scripts/make_mock_data.py     # tiny synthetic libraries -> data/mock/
python scripts/smoke.py              # manifest -> render -> train -> export(int8) -> eval
pytest                               # unit tests (render/export tests skip if deps absent)
```

`smoke.py` runs the full chain (random-init, CPU, a few epochs) and writes the
shipping bundle to `artifacts/model/`. **Numbers on mock data are meaningless** —
it verifies wiring, not accuracy.

## Run on the real dataset (per stage)

`data/raw/` is already populated by `fetch_icons.sh`. Before training for real,
extend `config/labels.json` (the canonical concept set) and, if needed,
`iconlab/taxonomy.py` to map the real library names; seed it from
`data/concepts.tsv`. Then set `data.raw_root: data/raw` in `config/train.yaml`
(or pass `--raw-root`) and:

```bash
python scripts/build_dataset.py --raw-root data/raw   # taxonomy-resolved manifest + render + bake splits
python scripts/train.py                                # -> artifacts/checkpoint.pt
python scripts/export.py                               # -> artifacts/model/ (int8 + parity gate)
python scripts/evaluate.py                             # acc / macro-F1 / ECE / risk-coverage / OOD AUROC
```

Pick the abstention threshold τ from the risk–coverage table in
`artifacts/model/eval_report.json` and record it in `labels.json`
(`unknown.default_threshold`).

## Manifests — two distinct files, no collision

- `data/provenance.csv` / `.jsonl` — the **data-collection** index (per-SVG
  provenance: library, original name, license, variant). Built by the data half.
- `data/manifest.csv` — the **training** manifest built by `build_dataset.py`:
  provenance **plus** resolved canonical label and split role. Regenerated, gitignored.

When a provenance loader is wired up, `iconlab/manifest.py` can read
`provenance.jsonl` instead of walking the tree.

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
