"""The FIXED, deployment-matching preprocessing transform (plan §5.5).

This is the byte-for-byte contract with the extension. Whatever happens here must
happen identically in src/shared/config.ts + the OffscreenCanvas path, or
deployment accuracy collapses. Augmentation (augment.py) is *train-only* and runs
BEFORE this; this function is deterministic and color-collapsing.

Two stages, split only so the lab can cache the cheap 8-bit middle in npz:
  1. ``to_luminance_u8``  RGBA raster -> single-channel uint8 at input_size
                          (composite over bg -> luminance -> polarity -> resize)
  2. ``normalize``        uint8 grayscale -> float32 CHW tensor for the model
``to_tensor`` is the full pipeline (what the extension computes in one shot).
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .config import PreprocessConfig, preprocess as _preprocess_cfg

_RESIZE = {
    "nearest": Image.NEAREST,
    "bilinear": Image.BILINEAR,
    "bicubic": Image.BICUBIC,
    "lanczos": Image.LANCZOS,
}


def to_luminance_u8(img: Image.Image, cfg: PreprocessConfig | None = None) -> np.ndarray:
    """RGBA/RGB/L image -> (input_size, input_size) uint8 grayscale.

    Composite over the configured background, collapse to weighted luminance,
    optionally normalize polarity to dark-glyph-on-light, then resize to the
    model input size.
    """
    cfg = cfg or _preprocess_cfg()

    if img.mode != "RGBA":
        img = img.convert("RGBA")

    # 1. composite over fixed background
    bg = Image.new("RGBA", img.size, (*cfg.background, 255))
    flat = Image.alpha_composite(bg, img).convert("RGB")

    # 2. weighted luminance (honour config weights exactly; don't rely on PIL "L")
    arr = np.asarray(flat, dtype=np.float32)
    w = np.asarray(cfg.luminance_weights, dtype=np.float32)
    lum = arr @ w  # (H, W)

    # 3. polarity: make the background (border ring) the light side
    if cfg.auto_polarity:
        ring = _border_mean(lum) if cfg.polarity_reference == "border" else lum.mean()
        if ring < 127.5:
            lum = 255.0 - lum

    lum_u8 = np.clip(lum, 0, 255).astype(np.uint8)

    # 4. resize to input size
    gray = Image.fromarray(lum_u8, mode="L")
    if gray.size != (cfg.input_size, cfg.input_size):
        resample = _RESIZE[cfg.resize_method]
        gray = gray.resize((cfg.input_size, cfg.input_size), resample)
    return np.asarray(gray, dtype=np.uint8)


def _border_mean(lum: np.ndarray) -> float:
    h, w = lum.shape
    if h < 2 or w < 2:
        return float(lum.mean())
    ring = np.concatenate([lum[0, :], lum[-1, :], lum[:, 0], lum[:, -1]])
    return float(ring.mean())


def normalize(gray_u8: np.ndarray, cfg: PreprocessConfig | None = None) -> np.ndarray:
    """(H, W) uint8 grayscale -> float32 (C, H, W) normalized tensor.

    Scale to [0,1], replicate luminance to ``channels``, apply per-channel
    mean/std. Returns CHW (no batch dim).
    """
    cfg = cfg or _preprocess_cfg()
    x = gray_u8.astype(np.float32) / 255.0           # (H, W) in [0,1]
    x = np.repeat(x[None, ...], cfg.channels, axis=0)  # (C, H, W)
    mean = np.asarray(cfg.norm_mean, dtype=np.float32)[:, None, None]
    std = np.asarray(cfg.norm_std, dtype=np.float32)[:, None, None]
    x = (x - mean) / std
    return np.ascontiguousarray(x, dtype=np.float32)


def normalize_batch(gray_u8: np.ndarray, cfg: PreprocessConfig | None = None) -> np.ndarray:
    """(N, H, W) uint8 -> float32 (N, C, H, W). Vectorized form of ``normalize``
    for baked-npz training/eval. Numerically identical, per-image."""
    cfg = cfg or _preprocess_cfg()
    x = gray_u8.astype(np.float32) / 255.0                 # (N, H, W)
    x = np.repeat(x[:, None, ...], cfg.channels, axis=1)    # (N, C, H, W)
    mean = np.asarray(cfg.norm_mean, dtype=np.float32)[None, :, None, None]
    std = np.asarray(cfg.norm_std, dtype=np.float32)[None, :, None, None]
    x = (x - mean) / std
    return np.ascontiguousarray(x, dtype=np.float32)


def to_tensor(img: Image.Image, cfg: PreprocessConfig | None = None) -> np.ndarray:
    """Full fixed transform: RGBA raster -> float32 (C, H, W). This is exactly
    what the extension's offscreen document must reproduce."""
    cfg = cfg or _preprocess_cfg()
    return normalize(to_luminance_u8(img, cfg), cfg)
