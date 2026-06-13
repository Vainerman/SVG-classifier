"""Fine-tuning loop (plan §5.7): AdamW, cosine LR with warmup, label-smoothed
cross-entropy, optional class-balanced sampling.

Consumes the baked npz splits (uint8 grayscale) and normalizes them to tensors via
the shared preprocess transform. Saves a checkpoint carrying everything export.py
needs to rebuild the model and reproduce the input contract.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler

from .config import LabelMap, PreprocessConfig, TrainConfig
from .dataset import load_split
from .model import build_model, resolve_device
from .preprocess import normalize_batch


def load_tensor_split(
    npz_path: Path, preprocess_cfg: PreprocessConfig, drop_unknown: bool = True
) -> tuple[torch.Tensor, torch.Tensor, np.ndarray, np.ndarray]:
    d = load_split(npz_path)
    images, labels, srcs, libs = d["images"], d["labels"], d["srcs"], d["libs"]
    if drop_unknown and len(labels):
        keep = labels >= 0
        images, labels, srcs, libs = images[keep], labels[keep], srcs[keep], libs[keep]
    if len(images) == 0:
        s = preprocess_cfg.input_size
        x = torch.zeros((0, preprocess_cfg.channels, s, s), dtype=torch.float32)
        return x, torch.zeros((0,), dtype=torch.long), srcs, libs
    x = torch.from_numpy(normalize_batch(images, preprocess_cfg))
    y = torch.from_numpy(labels.astype(np.int64))
    return x, y, srcs, libs


def _cosine_warmup(optimizer, warmup_steps: int, total_steps: int):
    def fn(step: int) -> float:
        if step < warmup_steps:
            return (step + 1) / max(1, warmup_steps)
        prog = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1 + math.cos(math.pi * min(1.0, prog)))

    return torch.optim.lr_scheduler.LambdaLR(optimizer, fn)


@torch.no_grad()
def _accuracy(model, x: torch.Tensor, y: torch.Tensor, device, batch: int = 256) -> float:
    if len(x) == 0:
        return float("nan")
    model.eval()
    correct = 0
    for i in range(0, len(x), batch):
        logits = model(x[i : i + batch].to(device))
        correct += (logits.argmax(1).cpu() == y[i : i + batch]).sum().item()
    return correct / len(x)


def train(
    train_cfg: TrainConfig,
    label_map: LabelMap,
    preprocess_cfg: PreprocessConfig,
    splits_dir: Path,
    out_dir: Path,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    device = resolve_device(train_cfg.get_path("train.device", "auto"))

    xtr, ytr, _, _ = load_tensor_split(splits_dir / "train.npz", preprocess_cfg)
    xva, yva, _, _ = load_tensor_split(splits_dir / "val.npz", preprocess_cfg)
    if len(xtr) == 0:
        raise RuntimeError("empty train split — check the manifest / taxonomy mapping")
    print(f"[train] device={device}  train={len(xtr)}  val={len(xva)}  classes={label_map.num_classes}")

    ds = TensorDataset(xtr, ytr)
    bs = min(int(train_cfg.get_path("train.batch_size", 64)), len(ds))

    if train_cfg.get_path("train.class_balanced_sampling", False):
        counts = np.bincount(ytr.numpy(), minlength=label_map.num_classes).astype(np.float64)
        w = 1.0 / np.clip(counts[ytr.numpy()], 1, None)
        sampler = WeightedRandomSampler(torch.as_tensor(w, dtype=torch.double), len(ds), replacement=True)
        loader = DataLoader(ds, batch_size=bs, sampler=sampler, num_workers=0)
    else:
        loader = DataLoader(ds, batch_size=bs, shuffle=True, num_workers=0)

    model = build_model(
        train_cfg.get_path("model.backbone", "mobilenetv3_small_100"),
        num_classes=label_map.num_classes,
        pretrained=bool(train_cfg.get_path("model.pretrained", True)),
        drop_rate=float(train_cfg.get_path("model.drop_rate", 0.0)),
    ).to(device)

    epochs = int(train_cfg.get_path("train.epochs", 10))
    opt = torch.optim.AdamW(
        model.parameters(),
        lr=float(train_cfg.get_path("train.lr", 1e-3)),
        weight_decay=float(train_cfg.get_path("train.weight_decay", 0.05)),
    )
    steps_per_epoch = max(1, len(loader))
    warmup = int(train_cfg.get_path("train.warmup_epochs", 0)) * steps_per_epoch
    sched = _cosine_warmup(opt, warmup, epochs * steps_per_epoch)
    criterion = nn.CrossEntropyLoss(label_smoothing=float(train_cfg.get_path("train.label_smoothing", 0.0)))

    best_acc, best_path = -1.0, out_dir / "checkpoint.pt"
    meta = {
        "backbone": train_cfg.get_path("model.backbone", "mobilenetv3_small_100"),
        "num_classes": label_map.num_classes,
        "input_size": preprocess_cfg.input_size,
        "channels": preprocess_cfg.channels,
        "labels": list(label_map.names),
    }
    for ep in range(epochs):
        model.train()
        running = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            opt.step()
            sched.step()
            running += loss.item() * len(xb)
        val_acc = _accuracy(model, xva, yva, device)
        print(f"[train] epoch {ep+1}/{epochs}  loss={running/len(ds):.4f}  val_acc={val_acc:.3f}")
        if not math.isnan(val_acc) and val_acc >= best_acc or best_acc < 0:
            best_acc = val_acc if not math.isnan(val_acc) else best_acc
            torch.save({**meta, "state_dict": model.state_dict(), "val_acc": best_acc}, best_path)

    if not best_path.exists():  # no val data -> save final
        torch.save({**meta, "state_dict": model.state_dict(), "val_acc": best_acc}, best_path)
    print(f"[train] saved {best_path}  best_val_acc={best_acc:.3f}")
    return best_path
