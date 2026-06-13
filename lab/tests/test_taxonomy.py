"""Name normalization + canonical mapping."""
from iconlab import taxonomy as tx
from iconlab.config import labels


def test_normalize_name():
    assert tx.normalize_name("HouseDoor") == "house-door"
    assert tx.normalize_name("arrow_uturn.left") == "arrow-uturn-left"
    assert tx.normalize_name("  Home 2 ") == "home-2"


def test_strip_variants():
    assert tx.strip_variants("home-2-fill") == "home"
    assert tx.strip_variants("trash-outline") == "trash"
    assert tx.strip_variants("arrow-right") == "arrow-right"


def test_canonical_for_known_and_synonyms():
    lm = labels()
    assert tx.canonical_for("home") == "home"
    assert tx.canonical_for("house") == "home"
    assert tx.canonical_for("house-door") == "home"
    assert tx.canonical_for("magnifying-glass") == "search"
    # a concept not in the taxonomy resolves to None
    assert tx.canonical_for("blockchain") is None
    # every label maps to itself
    for name in lm.names:
        assert tx.canonical_for(name) == name
