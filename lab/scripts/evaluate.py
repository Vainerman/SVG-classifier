#!/usr/bin/env python3
"""Evaluate the exported int8 ONNX model on every split.

    python scripts/evaluate.py [--onnx artifacts/model/icon-classifier.onnx]

Output: artifacts/model/eval_report.json
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from iconlab import config, paths
from iconlab.evaluate import evaluate


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", default=None)
    args = ap.parse_args()

    tcfg = config.train_cfg()
    model_out = paths.resolve(tcfg.get_path("paths.model_out_dir", "artifacts/model"))
    onnx_path = paths.resolve(args.onnx) if args.onnx else model_out / "icon-classifier.onnx"
    splits_dir = paths.resolve(tcfg.get_path("paths.splits_dir", "data/splits"))

    evaluate(onnx_path, splits_dir, config.labels(), config.preprocess(), tcfg, model_out)


if __name__ == "__main__":
    main()
