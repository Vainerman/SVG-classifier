#!/usr/bin/env python3
"""Prepare the gemma relabel output for a Sonnet membership audit.

Builds candidate classes (per-member SVG floor kills the exotic 1-2x garbage;
a generous label floor keeps a large pool), then chunks them into review files
each Sonnet subagent processes. Each subagent decides, per member concept_key,
whether it genuinely depicts that class's concept (keep) or is a contaminant /
distinct compound (evict, with an optional better-label suggestion from the vocab).

    python data/relabel/prep_review.py [--min-key-svgs 3] [--label-min-svgs 15]
                                       [--label-min-libs 2] [--members-per-chunk 300]
    -> data/relabel/review/chunk_XXX.json  + index.json
"""
from __future__ import annotations
import argparse, json, shutil
from collections import defaultdict
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent.parent
INV = LAB / "data" / "relabel" / "inventory.jsonl"
LABELS = LAB / "data" / "relabel" / "concept_labels.jsonl"
REVIEW = LAB / "data" / "relabel" / "review"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-key-svgs", type=int, default=3)
    ap.add_argument("--label-min-svgs", type=int, default=15)
    ap.add_argument("--label-min-libs", type=int, default=2)
    ap.add_argument("--members-per-chunk", type=int, default=300)
    args = ap.parse_args()

    inv = {json.loads(l)["key"]: json.loads(l) for l in INV.open()}
    lab = {json.loads(l)["key"]: json.loads(l)["label"] for l in LABELS.open()}

    groups: dict[str, dict] = defaultdict(lambda: {"members": [], "n": 0, "libs": set()})
    for key, label in lab.items():
        r = inv.get(key)
        if not r or r["n_svgs"] < args.min_key_svgs:
            continue
        g = groups[label]
        g["members"].append({"key": key, "n_svgs": r["n_svgs"],
                             "samples": [s for s in r["samples"] if s != key][:3]})
        g["n"] += r["n_svgs"]
        g["libs"].add(tuple(r["libs"]))  # placeholder; recompute libs below

    # recompute libs as union
    libset: dict[str, set] = defaultdict(set)
    for key, label in lab.items():
        r = inv.get(key)
        if r and r["n_svgs"] >= args.min_key_svgs:
            libset[label].update(r["libs"])

    cands = []
    for label, g in groups.items():
        nlibs = len(libset[label])
        if g["n"] >= args.label_min_svgs and nlibs >= args.label_min_libs:
            g["members"].sort(key=lambda m: -m["n_svgs"])
            cands.append({"label": label, "n_svgs": g["n"], "n_libs": nlibs,
                          "members": g["members"]})
    cands.sort(key=lambda c: -c["n_svgs"])
    vocab = sorted(c["label"] for c in cands)
    total_members = sum(len(c["members"]) for c in cands)

    if REVIEW.exists():
        shutil.rmtree(REVIEW)
    REVIEW.mkdir(parents=True)

    # chunk classes so each chunk has ~members_per_chunk members (whole classes intact)
    chunks: list[list] = [[]]
    cur = 0
    for c in cands:
        if cur and cur + len(c["members"]) > args.members_per_chunk:
            chunks.append([]); cur = 0
        chunks[-1].append(c); cur += len(c["members"])
    for i, ch in enumerate(chunks):
        (REVIEW / f"chunk_{i:03d}.json").write_text(json.dumps(
            {"vocab": vocab, "classes": ch}, indent=2))
    (REVIEW / "index.json").write_text(json.dumps(
        {"n_candidate_labels": len(cands), "total_members": total_members,
         "n_chunks": len(chunks), "vocab": vocab,
         "floor": {"min_key_svgs": args.min_key_svgs, "label_min_svgs": args.label_min_svgs,
                   "label_min_libs": args.label_min_libs}}, indent=2))
    print(f"candidate labels: {len(cands)}  (floor: member>={args.min_key_svgs}svgs, "
          f"label>={args.label_min_svgs}svgs/>={args.label_min_libs}libs)")
    print(f"total members to review: {total_members}")
    print(f"chunks: {len(chunks)} (~{args.members_per_chunk} members each) -> {REVIEW.relative_to(LAB)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
