"""Canonical filesystem paths for the lab, all anchored at the lab/ root.

Importing this module never touches the filesystem; call ``ensure_dirs`` (or the
build scripts) to create generated directories.
"""
from __future__ import annotations

from pathlib import Path

# lab/iconlab/paths.py -> lab/
LAB_ROOT = Path(__file__).resolve().parent.parent

CONFIG_DIR = LAB_ROOT / "config"
PREPROCESS_JSON = CONFIG_DIR / "preprocess.json"
LABELS_JSON = CONFIG_DIR / "labels.json"
TRAIN_YAML = CONFIG_DIR / "train.yaml"

DATA_DIR = LAB_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
MOCK_DIR = DATA_DIR / "mock"
LICENSES_DIR = DATA_DIR / "licenses"


def resolve(p: str | Path) -> Path:
    """Resolve a possibly-relative config path against the lab root."""
    p = Path(p)
    return p if p.is_absolute() else (LAB_ROOT / p)
