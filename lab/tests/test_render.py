"""Renderer + preprocess integration. Skips if no backend is constructible."""
import numpy as np
import pytest

from iconlab import preprocess as pp
from iconlab.config import preprocess as pcfg
from iconlab.render import available_backends, get_renderer

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="#000">'
    '<rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"/>'
    "</svg>"
)


@pytest.fixture(scope="module")
def renderer():
    if not available_backends():
        pytest.skip("no SVG render backend installed")
    try:
        r = get_renderer()
    except RuntimeError as e:
        pytest.skip(str(e))
    yield r
    r.close()


def test_render_returns_requested_size(renderer):
    img = renderer.render(SVG, 48, 48)
    assert img.size == (48, 48)
    assert img.mode == "RGBA"


def test_render_then_preprocess(renderer):
    cfg = pcfg()
    img = renderer.render(SVG, cfg.input_size, cfg.input_size)
    g = pp.to_luminance_u8(img, cfg)
    assert g.shape == (cfg.input_size, cfg.input_size)
    # a drawn glyph should produce non-uniform output (not a blank canvas)
    assert g.std() > 1.0
    assert np.unique(g).size > 2
