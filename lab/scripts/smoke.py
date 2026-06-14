#!/usr/bin/env python3
"""End-to-end smoke test on a small real-data subsample — proves the whole lab
pipeline wires up without rendering all 49k icons.

    python scripts/smoke.py

Pipeline: provenance manifest -> subsample (a few classes, few icons each) ->
splits -> bake (render) -> train a few epochs (random init, CPU) -> export int8
ONNX + parity -> evaluate. Writes to data/splits/ and artifacts/ and exits
non-zero if any stage fails or the shipping bundle is missing. Numbers are
meaningless on this tiny subsample; this checks plumbing, not accuracy. Real runs
use the per-stage scripts (build_dataset/train/export/evaluate) with config/train.yaml.
"""
from __future__ import annotations

import copy
import sys

import _bootstrap  # noqa: F401

from iconlab import config, manifest as mfst, paths
from iconlab.config import TrainConfig
from iconlab.dataset import assign_splits, bake_splits, split_stats
from iconlab.evaluate import evaluate
from iconlab.export import export
from iconlab.render import available_backends, get_renderer
from iconlab.train import train


def _set(d: dict, dotted: str, value) -> None:
    node = d
    keys = dotted.split(".")
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = value


SMOKE_CLASSES = 12      # use only the first N in-taxonomy labels
SMOKE_PER_CLASS = 8     # cap source icons per class (keeps rendering fast)
SMOKE_UNKNOWN = 16      # keep a few unknown-pool icons so OOD-AUROC plumbing runs


def fast_config(base: TrainConfig) -> TrainConfig:
    """A quick CPU-friendly override of train.yaml for the smoke run."""
    cfg = TrainConfig(copy.deepcopy(dict(base)))
    _set(cfg, "model.pretrained", False)            # offline, fast
    _set(cfg, "train.epochs", 4)
    _set(cfg, "train.warmup_epochs", 1)
    _set(cfg, "augment.copies_per_train_icon", 4)
    _set(cfg, "export.calibration_samples", 32)
    # tiny subsample + few epochs can't meet real parity thresholds; relax to prove the gate runs
    _set(cfg, "export.parity.min_top1_agreement", 0.0)
    _set(cfg, "export.parity.max_logit_mse", 1e9)
    return cfg


def _subsample(records, label_map):
    """Keep the first SMOKE_CLASSES labels (capped at SMOKE_PER_CLASS source icons
    each), plus up to SMOKE_UNKNOWN unknown-pool icons so the OOD-AUROC path has
    data to chew on."""
    keep_labels = set(label_map.names[:SMOKE_CLASSES])
    per: dict[str, int] = {}
    n_unknown = 0
    out = []
    for r in records:
        if r.role == "label" and r.label in keep_labels:
            if per.get(r.label, 0) >= SMOKE_PER_CLASS:
                continue
            per[r.label] = per.get(r.label, 0) + 1
            out.append(r)
        elif r.role == "unknown" and n_unknown < SMOKE_UNKNOWN:
            n_unknown += 1
            out.append(r)
    return out


def main() -> int:
    label_map = config.labels()
    pp = config.preprocess()
    tcfg = fast_config(config.train_cfg())

    print(f"[smoke] available render backends: {available_backends()}")

    # 1. manifest from the provenance index, subsampled to a few classes
    prov = paths.resolve(tcfg.get_path("data.provenance", "data/provenance.jsonl"))
    records = _subsample(mfst.build_manifest_from_provenance(prov, label_map, tcfg), label_map)
    print("[smoke] manifest:", mfst.summarize(records))
    manifest_path = paths.resolve(tcfg.get_path("paths.manifest"))
    mfst.write_csv(records, manifest_path)

    # 2. splits + bake
    splits = assign_splits(records, label_map, tcfg)
    print("[smoke] splits:", split_stats(splits, label_map))
    splits_dir = paths.resolve(tcfg.get_path("paths.splits_dir"))
    with get_renderer() as renderer:
        print(f"[smoke] rendering with backend={renderer.name}")
        bake_splits(splits, renderer, label_map, pp, tcfg, splits_dir)

    # 3. train
    artifacts = paths.resolve(tcfg.get_path("paths.artifacts_dir"))
    ckpt = train(tcfg, label_map, pp, splits_dir, artifacts)

    # 4. export + parity
    model_out = paths.resolve(tcfg.get_path("paths.model_out_dir"))
    report = export(ckpt, tcfg, label_map, pp, splits_dir, model_out)

    # 5. evaluate
    evaluate(model_out / "icon-classifier.onnx", splits_dir, label_map, pp, tcfg, model_out)

    # 6. assert the shipping bundle exists
    required = ["icon-classifier.onnx", "labels.json", "preprocess.json", "export_report.json", "eval_report.json"]
    missing = [f for f in required if not (model_out / f).exists()]
    if missing:
        print(f"[smoke] FAIL — missing artifacts: {missing}")
        return 1
    print(f"\n[smoke] PASS — bundle at {model_out}")
    print(f"[smoke]   {report['quantize']} size: {report['sizes']['quantized_mb']} MB, parity={report['parity']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
