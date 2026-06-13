"""Split assignment + rendering each split into a baked .npz of uint8 grayscale.

Splits (plan §5.6): in-taxonomy icons from non-OOD libraries are stratified per
canonical concept into train/val/test_id by *source icon* (all augmentations of
one SVG stay in one split — no leakage). Whole OOD libraries -> test_ood. The
unknown pool -> the `unknown` split (OOD/abstention eval only).

Baking renders each source icon to uint8 grayscale at input_size: train icons get
N augmented copies; eval icons get clean copies. Storing the cheap 8-bit middle
keeps npz small and makes training rendering-free and reproducible. This module is
torch-free; train.py/evaluate.py turn npz into tensors via preprocess.normalize.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .augment import augment_to_luminance, render_clean_to_luminance
from .config import LabelMap, PreprocessConfig, TrainConfig
from .manifest import Record
from .render import Renderer

SPLITS = ("train", "val", "test_id", "test_ood", "unknown")
UNKNOWN_Y = -1


def assign_splits(
    records: list[Record], label_map: LabelMap, train_cfg: TrainConfig
) -> dict[str, list[Record]]:
    seed = int(train_cfg.get_path("data.seed", 0))
    sp = train_cfg.get_path("data.split", {}) or {}
    r_train = float(sp.get("train", 0.6))
    r_val = float(sp.get("val", 0.2))
    r_test = float(sp.get("test_id", 0.2))

    out: dict[str, list[Record]] = {s: [] for s in SPLITS}

    # group in-taxonomy, non-OOD records per concept for stratified splitting
    per_label: dict[str, list[Record]] = {}
    for r in records:
        if r.role == "unknown":
            out["unknown"].append(r)
        elif r.role == "label" and r.is_ood_library:
            out["test_ood"].append(r)
        elif r.role == "label":
            per_label.setdefault(r.label, []).append(r)
        # role == "drop" -> ignored

    rng = np.random.default_rng(seed)
    for label, group in sorted(per_label.items()):
        idx = rng.permutation(len(group))
        n = len(group)
        n_train = max(1, int(round(n * r_train))) if n else 0
        rem = n - n_train
        denom = r_val + r_test
        n_val = int(round(rem * (r_val / denom))) if rem and denom else 0
        n_val = min(n_val, rem)
        # assignment
        for k, i in enumerate(idx):
            if k < n_train:
                out["train"].append(group[i])
            elif k < n_train + n_val:
                out["val"].append(group[i])
            else:
                out["test_id"].append(group[i])
    return out


def _copies_for(split: str, train_cfg: TrainConfig) -> int:
    if split == "train":
        return int(train_cfg.get_path("augment.copies_per_train_icon", 1))
    return int(train_cfg.get_path("augment.copies_per_eval_icon", 1))


def bake_splits(
    splits: dict[str, list[Record]],
    renderer: Renderer,
    label_map: LabelMap,
    preprocess_cfg: PreprocessConfig,
    train_cfg: TrainConfig,
    out_dir: Path,
    on_progress=None,
) -> dict[str, Path]:
    """Render every split to ``out_dir/<split>.npz``. Returns {split: path}.

    Each npz holds: images (uint8 [N,H,W]), labels (int64 [N], -1=unknown),
    srcs (<U str [N]), libs (<U str [N]).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    acfg = dict(train_cfg.get("augment", {}))
    seed = int(train_cfg.get_path("data.seed", 0))
    written: dict[str, Path] = {}
    failures = 0

    for split, records in splits.items():
        imgs: list[np.ndarray] = []
        ys: list[int] = []
        srcs: list[str] = []
        libs: list[str] = []
        copies = _copies_for(split, train_cfg)

        for ri, rec in enumerate(records):
            try:
                svg = rec.abs_path.read_text()
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            y = UNKNOWN_Y if rec.role == "unknown" else label_map.index_of(rec.label)
            for c in range(copies):
                # deterministic per (split, record, copy)
                rng = np.random.default_rng((seed, hash(split) & 0xFFFF, ri, c))
                try:
                    if split == "train":
                        g = augment_to_luminance(renderer, svg, rng, acfg, preprocess_cfg)
                    else:
                        g = render_clean_to_luminance(renderer, svg, preprocess_cfg)
                except Exception:  # noqa: BLE001
                    failures += 1
                    continue
                imgs.append(g)
                ys.append(y)
                srcs.append(rec.rel_path)
                libs.append(rec.library)
            if on_progress:
                on_progress(split, ri + 1, len(records))

        path = out_dir / f"{split}.npz"
        if imgs:
            arr = np.stack(imgs).astype(np.uint8)
        else:
            s = preprocess_cfg.input_size
            arr = np.empty((0, s, s), dtype=np.uint8)
        np.savez_compressed(
            path,
            images=arr,
            labels=np.asarray(ys, dtype=np.int64),
            srcs=np.asarray(srcs, dtype=object).astype("U") if srcs else np.array([], dtype="U1"),
            libs=np.asarray(libs, dtype=object).astype("U") if libs else np.array([], dtype="U1"),
        )
        written[split] = path

    if failures:
        print(f"[bake] WARNING: {failures} render/read failures were skipped")
    return written


def load_split(npz_path: Path) -> dict[str, np.ndarray]:
    with np.load(npz_path, allow_pickle=False) as z:
        return {k: z[k] for k in ("images", "labels", "srcs", "libs")}


def split_stats(splits: dict[str, list[Record]], label_map: LabelMap) -> dict[str, object]:
    stats: dict[str, object] = {}
    for split, recs in splits.items():
        per: dict[str, int] = {}
        for r in recs:
            per[r.label or "?"] = per.get(r.label or "?", 0) + 1
        stats[split] = {"icons": len(recs), "per_label": dict(sorted(per.items()))}
    return stats
