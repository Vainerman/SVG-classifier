#!/usr/bin/env python3
"""Split inventory.jsonl into small per-batch text files the relabel workflow's
Haiku agents read. Each line: `key<TAB>hint` where hint lists up to 2 sample raw
names that differ from the key (disambiguation for keys like `cog-6-tooth`).

    python data/relabel/split_batches.py [--batch-size 120]
    -> data/relabel/batches/batch_000.txt ...  and  batches/index.json
"""
from __future__ import annotations
import argparse, json, shutil
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent.parent
INV = LAB / "data" / "relabel" / "inventory.jsonl"
OUTDIR = LAB / "data" / "relabel" / "batches"

def hint_for(row: dict) -> str:
    extras = [s for s in row.get("samples", []) if s != row["key"]][:2]
    return ", ".join(extras)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=120)
    args = ap.parse_args()
    rows = [json.loads(l) for l in INV.open()]
    if OUTDIR.exists():
        shutil.rmtree(OUTDIR)
    OUTDIR.mkdir(parents=True)
    batches = []
    bs = args.batch_size
    for bi in range((len(rows) + bs - 1) // bs):
        chunk = rows[bi*bs:(bi+1)*bs]
        name = f"batch_{bi:03d}.txt"
        path = OUTDIR / name
        with path.open("w") as f:
            for r in chunk:
                f.write(f"{r['key']}\t{hint_for(r)}\n")
        batches.append({"file": str(path), "n": len(chunk),
                        "keys": [r["key"] for r in chunk]})
    index = {"batch_size": bs, "n_concepts": len(rows), "n_batches": len(batches),
             "batches": batches}
    (OUTDIR / "index.json").write_text(json.dumps(index))
    print(f"{len(rows)} concepts -> {len(batches)} batches of <= {bs} in {OUTDIR.relative_to(LAB)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
