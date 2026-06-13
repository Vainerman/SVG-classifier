"""Typed loaders for the three config files.

- ``preprocess.json`` and ``labels.json`` are the byte-for-byte contract shared
  with the extension; load them, never mutate them at runtime.
- ``train.yaml`` is lab-only and freely tunable.

JSON keys starting with ``$comment`` are documentation and ignored here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from . import paths


# --------------------------------------------------------------------------- #
# preprocess.json
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PreprocessConfig:
    version: int
    input_size: int
    render_backend: str
    fallback_backends: tuple[str, ...]
    supersample: int
    background: tuple[int, int, int]
    luminance_weights: tuple[float, float, float]
    auto_polarity: bool
    polarity_reference: str
    channels: int
    channel_layout: str
    resize_method: str
    resize_antialias: bool
    norm_mean: tuple[float, float, float]
    norm_std: tuple[float, float, float]
    layout: str
    dtype: str
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> "PreprocessConfig":
        d = json.loads((path or paths.PREPROCESS_JSON).read_text())
        return cls(
            version=d["version"],
            input_size=d["input_size"],
            render_backend=d["render"]["backend"],
            fallback_backends=tuple(d["render"].get("fallback_backends", [])),
            supersample=d["render"].get("supersample", 1),
            background=tuple(d["color"]["background"]),
            luminance_weights=tuple(d["color"]["luminance_weights"]),
            auto_polarity=d["color"]["auto_polarity"],
            polarity_reference=d["color"].get("polarity_reference", "border"),
            channels=d["channels"],
            channel_layout=d["channel_layout"],
            resize_method=d["resize"]["method"],
            resize_antialias=d["resize"]["antialias"],
            norm_mean=tuple(d["normalize"]["mean"]),
            norm_std=tuple(d["normalize"]["std"]),
            layout=d["tensor"]["layout"],
            dtype=d["tensor"]["dtype"],
            raw=d,
        )


# --------------------------------------------------------------------------- #
# labels.json
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class LabelMap:
    version: int
    names: tuple[str, ...]                      # index -> canonical name
    displays: tuple[str, ...]                   # index -> display string
    synonyms: dict[str, list[str]]              # canonical -> alternate source names
    unknown_label: str
    unknown_is_explicit_class: bool
    default_threshold: float

    @property
    def num_classes(self) -> int:
        return len(self.names)

    def index_of(self, name: str) -> int:
        return self.names.index(name)

    @classmethod
    def load(cls, path: Path | None = None) -> "LabelMap":
        d = json.loads((path or paths.LABELS_JSON).read_text())
        rows = sorted(d["labels"], key=lambda r: r["index"])
        indices = [r["index"] for r in rows]
        if indices != list(range(len(indices))):
            raise ValueError(f"labels.json indices must be contiguous from 0, got {indices}")
        unk = d["unknown"]
        return cls(
            version=d["version"],
            names=tuple(r["name"] for r in rows),
            displays=tuple(r.get("display", r["name"]) for r in rows),
            synonyms={r["name"]: list(r.get("synonyms", [])) for r in rows},
            unknown_label=unk["label"],
            unknown_is_explicit_class=unk.get("explicit_class", False),
            default_threshold=unk.get("default_threshold", 0.5),
        )


# --------------------------------------------------------------------------- #
# train.yaml  (kept as a plain dict wrapper — freely tunable, no rigid schema)
# --------------------------------------------------------------------------- #
class TrainConfig(dict):
    """Dict subclass with dotted-path access: cfg.get_path('export.parity.max_logit_mse')."""

    @classmethod
    def load(cls, path: Path | None = None) -> "TrainConfig":
        return cls(yaml.safe_load((path or paths.TRAIN_YAML).read_text()))

    def get_path(self, dotted: str, default: Any = None) -> Any:
        node: Any = self
        for key in dotted.split("."):
            if not isinstance(node, dict) or key not in node:
                return default
            node = node[key]
        return node


@lru_cache(maxsize=1)
def preprocess() -> PreprocessConfig:
    return PreprocessConfig.load()


@lru_cache(maxsize=1)
def labels() -> LabelMap:
    return LabelMap.load()


@lru_cache(maxsize=1)
def train_cfg() -> TrainConfig:
    return TrainConfig.load()
