"""Build a manifest of source SVGs from a raw icon tree.

Raw layout (produced by scripts/fetch_icons.sh for real data, and by
scripts/make_mock_data.py for mock data):

    <raw_root>/<library>/<variant-subpath...>/<name>.svg

Each row records provenance (library, variant, original name) plus the resolved
canonical label and a *role*:
  - ``label``   : in-taxonomy, used for train/val/test (split decided later)
  - ``unknown`` : concept in train.yaml unknown_pool -> OOD/abstention negatives
  - ``drop``    : out-of-taxonomy and not a chosen negative -> unused
OOD-library membership is flagged here; the actual split assignment is in dataset.py.
"""
from __future__ import annotations

import csv
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from . import paths
from .config import LabelMap, TrainConfig
from .taxonomy import canonical_for, concept_of


@dataclass
class Record:
    rel_path: str          # path to the .svg, relative to lab root
    library: str
    variant: str
    original_name: str
    concept: str           # variant-stripped normalized name
    label: str             # canonical label, or "unknown", or "" for drop
    role: str              # "label" | "unknown" | "drop"
    is_ood_library: bool

    @property
    def abs_path(self) -> Path:
        return paths.resolve(self.rel_path)


def parse_path(svg_path: Path, raw_root: Path) -> tuple[str, str, str]:
    rel = svg_path.relative_to(raw_root)
    parts = rel.parts
    library = parts[0]
    original_name = svg_path.stem
    variant = "/".join(parts[1:-1]) if len(parts) > 2 else "default"
    return library, variant, original_name


def build_manifest(
    raw_root: Path,
    label_map: LabelMap,
    train_cfg: TrainConfig,
) -> list[Record]:
    ood_libs = set(train_cfg.get_path("data.ood_libraries", []) or [])
    unknown_concepts = {concept_of(c) for c in (train_cfg.get_path("data.unknown_pool_concepts", []) or [])}

    records: list[Record] = []
    for svg_path in sorted(raw_root.rglob("*.svg")):
        library, variant, original_name = parse_path(svg_path, raw_root)
        concept = concept_of(original_name)
        canonical = canonical_for(original_name, label_map)

        if canonical is not None:
            role, label = "label", canonical
        elif concept in unknown_concepts:
            role, label = "unknown", label_map.unknown_label
        else:
            role, label = "drop", ""

        records.append(
            Record(
                rel_path=str(svg_path.resolve().relative_to(paths.LAB_ROOT)),
                library=library,
                variant=variant,
                original_name=original_name,
                concept=concept,
                label=label,
                role=role,
                is_ood_library=library in ood_libs,
            )
        )
    return records


def write_csv(records: list[Record], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = [f.name for f in fields(Record)]
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in records:
            w.writerow(asdict(r))


def read_csv(path: Path) -> list[Record]:
    with path.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    out = []
    for row in rows:
        row["is_ood_library"] = row["is_ood_library"] in ("True", "true", "1")
        out.append(Record(**row))
    return out


def summarize(records: list[Record]) -> dict[str, object]:
    by_role: dict[str, int] = {}
    by_label: dict[str, int] = {}
    libs: set[str] = set()
    for r in records:
        by_role[r.role] = by_role.get(r.role, 0) + 1
        libs.add(r.library)
        if r.role == "label":
            by_label[r.label] = by_label.get(r.label, 0) + 1
    return {
        "total": len(records),
        "by_role": by_role,
        "libraries": sorted(libs),
        "labeled_per_class": dict(sorted(by_label.items())),
    }
