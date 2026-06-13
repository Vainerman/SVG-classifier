"""The shared config contract loads and is internally consistent."""
from iconlab import config


def test_preprocess_loads():
    pp = config.preprocess()
    assert pp.input_size > 0
    assert pp.channels == 3
    assert len(pp.norm_mean) == 3 and len(pp.norm_std) == 3
    assert pp.render_backend in {"chromium", "cairosvg", "svglib"}


def test_labels_contiguous_and_nonempty():
    lm = config.labels()
    assert lm.num_classes >= 2
    assert list(lm.names) == list(dict.fromkeys(lm.names)), "label names must be unique"
    assert lm.index_of(lm.names[0]) == 0


def test_train_cfg_dotted_access():
    tc = config.train_cfg()
    assert tc.get_path("data.split.train") is not None
    assert tc.get_path("does.not.exist", "default") == "default"
