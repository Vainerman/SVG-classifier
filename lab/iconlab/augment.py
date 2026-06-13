"""Train-only augmentation (plan §5.5). NEVER applied at inference.

Goal: make the model robust to the ways the same glyph appears in the wild —
arbitrary fg/bg colours (incl. dark mode), stroke weights, sizes, sub-pixel
placement, blur and noise. Augmentation happens on the SVG string (colour/stroke)
and on the rendered RGBA raster (geometry/photometry); the result is then fed
through the FIXED preprocess transform, which collapses colour to luminance and
normalizes polarity. So augmentation mainly survives as contrast/shape variation —
exactly the signal we want the model to generalize over.
"""
from __future__ import annotations

import re

import numpy as np
from PIL import Image, ImageFilter

from .config import PreprocessConfig
from .preprocess import to_luminance_u8
from .render import Renderer

_CURRENTCOLOR_RE = re.compile("currentColor", re.IGNORECASE)
_STROKEW_RE = re.compile(r'stroke-width\s*=\s*"([0-9.]+)"', re.IGNORECASE)


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _recolor_svg(svg: str, fg: tuple[int, int, int], stroke_scale: float) -> str:
    """Substitute the icon's foreground (currentColor) and scale stroke widths."""
    out = _CURRENTCOLOR_RE.sub(_hex(fg), svg)

    def _mul(m: re.Match) -> str:
        return f'stroke-width="{float(m.group(1)) * stroke_scale:.3f}"'

    return _STROKEW_RE.sub(_mul, out)


def _rand_color(rng: np.random.Generator) -> tuple[int, int, int]:
    return tuple(int(v) for v in rng.integers(0, 256, size=3))


def _pick_background(rng: np.random.Generator, acfg: dict) -> tuple[int, int, int]:
    bg = acfg.get("background", {})
    r = rng.random()
    wp = bg.get("white_prob", 0.5)
    dp = bg.get("dark_prob", 0.25)
    if r < wp:
        v = int(rng.integers(235, 256))
        return (v, v, v)
    if r < wp + dp:
        v = int(rng.integers(0, 30))
        return (v, v, v)
    return _rand_color(rng)


def augment_to_luminance(
    renderer: Renderer,
    svg: str,
    rng: np.random.Generator,
    acfg: dict,
    cfg: PreprocessConfig,
) -> np.ndarray:
    """One augmented training sample: SVG -> uint8 grayscale at input_size."""
    work = cfg.input_size * max(1, cfg.supersample)

    # --- SVG-level: colour + stroke weight ---------------------------------
    fg = _rand_color(rng)
    sw_lo, sw_hi = acfg.get("stroke_width_jitter", [1.0, 1.0])
    svg2 = _recolor_svg(svg, fg, float(rng.uniform(sw_lo, sw_hi)))

    # render at a random source size to vary AA, then operate at `work`
    src = int(rng.integers(16, work + 1))
    glyph = renderer.render(svg2, src, src).resize((work, work), Image.BILINEAR)

    # --- raster-level geometry --------------------------------------------
    pad_lo, pad_hi = acfg.get("padding_frac", [0.0, 0.0])
    pad = float(rng.uniform(pad_lo, pad_hi))
    scale_lo, scale_hi = acfg.get("scale", [1.0, 1.0])
    scale = float(rng.uniform(scale_lo, scale_hi)) * (1.0 - 2.0 * pad)
    g = max(4, int(round(work * scale)))
    glyph = glyph.resize((g, g), Image.BILINEAR)

    angle = float(rng.uniform(-1, 1)) * acfg.get("rotate_deg", 0.0)
    if angle:
        glyph = glyph.rotate(angle, resample=Image.BICUBIC, expand=True)

    canvas = Image.new("RGBA", (work, work), (0, 0, 0, 0))
    tfrac = acfg.get("translate_frac", 0.0)
    max_off_x = work - glyph.width
    max_off_y = work - glyph.height
    cx = (work - glyph.width) // 2
    cy = (work - glyph.height) // 2
    jx = int(rng.uniform(-tfrac, tfrac) * work)
    jy = int(rng.uniform(-tfrac, tfrac) * work)
    ox = int(np.clip(cx + jx, 0, max(0, max_off_x)))
    oy = int(np.clip(cy + jy, 0, max(0, max_off_y)))
    canvas.alpha_composite(glyph, (ox, oy))

    # --- composite over a random background -------------------------------
    bg = Image.new("RGBA", (work, work), (*_pick_background(rng, acfg), 255))
    composed = Image.alpha_composite(bg, canvas)

    # --- photometric: blur + noise ----------------------------------------
    blur = float(rng.uniform(0, acfg.get("blur_max_sigma", 0.0)))
    if blur > 0.01:
        composed = composed.filter(ImageFilter.GaussianBlur(blur))

    noise_std = acfg.get("noise_std", 0.0)
    if noise_std > 0:
        arr = np.asarray(composed.convert("RGB"), dtype=np.float32)
        arr += rng.normal(0, noise_std * 255.0, arr.shape).astype(np.float32)
        composed = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").convert("RGBA")

    # FIXED tail (same as inference): luminance + polarity + resize-to-input
    return to_luminance_u8(composed, cfg)


def render_clean_to_luminance(
    renderer: Renderer, svg: str, cfg: PreprocessConfig
) -> np.ndarray:
    """Un-augmented sample for val/test: render the SVG as-authored, then the
    fixed transform. currentColor resolves to the page default (black)."""
    work = cfg.input_size * max(1, cfg.supersample)
    img = renderer.render(svg, work, work)
    return to_luminance_u8(img, cfg)
