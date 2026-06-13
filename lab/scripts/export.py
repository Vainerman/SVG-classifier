#!/usr/bin/env python3
"""Export the trained checkpoint to int8 ONNX + run the parity gate.

    python scripts/export.py [--checkpoint artifacts/checkpoint.pt]

Output: artifacts/model/icon-classifier.onnx (+ labels.json, preprocess.json,
export_report.json) — the bundle destined for the extension's public/models/.
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from iconlab import config, paths
from iconlab.export import export


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=None)
    args = ap.parse_args()

    tcfg = config.train_cfg()
    artifacts = paths.resolve(tcfg.get_path("paths.artifacts_dir", "artifacts"))
    ckpt = paths.resolve(args.checkpoint) if args.checkpoint else artifacts / "checkpoint.pt"
    splits_dir = paths.resolve(tcfg.get_path("paths.splits_dir", "data/splits"))
    model_out = paths.resolve(tcfg.get_path("paths.model_out_dir", "artifacts/model"))

    export(ckpt, tcfg, config.labels(), config.preprocess(), splits_dir, model_out)


if __name__ == "__main__":
    main()
