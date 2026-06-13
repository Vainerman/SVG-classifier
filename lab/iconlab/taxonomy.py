"""Canonical concept mapping (plan §5.4).

Different libraries name the same glyph differently and tack on variant suffixes
(`-fill`, `-outline`, `-2`, `-24`, `duotone`...). This module derives a
source-name -> canonical-label map from labels.json's `synonyms` lists and
normalizes raw icon names so `house-door`, `HouseDoor`, `home_2` all resolve to
`home`. Concepts in train.yaml's `unknown_pool_concepts` resolve to the special
`unknown` role (out-of-taxonomy negatives for OOD eval); everything else unmapped
is dropped.
"""
from __future__ import annotations

import re

from .config import LabelMap, labels as _labels

# variant/style tokens that don't change the concept — stripped when matching
_VARIANT_TOKENS = {
    "fill", "filled", "outline", "outlined", "solid", "regular", "duotone",
    "duo", "light", "bold", "thin", "line", "linear", "twotone", "two-tone",
    "sharp", "rounded", "round", "stroke", "16", "20", "24", "32", "48",
}
_SEP_RE = re.compile(r"[\s_./]+")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def normalize_name(raw: str) -> str:
    """Lowercase, split camelCase, unify separators to '-', collapse repeats."""
    s = _CAMEL_RE.sub("-", raw)
    s = _SEP_RE.sub("-", s)
    s = re.sub(r"-+", "-", s).strip("-").lower()
    return s


def strip_variants(name: str) -> str:
    """Drop trailing variant/style/size tokens: 'home-2-fill' -> 'home'."""
    parts = [p for p in name.split("-") if p]
    while len(parts) > 1 and (parts[-1] in _VARIANT_TOKENS or parts[-1].isdigit()):
        parts.pop()
    return "-".join(parts)


def _name_to_canonical(label_map: LabelMap | None = None) -> dict[str, str]:
    # Memoize the reverse table ON the LabelMap instance. LabelMap is unhashable (it
    # has a dict field) so it can't be an lru_cache key; caching on the instance ties
    # the table's lifetime to it — correct invalidation, no id()-reuse staleness.
    lm = label_map or _labels()
    cached = getattr(lm, "_canon_table", None)
    if cached is not None:
        return cached
    table: dict[str, str] = {}
    for canonical in lm.names:
        table[normalize_name(canonical)] = canonical
        for syn in lm.synonyms.get(canonical, []):
            table[normalize_name(syn)] = canonical
    object.__setattr__(lm, "_canon_table", table)  # frozen dataclass -> bypass
    return table


def canonical_for(raw_name: str, label_map: LabelMap | None = None) -> str | None:
    """Canonical label for a source icon name, or None if out-of-taxonomy."""
    table = _name_to_canonical(label_map)
    norm = normalize_name(raw_name)
    if norm in table:
        return table[norm]
    base = strip_variants(norm)
    return table.get(base)


def concept_of(raw_name: str) -> str:
    """The variant-stripped concept key (for matching against unknown_pool_concepts)."""
    return strip_variants(normalize_name(raw_name))
