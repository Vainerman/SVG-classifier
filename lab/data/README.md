# Icon-classifier training data

Labeled SVG icons for the model fine-tuning lab (see `../../icon-labeler-extension-plan.md`,
§5.3–§5.6). This is the **library-sourced** half of the data: SVGs from permissively
licensed open icon libraries where **the filename is the label**.

> Not yet included: the **Test-Wild** set (hand-/weak-labeled icons scraped from real
> sites, §5.6) — the primary deployment KPI. See `../wild/README.md` for the harvesting
> recipe; this is the intended next step.

## What's here

| File / dir | Contents |
|---|---|
| `raw/<library>/…` | The SVG files, one folder per library, original directory layout preserved (so variant/size subdirs survive). 49,045 SVGs. |
| `provenance.jsonl` | **Primary index.** One JSON object per SVG with full provenance (schema below). |
| `provenance.csv` | Same rows, flat — for spreadsheets / quick filtering. |
| `concepts.tsv` | `concept_key → total_svgs, num_libraries, libraries`. Sorted by cross-library coverage. **The seed for building the canonical taxonomy (§5.4).** |
| `summary.json` | Dataset-level counts (per library, per style, per license). |
| `SOURCES.tsv` | Exact npm package + **version** + license + source URL fetched per library. |
| `licenses/` | A copy of each library's LICENSE file (compliance). |

> The **training** manifest + rendered splits are a separate concern, produced by the
> lab's own pipeline (`scripts/build_dataset.py`) which reads `raw/` directly. The files
> here just document the collected data; they don't drive training.

## Provenance schema (`provenance.jsonl`)

```jsonc
{
  "path":         "raw/lucide/icons/home.svg", // relative to lab/data/
  "library":      "lucide",                    // provenance / OOD-split key (§5.6)
  "name":         "home",                       // icon name with variant tokens stripped
  "concept_key":  "home",                       // slugified name — taxonomy GROUPING HINT, not the final label
  "raw_name":     "home",                       // original filename stem, untouched
  "style":        "outline",                    // normalized: outline | filled | duotone
  "variant":      "outline",                    // library's own term (solid, fill, line, bold, thin, duotone, …)
  "corner_style": null,                          // material-symbols only: outlined | rounded | sharp
  "size":         null,                          // heroicons only: 16 | 20 | 24
  "category":     null,                          // remix only: e.g. "Buildings"
  "license":      "ISC",
  "source_url":   "https://github.com/lucide-icons/lucide"
}
```

### Important: `concept_key` is a seed, not the taxonomy

`concept_key` is just the slugified filename. It is the **starting material** for the
canonical concept map in plan §5.4 (e.g. `concepts.tsv` shows `home` exists in 9 libraries
→ strong canonical concept; `house`/`home` still need merging by a human). The final
`labels.json` (the single source of truth shared with the extension) is a deliberate human
decision and is **not** produced here.

## Dataset at a glance

- **49,045** SVGs · **13,743** unique `concept_key`s · **1,891** concepts in ≥2 libraries · **284** in ≥5.
- Per library: material-symbols 23,310 · phosphor 9,072 · tabler 6,146 · remix 3,229 ·
  bootstrap 2,078 · lucide 1,964 · iconoir 1,671 · heroicons 1,288 · feather 287.
- Per style: outline 29,852 · filled 17,681 · duotone 1,512.
- Licenses: MIT, ISC, Apache-2.0 — all permissive; provenance + license recorded per sample.

## Caveats for training

- **Class imbalance by library.** material-symbols (3 corner styles × fill) is ~48% of the
  data; its rounded/sharp/outlined are near-duplicate geometries. Use class-balanced
  sampling (§5.7) and/or subsample material-symbols so it doesn't dominate.
- **Reserve whole libraries for Test-OOD** (§5.6) using the `library` field — don't let a
  concept leak across train/test in a trivially memorizable way. Split by `concept_key`.
- **Train/serve rendering skew is the #1 risk** (§5.5, §7). These are *vector* sources;
  you must rasterize them with the **same Canvas path** the extension uses, with the exact
  preprocessing fixed in `src/shared/config.ts`. Don't pre-render here with a mismatched
  renderer.
- **`currentColor`.** Most of these inherit `currentColor`; render-time color augmentation
  (random fg/bg, dark mode) happens in the lab, not in this raw data.

## Reproduce / extend

```bash
bash ../scripts/fetch_icons.sh            # re-fetch all libraries (latest versions)
bash ../scripts/fetch_icons.sh lucide     # or a single library
python3 ../scripts/build_provenance.py    # rebuild provenance/concepts/summary
```

`raw/` is regenerable from the scripts; exact versions are pinned in `SOURCES.tsv`. It is
large (~192 MB, 49k files) — consider Git LFS or leaving `raw/` untracked if committing.
