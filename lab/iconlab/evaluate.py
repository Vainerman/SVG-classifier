"""Evaluation (plan §5.9). Runs the int8 ONNX model under onnxruntime and reports,
per split (and especially the would-be Test-Wild):

  - Top-1 / Top-3 accuracy
  - macro-F1, per-class precision/recall, confusion matrix
  - calibration ECE (matters because the extension thresholds confidence)
  - risk-coverage curve -> threshold τ for target coverages
  - unknown-detection AUROC (max-softmax separating taxonomy vs unknown pool)

Gate release on Test-Wild Top-1 + achievable precision at acceptable coverage,
not on in-distribution accuracy (plan §5.9). On mock data the numbers are
meaningless — this exists to prove the metric plumbing.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .config import LabelMap, PreprocessConfig, TrainConfig
from .dataset import load_split
from .preprocess import normalize_batch


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def run_probs(onnx_path: Path, images_u8: np.ndarray, cfg: PreprocessConfig, batch: int = 128) -> np.ndarray:
    import onnxruntime as ort

    if len(images_u8) == 0:
        return np.zeros((0,))
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    x = normalize_batch(images_u8, cfg)
    outs = []
    for i in range(0, len(x), batch):
        outs.append(sess.run(None, {name: x[i : i + batch]})[0])
    return _softmax(np.concatenate(outs, axis=0))


def _ece(conf: np.ndarray, correct: np.ndarray, bins: int) -> float:
    if len(conf) == 0:
        return float("nan")
    edges = np.linspace(0, 1, bins + 1)
    ece = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.sum() == 0:
            continue
        ece += (m.sum() / len(conf)) * abs(correct[m].mean() - conf[m].mean())
    return float(ece)


def _risk_coverage(conf: np.ndarray, correct: np.ndarray, targets: list[float]) -> list[dict]:
    out = []
    if len(conf) == 0:
        return out
    order = np.argsort(-conf)
    conf_s, corr_s = conf[order], correct[order]
    n = len(conf_s)
    for cov in targets:
        k = max(1, int(round(cov * n)))
        thr = float(conf_s[k - 1])
        acc = float(corr_s[:k].mean())
        out.append({"coverage": cov, "threshold": thr, "accuracy_at_coverage": acc})
    return out


def _classification_metrics(probs: np.ndarray, labels: np.ndarray, num_classes: int) -> dict:
    from sklearn.metrics import confusion_matrix, f1_score, precision_recall_fscore_support

    if len(probs) == 0:
        return {"n": 0}
    preds = probs.argmax(1)
    top3 = np.argsort(-probs, axis=1)[:, :3]
    top1 = float((preds == labels).mean())
    top3_acc = float(np.mean([labels[i] in top3[i] for i in range(len(labels))]))
    macro_f1 = float(f1_score(labels, preds, labels=list(range(num_classes)), average="macro", zero_division=0))
    p, r, f, _ = precision_recall_fscore_support(
        labels, preds, labels=list(range(num_classes)), average=None, zero_division=0
    )
    cm = confusion_matrix(labels, preds, labels=list(range(num_classes))).tolist()
    return {
        "n": int(len(labels)),
        "top1": top1,
        "top3": top3_acc,
        "macro_f1": macro_f1,
        "per_class": {"precision": p.tolist(), "recall": r.tolist(), "f1": f.tolist()},
        "confusion_matrix": cm,
    }


def _ood_auroc(known_conf: np.ndarray, unknown_conf: np.ndarray) -> float:
    from sklearn.metrics import roc_auc_score

    if len(known_conf) == 0 or len(unknown_conf) == 0:
        return float("nan")
    y = np.concatenate([np.ones_like(known_conf), np.zeros_like(unknown_conf)])
    s = np.concatenate([known_conf, unknown_conf])
    return float(roc_auc_score(y, s))


def evaluate(
    onnx_path: Path,
    splits_dir: Path,
    label_map: LabelMap,
    preprocess_cfg: PreprocessConfig,
    train_cfg: TrainConfig,
    out_dir: Path,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    nc = label_map.num_classes
    targets = list(train_cfg.get_path("eval.coverage_targets", [0.5, 0.7, 0.9]))
    bins = int(train_cfg.get_path("eval.ece_bins", 15))

    report: dict[str, object] = {"labels": list(label_map.names), "splits": {}}
    conf_by_split: dict[str, np.ndarray] = {}

    for split in ("val", "test_id", "test_ood"):
        npz = splits_dir / f"{split}.npz"
        if not npz.exists():
            continue
        d = load_split(npz)
        images, labels = d["images"], d["labels"]
        keep = labels >= 0
        images, labels = images[keep], labels[keep]
        probs = run_probs(onnx_path, images, preprocess_cfg)
        m = _classification_metrics(probs, labels, nc)
        if len(probs):
            conf = probs.max(1)
            correct = (probs.argmax(1) == labels).astype(np.float64)
            m["ece"] = _ece(conf, correct, bins)
            m["risk_coverage"] = _risk_coverage(conf, correct, targets)
            conf_by_split[split] = conf
        report["splits"][split] = m  # type: ignore[index]

    # unknown-detection AUROC: test_id (known) vs unknown pool
    unk = splits_dir / "unknown.npz"
    if unk.exists():
        du = load_split(unk)
        unk_probs = run_probs(onnx_path, du["images"], preprocess_cfg)
        unk_conf = unk_probs.max(1) if len(unk_probs) else np.zeros((0,))
        known = conf_by_split.get("test_id", conf_by_split.get("val", np.zeros((0,))))
        report["unknown_detection"] = {
            "n_known": int(len(known)),
            "n_unknown": int(len(unk_conf)),
            "auroc_maxsoftmax": _ood_auroc(known, unk_conf),
        }

    (out_dir / "eval_report.json").write_text(json.dumps(report, indent=2, default=float))
    # console summary
    print("[eval] summary:")
    for split, m in report["splits"].items():  # type: ignore[union-attr]
        if isinstance(m, dict) and m.get("n"):
            print(f"  {split:9s} n={m['n']:4d}  top1={m.get('top1', float('nan')):.3f}  "
                  f"top3={m.get('top3', float('nan')):.3f}  macroF1={m.get('macro_f1', float('nan')):.3f}  "
                  f"ece={m.get('ece', float('nan')):.3f}")
    if "unknown_detection" in report:
        ud = report["unknown_detection"]
        print(f"  unknown   AUROC(maxsoftmax)={ud['auroc_maxsoftmax']:.3f} "
              f"(known={ud['n_known']}, unknown={ud['n_unknown']})")
    return report
