#!/usr/bin/env python3
"""Generate a tiny synthetic icon set so the whole lab pipeline runs end-to-end
before the real dataset is collected.

Writes SVGs in the SAME layout as scripts/fetch_icons.sh:
    data/mock/<library>/icons/<name>.svg

It produces, per concept, distinct geometric glyphs rendered in several library
"styles" so the pipeline exercises real behaviour:
  - 3 in-distribution libraries (mocklucide / mockfeather / mocktabler), outline
    styles with different stroke weights  -> train/val/test_id
  - 1 held-out library (phosphor, a *solid/filled* style)                -> test_ood
  - an unknown pool (star/cloud/bell/lock) present in every library       -> unknown

All glyphs paint with `currentColor` so augment.py can recolor them. These are
deliberately crude — they only need to be mutually distinguishable. Replace
data/mock with your real data/raw tree (via fetch_icons.sh) for real training.

Usage:  python scripts/make_mock_data.py [--out data/mock]
"""
from __future__ import annotations

import argparse
from pathlib import Path

LAB_ROOT = Path(__file__).resolve().parent.parent

# --- primitives ------------------------------------------------------------ #
# Each concept is a list of (kind, attrs, closed). `closed` shapes get filled in
# the solid style; open shapes (line/polyline) always stroke.
P = dict  # alias for readability


def line(x1, y1, x2, y2):
    return ("line", {"x1": x1, "y1": y1, "x2": x2, "y2": y2}, False)


def polyline(pts):
    return ("polyline", {"points": " ".join(f"{x},{y}" for x, y in pts)}, False)


def polygon(pts):
    return ("polygon", {"points": " ".join(f"{x},{y}" for x, y in pts)}, True)


def rect(x, y, w, h, rx=0):
    a = {"x": x, "y": y, "width": w, "height": h}
    if rx:
        a["rx"] = rx
    return ("rect", a, True)


def circle(cx, cy, r):
    return ("circle", {"cx": cx, "cy": cy, "r": r}, True)


def path(d, closed=False):
    return ("path", {"d": d}, closed)


# --- taxonomy concepts (must match labels.json synonyms) ------------------- #
CONCEPTS: dict[str, list] = {
    "home": [polyline([(3, 12), (12, 3), (21, 12)]), rect(6, 12, 12, 9)],
    "search": [circle(11, 11, 6), line(15.5, 15.5, 21, 21)],
    "settings": [circle(12, 12, 3)] + [
        line(12, 12, 12, 3), line(12, 12, 21, 12), line(12, 12, 12, 21),
        line(12, 12, 3, 12), line(12, 12, 19, 5), line(12, 12, 5, 19),
        line(12, 12, 19, 19), line(12, 12, 5, 5),
    ],
    "user": [circle(12, 8, 4), path("M4 21 a8 8 0 0 1 16 0")],
    "heart": [path("M12 21 C3 13 4 5 9 6 C11 6.5 12 8 12 9 C12 8 13 6.5 15 6 C20 5 21 13 12 21 Z", closed=True)],
    "arrow-right": [line(3, 12, 20, 12), polyline([(14, 6), (20, 12), (14, 18)])],
    "close": [line(5, 5, 19, 19), line(19, 5, 5, 19)],
    "menu": [line(4, 7, 20, 7), line(4, 12, 20, 12), line(4, 17, 20, 17)],
    "trash": [line(4, 6, 20, 6), polyline([(9, 6), (9, 4), (15, 4), (15, 6)]), rect(6, 6, 12, 14, 1)],
    "download": [line(12, 3, 12, 15), polyline([(7, 11), (12, 16), (17, 11)]), line(5, 20, 19, 20)],
}

# unknown pool (deliberately excluded from the taxonomy -> negatives)
UNKNOWN_CONCEPTS: dict[str, list] = {
    "star": [polygon([(12, 2), (15, 9), (22, 9), (16.5, 13.5), (18.5, 21),
                      (12, 16.5), (5.5, 21), (7.5, 13.5), (2, 9), (9, 9)])],
    "cloud": [path("M7 18 a5 5 0 0 1 0-10 a6 6 0 0 1 11 2 a4 4 0 0 1 -1 8 Z", closed=True)],
    "bell": [path("M6 16 V11 a6 6 0 0 1 12 0 V16 l2 2 H4 Z", closed=True), line(10, 20, 14, 20)],
    "lock": [rect(5, 11, 14, 9, 1), path("M8 11 V8 a4 4 0 0 1 8 0 V11")],
}

# --- library styles -------------------------------------------------------- #
# (name, fill_closed, stroke_width, linecap)  fill_closed=True -> solid style
LIBRARIES = [
    ("mocklucide", False, 2.0, "round"),
    ("mockfeather", False, 1.5, "round"),
    ("mocktabler", False, 1.75, "butt"),
    ("phosphor", True, 0.0, "round"),   # held-out OOD library: solid/filled look
]


def render_concept(prims: list, fill_closed: bool, sw: float, cap: str) -> str:
    parts = []
    for kind, attrs, closed in prims:
        a = " ".join(f'{k}="{v}"' for k, v in attrs.items())
        if fill_closed and closed:
            paint = 'fill="currentColor" stroke="none"'
        else:
            paint = f'fill="none" stroke="currentColor" stroke-width="{sw}" stroke-linecap="{cap}" stroke-linejoin="{cap}"'
        parts.append(f"  <{kind} {a} {paint}/>")
    body = "\n".join(parts)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        'width="24" height="24" color="#000">\n' + body + "\n</svg>\n"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(LAB_ROOT / "data" / "mock"))
    args = ap.parse_args()
    out = Path(args.out)

    count = 0
    all_concepts = {**CONCEPTS, **UNKNOWN_CONCEPTS}
    for lib, fill_closed, sw, cap in LIBRARIES:
        for name, prims in all_concepts.items():
            svg = render_concept(prims, fill_closed, sw, cap)
            dest = out / lib / "icons" / f"{name}.svg"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(svg)
            count += 1

    print(f"wrote {count} mock SVGs under {out}")
    print(f"  libraries: {[l[0] for l in LIBRARIES]}")
    print(f"  taxonomy concepts: {list(CONCEPTS)}")
    print(f"  unknown pool: {list(UNKNOWN_CONCEPTS)}")


if __name__ == "__main__":
    main()
