#!/usr/bin/env python3
"""Self-contained provenance index for the collected SVG library data.

Standalone on purpose: it has NO dependency on the iconlab training package, so
the dataset documents itself regardless of the rest of the lab. The lab's own
training manifest + splits are built separately by scripts/build_dataset.py.

Walks lab/data/raw/<library>/**/*.svg and writes (to lab/data/):
  provenance.jsonl  one row per SVG: library, name, variant, style, license, source
  provenance.csv    same, flat
  concepts.tsv      concept_key -> count / #libraries / libraries  (taxonomy seed)
  summary.json      dataset stats

The filename is the label. concept_key is a slugified grouping hint to seed the
canonical taxonomy (plan §5.4) — not the final label map.
"""
import csv
import json
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "lab", "data")
RAW = os.path.join(DATA, "raw")

META = {
    "lucide":           ("ISC",        "https://github.com/lucide-icons/lucide"),
    "tabler":           ("MIT",        "https://github.com/tabler/tabler-icons"),
    "heroicons":        ("MIT",        "https://github.com/tailwindlabs/heroicons"),
    "bootstrap":        ("MIT",        "https://github.com/twbs/icons"),
    "feather":          ("MIT",        "https://github.com/feathericons/feather"),
    "phosphor":         ("MIT",        "https://github.com/phosphor-icons/core"),
    "remix":            ("Apache-2.0", "https://github.com/Remix-Design/RemixIcon"),
    "iconoir":          ("MIT",        "https://github.com/iconoir-icons/iconoir"),
    "material-symbols": ("Apache-2.0", "https://github.com/marella/material-symbols"),
}
PHOSPHOR_WEIGHTS = {"regular", "bold", "duotone", "fill", "light", "thin"}


def slug(name: str) -> str:
    s = re.sub(r"[\s_]+", "-", name.lower().strip())
    s = re.sub(r"[^a-z0-9\-]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def parse(library: str, parts: list[str]):
    stem = parts[-1][:-4]
    d = {"raw_name": stem, "category": None, "corner_style": None, "size": None}
    if library in ("lucide", "feather"):
        d.update(name=stem, style="outline", variant="outline")
    elif library == "tabler":
        v = parts[1] if len(parts) >= 3 else "outline"
        d.update(name=stem, style=("filled" if v == "filled" else "outline"), variant=v)
    elif library == "heroicons":
        size, v = parts[0], parts[1]
        d.update(name=stem, style=("filled" if v == "solid" else "outline"), variant=v, size=size)
    elif library == "iconoir":
        v = parts[1] if len(parts) >= 3 else "regular"
        d.update(name=stem, style=("filled" if v == "solid" else "outline"), variant=v)
    elif library == "bootstrap":
        fill = stem.endswith("-fill")
        d.update(name=(stem[:-5] if fill else stem),
                 style=("filled" if fill else "outline"), variant=("fill" if fill else "outline"))
    elif library == "remix":
        cat = parts[1] if len(parts) >= 3 else None
        if stem.endswith("-fill"):
            name, v, style = stem[:-5], "fill", "filled"
        elif stem.endswith("-line"):
            name, v, style = stem[:-5], "line", "outline"
        else:
            name, v, style = stem, "other", "outline"
        d.update(name=name, style=style, variant=v, category=cat)
    elif library == "phosphor":
        w = parts[1] if len(parts) >= 3 else "regular"
        name = stem
        if w != "regular" and name.endswith("-" + w):
            name = name[: -(len(w) + 1)]
        d.update(name=name, variant=w,
                 style={"fill": "filled", "duotone": "duotone"}.get(w, "outline"))
    elif library == "material-symbols":
        fill = stem.endswith("-fill")
        d.update(name=(stem[:-5] if fill else stem),
                 style=("filled" if fill else "outline"),
                 variant=("fill" if fill else "outlined"), corner_style=parts[0])
    else:
        d.update(name=stem, style="unknown", variant="unknown")
    d["concept_key"] = slug(d["name"])
    return d


def main():
    rows = []
    for library in sorted(os.listdir(RAW)):
        libdir = os.path.join(RAW, library)
        if not os.path.isdir(libdir):
            continue
        license_id, url = META.get(library, ("UNKNOWN", ""))
        for dirpath, _, files in os.walk(libdir):
            for fn in files:
                if not fn.endswith(".svg"):
                    continue
                full = os.path.join(dirpath, fn)
                p = parse(library, os.path.relpath(full, libdir).split(os.sep))
                rows.append({
                    "path": os.path.relpath(full, DATA),
                    "library": library, "name": p["name"], "concept_key": p["concept_key"],
                    "raw_name": p["raw_name"], "style": p["style"], "variant": p["variant"],
                    "corner_style": p["corner_style"], "size": p["size"], "category": p["category"],
                    "license": license_id, "source_url": url,
                })
    rows.sort(key=lambda r: (r["concept_key"], r["library"], r["path"]))

    with open(os.path.join(DATA, "provenance.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    cols = ["path", "library", "name", "concept_key", "raw_name", "style",
            "variant", "corner_style", "size", "category", "license", "source_url"]
    with open(os.path.join(DATA, "provenance.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)

    by_concept = defaultdict(list)
    for r in rows:
        by_concept[r["concept_key"]].append(r["library"])
    concepts = sorted(
        ((k, len(v), len(set(v)), ",".join(sorted(set(v)))) for k, v in by_concept.items()),
        key=lambda c: (-c[2], -c[1], c[0]))
    with open(os.path.join(DATA, "concepts.tsv"), "w") as f:
        f.write("concept_key\ttotal_svgs\tnum_libraries\tlibraries\n")
        for c in concepts:
            f.write(f"{c[0]}\t{c[1]}\t{c[2]}\t{c[3]}\n")

    summary = {
        "total_svgs": len(rows),
        "unique_concept_keys": len(by_concept),
        "concepts_in_2plus_libraries": sum(1 for c in concepts if c[2] >= 2),
        "concepts_in_5plus_libraries": sum(1 for c in concepts if c[2] >= 5),
        "per_library": dict(sorted(Counter(r["library"] for r in rows).items())),
        "per_style": dict(sorted(Counter(r["style"] for r in rows).items())),
        "per_license": dict(sorted(Counter(r["license"] for r in rows).items())),
    }
    with open(os.path.join(DATA, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
