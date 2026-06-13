#!/usr/bin/env python3
"""Ingest real-website icons harvested by the browser snippet (see README.md).

Reads a JSON array of {svg, name, name_source, page_url} objects (the output of
the in-page extractor) from stdin or a file, writes each unique SVG to
wild/raw/<site>/<slug>-<hash>.svg, and appends rows to wild/manifest.jsonl.

These are WEAK labels (the site's own accessible name / class / filename — the
extension's free-label signals, plan §4.6 step 4). They populate the Test-Wild
set (§5.6) but must be human-reviewed before use as ground truth: set
"reviewed": true / fix "label" in the manifest as you verify them.

Usage:
  python3 ingest_wild.py harvest.json
  pbpaste | python3 ingest_wild.py -          # paste the snippet's JSON output
"""
import hashlib
import json
import os
import re
import sys
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
MANIFEST = os.path.join(HERE, "manifest.jsonl")


def slug(s: str) -> str:
    s = (s or "icon").lower().strip()
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"[^a-z0-9\-]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-") or "icon"


def site_of(url: str) -> str:
    host = urlparse(url or "").netloc or "unknown"
    return slug(host.replace("www.", ""))


def norm_svg(svg: str) -> str:
    """Cheap normalization for dedup: collapse whitespace, drop volatile ids."""
    s = re.sub(r'\s+id="[^"]*"', "", svg)
    return re.sub(r"\s+", " ", s).strip()


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    data = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    items = json.loads(data)

    # existing dedup keys
    seen = set()
    existing = []
    if os.path.exists(MANIFEST):
        for line in open(MANIFEST, encoding="utf-8"):
            line = line.strip()
            if line:
                r = json.loads(line)
                existing.append(r)
                seen.add(r["svg_hash"])

    added = 0
    with open(MANIFEST, "a", encoding="utf-8") as mf:
        for it in items:
            svg = (it.get("svg") or "").strip()
            if not svg:
                continue
            h = hashlib.sha1(norm_svg(svg).encode("utf-8")).hexdigest()[:16]
            if h in seen:
                continue
            seen.add(h)
            site = site_of(it.get("page_url", ""))
            label = slug(it.get("name", ""))
            os.makedirs(os.path.join(RAW, site), exist_ok=True)
            fn = f"{label}-{h[:8]}.svg"
            with open(os.path.join(RAW, site, fn), "w", encoding="utf-8") as f:
                f.write(svg)
            mf.write(json.dumps({
                "path": os.path.relpath(os.path.join(RAW, site, fn), HERE),
                "svg_hash": h,
                "label": label,                       # weak label — review!
                "name_source": it.get("name_source", "unknown"),
                "page_url": it.get("page_url", ""),
                "site": site,
                "reviewed": False,
            }, ensure_ascii=False) + "\n")
            added += 1

    print(f"added {added} new icons; total {len(seen)} unique in wild set")


if __name__ == "__main__":
    main()
