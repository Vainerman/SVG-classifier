#!/usr/bin/env python3
"""Canonicalize raw concept keys -> screen-reader accessibility labels via a local
ollama model (default gemma4:e2b — picked on the pilot for quality==e4b at ~3x speed).

Maps each distinct concept_key (from data/relabel/inventory.jsonl) to a canonical
snake_case label, MERGING synonyms (magnifying-glass/find -> search; person/profile
-> user; gear/cog -> settings; envelope -> mail; ...). This collapses the ~13.7k
granular keys toward a much smaller label vocabulary; the trainable class set is then
chosen by a support floor at labels.json-build time (see build_labels.py).

    python data/relabel/relabel.py [--model gemma4:e2b] [--min-svgs 1] [--batch 60]

Incremental + resumable: appends one JSON line per concept to
data/relabel/concept_labels.jsonl and skips keys already present on restart.
"""
from __future__ import annotations
import argparse, json, re, sys, time, urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent.parent
INV = LAB / "data" / "relabel" / "inventory.jsonl"
OUT = LAB / "data" / "relabel" / "concept_labels.jsonl"
OLLAMA = "http://localhost:11434/api/chat"

# Anchor vocabulary: ubiquitous UI actions. Biasing every batch toward these keeps
# labels consistent across batches (so batch A and batch B both emit `search`, not
# `search` vs `find`). Not exhaustive — the model adds concepts beyond these.
ANCHORS = [
    "home", "search", "user", "settings", "menu", "close", "mail", "trash", "edit",
    "download", "upload", "share", "heart", "star", "bookmark", "notification", "calendar",
    "clock", "lock", "filter", "add", "remove", "check", "info", "warning", "help",
    "arrow_left", "arrow_right", "arrow_up", "arrow_down", "chevron_right", "play", "pause",
    "camera", "image", "video", "file", "folder", "link", "phone", "location", "cart",
    "credit_card", "print", "refresh", "more", "grid", "list", "eye", "send", "log_out",
]

SYS = (
    "You label UI icons for a screen-reader accessibility tool. For each icon concept "
    "name (already stripped of style suffixes like -fill/-bold/-24), output a CANONICAL "
    "accessibility label: the short lowercase snake_case term a screen reader should "
    "announce for the icon's MEANING/FUNCTION.\n"
    "RULES:\n"
    "- MERGE synonyms to ONE shared label (magnifying-glass/magnifier/find -> search; "
    "person/profile/avatar/account -> user; bin/garbage/trash-can -> trash; envelope -> "
    "mail; gear/cog/cog-6-tooth -> settings; cross/x/dismiss -> close; pencil -> edit).\n"
    "- Keep genuinely different icons distinct (zoom_in != search; inbox != mail; "
    "bookmark != heart; sliders != settings).\n"
    "- Strip trailing numbers: trash-2 -> trash. Use snake_case, no spaces, no suffixes.\n"
    "- Prefer reusing one of these common labels when it fits: " + ", ".join(ANCHORS) + ".\n"
    '- Output ONLY JSON: {"results":[{"key":"<exact input>","label":"<canonical>"}]} '
    "with one entry for EVERY input key, in order."
)

_WS = re.compile(r"[\s\-./]+")
def snake(s: str) -> str:
    s = _WS.sub("_", s.strip().lower())
    s = re.sub(r"_+", "_", s).strip("_")
    return s

def call(model: str, keys: list[str], timeout: int = 180) -> dict[str, str] | None:
    body = {"model": model,
            "messages": [{"role": "system", "content": SYS},
                         {"role": "user", "content": "KEYS:\n" + "\n".join(keys)}],
            "format": "json", "stream": False,
            "options": {"temperature": 0, "num_ctx": 8192}}
    req = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
        res = json.loads(out["message"]["content"])["results"]
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] call failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return None
    return {d["key"]: d.get("label", "") for d in res if isinstance(d, dict) and "key" in d}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gemma4:e2b")
    ap.add_argument("--min-svgs", type=int, default=1, help="only relabel concepts with >= this many svgs")
    ap.add_argument("--batch", type=int, default=60)
    args = ap.parse_args()

    rows = [json.loads(l) for l in INV.open()]
    rows = [r for r in rows if r["n_svgs"] >= args.min_svgs]
    done: dict[str, str] = {}
    if OUT.exists():
        for l in OUT.open():
            d = json.loads(l); done[d["key"]] = d["label"]
    todo = [r for r in rows if r["key"] not in done]
    print(f"[relabel] model={args.model} concepts={len(rows)} done={len(done)} todo={len(todo)} "
          f"batch={args.batch}", flush=True)

    t0 = time.time()
    with OUT.open("a") as fh:
        for bi in range(0, len(todo), args.batch):
            chunk = todo[bi:bi + args.batch]
            keys = [r["key"] for r in chunk]
            mp = call(args.model, keys) or {}
            if not mp:  # one retry
                mp = call(args.model, keys) or {}
            for r in chunk:
                raw = mp.get(r["key"], "")
                label = snake(raw) or snake(r["key"])  # fallback: the key itself
                fh.write(json.dumps({"key": r["key"], "label": label}) + "\n")
            fh.flush()
            n = bi + len(chunk)
            if (bi // args.batch) % 5 == 0 or n >= len(todo):
                el = time.time() - t0
                rate = el / n if n else 0
                eta = rate * (len(todo) - n) / 60
                print(f"[relabel] {len(done)+n}/{len(rows)}  ({el:.0f}s, ETA {eta:.0f}min)", flush=True)
    print(f"[relabel] DONE in {(time.time()-t0)/60:.1f}min -> {OUT.relative_to(LAB)}", flush=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
