#!/usr/bin/env python3
"""End-to-end smoke test on mock data — proves the whole lab pipeline wires up
before the real dataset exists.

    python scripts/smoke.py

Pipeline: (generate mock data) -> manifest -> splits -> bake (render) -> train a
few epochs (random init, CPU) -> export int8 ONNX + parity -> evaluate. It writes
to data/splits/ and artifacts/ and exits non-zero if any stage fails or the
shipping bundle is missing. Numbers are meaningless on mock data; this checks
plumbing, not accuracy. Real runs use the per-stage scripts with config/train.yaml.
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


def fast_config(base: TrainConfig) -> TrainConfig:
    """A quick CPU-friendly override of train.yaml for the smoke run."""
    cfg = TrainConfig(copy.deepcopy(dict(base)))
    _set(cfg, "model.pretrained", False)            # offline, fast
    _set(cfg, "train.epochs", 4)
    _set(cfg, "train.warmup_epochs", 1)
    _set(cfg, "augment.copies_per_train_icon", 4)
    _set(cfg, "export.calibration_samples", 32)
    # mock data + few epochs can't meet real parity thresholds; relax to prove the gate runs
    _set(cfg, "export.parity.min_top1_agreement", 0.0)
    _set(cfg, "export.parity.max_logit_mse", 1e9)
    return cfg


def main() -> int:
    label_map = config.labels()
    pp = config.preprocess()
    tcfg = fast_config(config.train_cfg())

    # 0. mock data
    mock_root = paths.MOCK_DIR
    if not any(mock_root.rglob("*.svg")):
        print("[smoke] generating mock data...")
        import runpy
        runpy.run_path(str(paths.LAB_ROOT / "scripts" / "make_mock_data.py"), run_name="__main__")

    print(f"[smoke] available render backends: {available_backends()}")

    # 1. manifest
    records = mfst.build_manifest(mock_root, label_map, tcfg)
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
    print(f"[smoke]   int8 size: {report['sizes']['int8_mb']} MB, parity={report['parity']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
