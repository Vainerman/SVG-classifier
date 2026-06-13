"""SVG -> raster, with pluggable backends.

Train/serve rendering skew is the #1 project risk (plan §7). The extension
rasterizes via Chromium's Canvas, so the **chromium** backend here renders SVGs
through a real headless Chromium canvas (drawImage onto a 2D context, then read
pixels) to match that anti-aliasing as closely as possible. cairosvg and svglib
are lower-fidelity fallbacks for quick iteration / environments without a browser.

All backends return a Pillow ``Image`` in ``RGBA`` at the requested pixel size,
with a transparent background (compositing over a chosen background colour is the
job of preprocess.py / augment.py, never the renderer).
"""
from __future__ import annotations

import base64
import io
import re
from abc import ABC, abstractmethod

from PIL import Image

# ---- svg dimension normalization ----------------------------------------- #
_SVG_OPEN_RE = re.compile(r"<svg\b[^>]*>", re.IGNORECASE | re.DOTALL)
_WIDTH_RE = re.compile(r'\bwidth\s*=\s*"[^"]*"', re.IGNORECASE)
_HEIGHT_RE = re.compile(r'\bheight\s*=\s*"[^"]*"', re.IGNORECASE)


def normalize_svg_dimensions(svg: str, size: int) -> str:
    """Force the root <svg> to width=height=size px so drawImage scaling is
    deterministic across SVGs that omit explicit dimensions (most icon libs do).
    The viewBox is preserved, so the artwork scales to fill."""
    m = _SVG_OPEN_RE.search(svg)
    if not m:
        return svg
    tag = m.group(0)
    tag = _WIDTH_RE.sub("", tag)
    tag = _HEIGHT_RE.sub("", tag)
    tag = tag[:-1].rstrip() + f' width="{size}" height="{size}">'
    return svg[: m.start()] + tag + svg[m.end():]


class Renderer(ABC):
    name: str = "base"

    @abstractmethod
    def render(self, svg: str, width: int, height: int) -> Image.Image:
        ...

    def close(self) -> None:  # noqa: D401 - optional cleanup hook
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# --------------------------------------------------------------------------- #
# Chromium (Playwright) — deployment-faithful Canvas path
# --------------------------------------------------------------------------- #
_CANVAS_JS = """
async ([svgB64, w, h]) => {
  const svg = atob(svgB64);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  img.width = w; img.height = h;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);              // transparent background
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}
"""


class ChromiumRenderer(Renderer):
    """Renders through a persistent headless Chromium page. This mirrors the
    extension's OffscreenCanvas drawImage path (plan §4.6 step 5)."""

    name = "chromium"

    def __init__(self) -> None:
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(args=["--disable-gpu"])
        self._page = self._browser.new_page()
        self._page.set_content("<!doctype html><html><body></body></html>")

    def render(self, svg: str, width: int, height: int) -> Image.Image:
        svg = normalize_svg_dimensions(svg, max(width, height))
        b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
        data_url: str = self._page.evaluate(_CANVAS_JS, [b64, width, height])
        png = base64.b64decode(data_url.split(",", 1)[1])
        return Image.open(io.BytesIO(png)).convert("RGBA")

    def close(self) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()


# --------------------------------------------------------------------------- #
# cairosvg — good quality, no browser (needs system Cairo)
# --------------------------------------------------------------------------- #
class CairoSvgRenderer(Renderer):
    name = "cairosvg"

    def __init__(self) -> None:
        import cairosvg  # noqa: F401 - probe availability

        self._cairosvg = cairosvg

    def render(self, svg: str, width: int, height: int) -> Image.Image:
        png = self._cairosvg.svg2png(
            bytestring=svg.encode("utf-8"),
            output_width=width,
            output_height=height,
            background_color="transparent",
        )
        return Image.open(io.BytesIO(png)).convert("RGBA")


# --------------------------------------------------------------------------- #
# svglib + reportlab — pure-Python fallback, low fidelity
# --------------------------------------------------------------------------- #
class SvglibRenderer(Renderer):
    name = "svglib"

    def __init__(self) -> None:
        from reportlab.graphics import renderPM  # noqa: F401
        from svglib.svglib import svg2rlg  # noqa: F401

        self._renderPM = renderPM
        self._svg2rlg = svg2rlg

    def render(self, svg: str, width: int, height: int) -> Image.Image:
        drawing = self._svg2rlg(io.BytesIO(svg.encode("utf-8")))
        if drawing is None:
            return Image.new("RGBA", (width, height), (0, 0, 0, 0))
        png = self._renderPM.drawToString(drawing, fmt="PNG", bg=0xFFFFFF)
        img = Image.open(io.BytesIO(png)).convert("RGBA")
        return img.resize((width, height), Image.BILINEAR)


_BACKENDS: dict[str, type[Renderer]] = {
    "chromium": ChromiumRenderer,
    "cairosvg": CairoSvgRenderer,
    "svglib": SvglibRenderer,
}


def available_backends() -> list[str]:
    """Backends whose Python deps import successfully (does not verify a browser
    is installed for chromium — construction does that)."""
    out = []
    probes = {
        "chromium": "playwright.sync_api",
        "cairosvg": "cairosvg",
        "svglib": "svglib.svglib",
    }
    import importlib.util

    for name, mod in probes.items():
        if importlib.util.find_spec(mod.split(".")[0]) is not None:
            out.append(name)
    return out


def get_renderer(backend: str | None = None, fallbacks: list[str] | None = None) -> Renderer:
    """Construct the requested renderer, falling back through ``fallbacks`` (and
    finally any available backend) if it can't be built (missing dep/browser).
    Raises RuntimeError if nothing works."""
    from .config import preprocess

    pp = preprocess()
    order: list[str] = []
    for b in [backend or pp.render_backend, *(fallbacks or list(pp.fallback_backends))]:
        if b and b not in order:
            order.append(b)
    # last resort: anything importable
    for b in available_backends():
        if b not in order:
            order.append(b)

    errors: list[str] = []
    for b in order:
        cls = _BACKENDS.get(b)
        if cls is None:
            errors.append(f"{b}: unknown backend")
            continue
        try:
            return cls()
        except Exception as e:  # noqa: BLE001 - report and try next
            errors.append(f"{b}: {type(e).__name__}: {e}")
    raise RuntimeError(
        "No usable SVG renderer. Tried:\n  " + "\n  ".join(errors)
        + "\nInstall one: `pip install -e \".[render-chromium]\" && playwright install chromium`"
    )
