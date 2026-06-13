"""The fixed deploy transform: shapes, dtypes, polarity normalization."""
import numpy as np
from PIL import Image

from iconlab import preprocess as pp
from iconlab.config import preprocess as pcfg


def _img(border_rgb, center_rgb, size=32):
    a = np.zeros((size, size, 4), dtype=np.uint8)
    a[..., :3] = border_rgb
    a[..., 3] = 255
    m = size // 4
    a[m:-m, m:-m, :3] = center_rgb
    return Image.fromarray(a, "RGBA")


def test_to_luminance_shape_and_dtype():
    cfg = pcfg()
    g = pp.to_luminance_u8(_img((255, 255, 255), (0, 0, 0)), cfg)
    assert g.shape == (cfg.input_size, cfg.input_size)
    assert g.dtype == np.uint8


def test_polarity_makes_border_light():
    cfg = pcfg()
    # dark border (background), light center (glyph) -> auto_polarity should invert
    g = pp.to_luminance_u8(_img((0, 0, 0), (255, 255, 255)), cfg)
    ring = np.concatenate([g[0, :], g[-1, :], g[:, 0], g[:, -1]])
    assert ring.mean() > 127, "border (background) should be normalized to the light side"


def test_normalize_shapes():
    cfg = pcfg()
    g = pp.to_luminance_u8(_img((255, 255, 255), (0, 0, 0)), cfg)
    t = pp.normalize(g, cfg)
    assert t.shape == (cfg.channels, cfg.input_size, cfg.input_size)
    assert t.dtype == np.float32
    batch = pp.normalize_batch(np.stack([g, g]), cfg)
    assert batch.shape == (2, cfg.channels, cfg.input_size, cfg.input_size)
    # normalize_batch == per-image normalize
    assert np.allclose(batch[0], t)
