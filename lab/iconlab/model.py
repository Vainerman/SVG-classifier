"""timm backbone factory (plan §5.7).

Small, ImageNet-pretrained backbones we transfer-learn: MobileNetV3-Small,
ViT-Tiny, EfficientNet-Lite0. Input is 3-channel (luminance replicated, see
preprocess.py) at preprocess.json's input_size, so standard 3-chan pretrained
weights load directly.
"""
from __future__ import annotations

import torch
import torch.nn as nn


def build_model(
    backbone: str,
    num_classes: int,
    pretrained: bool = True,
    drop_rate: float = 0.0,
) -> nn.Module:
    import timm

    model = timm.create_model(
        backbone,
        pretrained=pretrained,
        num_classes=num_classes,
        in_chans=3,
        drop_rate=drop_rate,
    )
    return model


def resolve_device(spec: str = "auto") -> torch.device:
    if spec and spec != "auto":
        return torch.device(spec)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")
