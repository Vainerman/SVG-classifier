#!/usr/bin/env python3
"""Build the concept inventory the relabeler consumes: one row per distinct
concept_key with the signal an LLM needs to assign a canonical accessibility
label — frequency, libraries it appears in, and example source (raw) names.

    python data/relabel/build_inventory.py
    -> data/relabel/inventory.jsonl   (sorted by frequency desc)
"""
from __future__ import annotations
import json, sys
from collections import defaultdict
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent.parent
PROV = LAB / "data" / "provenance.jsonl"
OUT = LAB / "data" / "relabel" / "inventory.jsonl"

def main() -> int:
    freq: dict[str, int] = defaultdict(int)
    libs: dict[str, set] = defaultdict(set)
    raws: dict[str, set] = defaultdict(set)
    with PROV.open() as f:
        for line in f:
            r = json.loads(line)
            k = r["concept_key"]
            freq[k] += 1
            libs[k].add(r["library"])
            raws[k].add(r["raw_name"])
    rows = []
    for k in freq:
        rows.append({
            "key": k,
            "n_svgs": freq[k],
            "n_libs": len(libs[k]),
            "libs": sorted(libs[k]),
            "samples": sorted(raws[k])[:4],
        })
    rows.sort(key=lambda r: (-r["n_svgs"], r["key"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"wrote {len(rows)} concepts -> {OUT.relative_to(LAB)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
