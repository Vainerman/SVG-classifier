"""Split routing (no rendering / torch needed)."""
from iconlab.config import labels, train_cfg
from iconlab.dataset import assign_splits
from iconlab.manifest import Record


def _rec(library, name, label, role, ood=False):
    return Record(
        rel_path=f"data/mock/{library}/icons/{name}.svg",
        library=library, variant="default", original_name=name,
        concept=name, label=label, role=role, is_ood_library=ood,
    )


def test_assign_splits_routes_ood_and_unknown():
    lm = labels()
    tc = train_cfg()
    recs = []
    # in-distribution: 5 source icons per class across two libs
    for cls in lm.names[:3]:
        for i in range(5):
            recs.append(_rec(f"lib{i%2}", f"{cls}-{i}", cls, "label", ood=False))
    # ood library
    recs.append(_rec("phosphor", "home-x", "home", "label", ood=True))
    # unknown pool
    recs.append(_rec("lib0", "star", lm.unknown_label, "unknown"))

    splits = assign_splits(recs, lm, tc)
    assert len(splits["test_ood"]) == 1
    assert len(splits["unknown"]) == 1
    # every in-distribution class has at least one train icon
    train_labels = {r.label for r in splits["train"]}
    for cls in lm.names[:3]:
        assert cls in train_labels
    # no leakage: a source icon lands in exactly one split
    seen = [r.rel_path for s in ("train", "val", "test_id") for r in splits[s]]
    assert len(seen) == len(set(seen))
