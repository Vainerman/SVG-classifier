#!/usr/bin/env python3
"""Fine-tune the classifier on baked splits.

    python scripts/train.py        # uses config/train.yaml

Output: artifacts/checkpoint.pt
"""
from __future__ import annotations

import _bootstrap  # noqa: F401

from iconlab import config, paths
from iconlab.train import train


def main() -> None:
    label_map = config.labels()
    pp = config.preprocess()
    tcfg = config.train_cfg()
    splits_dir = paths.resolve(tcfg.get_path("paths.splits_dir", "data/splits"))
    artifacts = paths.resolve(tcfg.get_path("paths.artifacts_dir", "artifacts"))
    ckpt = train(tcfg, label_map, pp, splits_dir, artifacts)
    print(f"checkpoint: {ckpt}")


if __name__ == "__main__":
    main()
