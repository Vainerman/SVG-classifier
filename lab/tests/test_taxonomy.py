"""Name normalization + canonical mapping."""
from iconlab import taxonomy as tx
from iconlab.config import LabelMap, labels


def _fixture_lm() -> LabelMap:
    # synthetic taxonomy so the test is stable regardless of the generated labels.json
    return LabelMap(
        version=1,
        names=("home", "search"),
        displays=("home", "search"),
        synonyms={"home": ["house", "house-door", "home-2"],
                  "search": ["magnifying-glass", "find"]},
        unknown_label="unknown",
        unknown_is_explicit_class=False,
        default_threshold=0.5,
    )


def test_normalize_name():
    assert tx.normalize_name("HouseDoor") == "house-door"
    assert tx.normalize_name("arrow_uturn.left") == "arrow-uturn-left"
    assert tx.normalize_name("  Home 2 ") == "home-2"


def test_strip_variants():
    assert tx.strip_variants("home-2-fill") == "home"
    assert tx.strip_variants("trash-outline") == "trash"
    assert tx.strip_variants("arrow-right") == "arrow-right"


def test_canonical_for_known_and_synonyms():
    lm = _fixture_lm()
    assert tx.canonical_for("home", lm) == "home"
    assert tx.canonical_for("house", lm) == "home"
    assert tx.canonical_for("house-door", lm) == "home"
    assert tx.canonical_for("HouseDoor", lm) == "home"        # normalization
    assert tx.canonical_for("home-2-fill", lm) == "home"      # strip-variants fallback
    assert tx.canonical_for("magnifying-glass", lm) == "search"
    # a concept not in the taxonomy resolves to None
    assert tx.canonical_for("blockchain", lm) is None
    # every label maps to itself
    for name in lm.names:
        assert tx.canonical_for(name, lm) == name


def test_canonical_for_uses_live_labels():
    # the generated taxonomy loads and every class maps to itself
    lm = labels()
    for name in lm.names[:20]:
        assert tx.canonical_for(name, lm) == name
