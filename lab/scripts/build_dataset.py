#!/usr/bin/env python3
"""Build the dataset: raw SVG tree -> manifest.csv -> baked npz splits.

    python scripts/build_dataset.py [--raw-root data/mock] [--backend chromium]

Runs the full render path (the #1 train/serve-skew lever), so it needs a working
renderer. Output: data/manifest.csv and data/splits/<split>.npz.
"""
from __future__ import annotations

import argparse
import json

import _bootstrap  # noqa: F401

from iconlab import config, manifest as mfst, paths
from iconlab.dataset import assign_splits, bake_splits, split_stats
from iconlab.render import get_renderer


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-root", default=None, help="override data.raw_root from train.yaml")
    ap.add_argument("--backend", default=None, help="override render backend")
    args = ap.parse_args()

    label_map = config.labels()
    pp = config.preprocess()
    tcfg = config.train_cfg()

    raw_root = paths.resolve(args.raw_root or tcfg.get_path("data.raw_root", "data/mock"))
    if not raw_root.exists():
        raise SystemExit(f"raw root {raw_root} does not exist — run scripts/make_mock_data.py "
                         f"or scripts/fetch_icons.sh first")

    records = mfst.build_manifest(raw_root, label_map, tcfg)
    manifest_path = paths.resolve(tcfg.get_path("paths.manifest", "data/manifest.csv"))
    mfst.write_csv(records, manifest_path)
    print(f"[build] manifest: {manifest_path}")
    print(json.dumps(mfst.summarize(records), indent=2))

    splits = assign_splits(records, label_map, tcfg)
    print("[build] split assignment:")
    print(json.dumps(split_stats(splits, label_map), indent=2))

    splits_dir = paths.resolve(tcfg.get_path("paths.splits_dir", "data/splits"))
    backend = args.backend or tcfg.get_path("render.backend") or pp.render_backend
    print(f"[build] rendering with backend={backend} -> {splits_dir}")
    with get_renderer(backend) as renderer:
        written = bake_splits(splits, renderer, label_map, pp, tcfg, splits_dir,
                              on_progress=_progress)
    print()
    for split, path in written.items():
        import numpy as np
        with np.load(path) as z:
            print(f"[build] {split:9s} -> {path.name}  images={len(z['images'])}")


_last = {"split": None}


def _progress(split: str, done: int, total: int) -> None:
    if split != _last["split"]:
        if _last["split"] is not None:
            print()
        print(f"  [{split}] ", end="", flush=True)
        _last["split"] = split
    print(f"\r  [{split}] {done}/{total}", end="", flush=True)


if __name__ == "__main__":
    main()
