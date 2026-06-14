"""torch -> ONNX -> int8, with a PyTorch-vs-ONNX parity gate (plan §5.8).

Steps:
  1. export the trained model to fp32 ONNX at a conservative opset
  2. quantize to int8 (static w/ a calibration set, preferred for CNNs; or dynamic)
  3. parity-check PyTorch-float vs ONNX-int8 logits on Test-ID — top-1 agreement
     and logit MSE. A breach is a release blocker.
  4. emit the shipping bundle: icon-classifier.onnx + labels.json + preprocess.json
     (destined for the extension's public/models/).

The final ORT *Web* (WebGPU/WASM) load test can only run in JS — see README; this
module verifies the model under Python onnxruntime, which catches most issues.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import torch

from . import paths
from .config import LabelMap, PreprocessConfig, TrainConfig
from .model import build_model

INPUT_NAME = "input"
OUTPUT_NAME = "logits"


def load_checkpoint(path: Path, device: str = "cpu") -> tuple[torch.nn.Module, dict]:
    ckpt = torch.load(path, map_location=device, weights_only=False)
    model = build_model(ckpt["backbone"], ckpt["num_classes"], pretrained=False)
    model.load_state_dict(ckpt["state_dict"])
    model.eval().to(device)
    return model, ckpt


def _onnx_opset(onnx_path: Path) -> int | None:
    """The default-domain (ai.onnx) opset of an exported model, or None."""
    import onnx

    md = onnx.load(str(onnx_path))
    for op in md.opset_import:
        if (op.domain or "") in ("", "ai.onnx"):
            return int(op.version)
    return None


def export_onnx(model: torch.nn.Module, input_size: int, channels: int, out_path: Path, opset: int) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, channels, input_size, input_size, dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        str(out_path),
        input_names=[INPUT_NAME],
        output_names=[OUTPUT_NAME],
        dynamic_axes={INPUT_NAME: {0: "batch"}, OUTPUT_NAME: {0: "batch"}},
        opset_version=opset,
        do_constant_folding=True,
        # Force the legacy TorchScript exporter. The dynamo exporter (the default
        # since torch 2.x) has a minimum opset of 18; when asked for 17 it warns,
        # attempts an opset down-conversion that quietly fails, and ships an
        # opset-18 graph anyway. The legacy path honors opset_version exactly and
        # emits the conservative op set that onnxruntime-web is validated against.
        dynamo=False,
    )
    # Belt-and-suspenders: never silently ship the wrong opset (ORT-Web support is
    # pinned to export.opset). A mismatch is a release blocker, not a warning.
    actual = _onnx_opset(out_path)
    if actual != opset:
        raise RuntimeError(
            f"ONNX export opset mismatch: requested {opset}, exporter produced {actual}. "
            "ORT-Web compatibility is pinned to export.opset in train.yaml; refusing to ship a drifted graph."
        )
    return out_path


class _ArrayCalibrationReader:
    """Feeds normalized calibration batches to onnxruntime static quantization."""

    def __init__(self, x: np.ndarray, batch: int = 32):
        self._batches = [x[i : i + batch] for i in range(0, len(x), batch)] or [x[:0]]
        self._i = 0

    def get_next(self):
        if self._i >= len(self._batches):
            return None
        b = self._batches[self._i]
        self._i += 1
        return {INPUT_NAME: b.astype(np.float32)}

    def rewind(self):
        self._i = 0


def _to_fp16(fp32_path: Path, out_path: Path) -> Path:
    """Cast the fp32 graph to fp16, keeping fp32 I/O.

    int8 *activation* quantization is intrinsically lossy on MobileNetV3-family
    backbones (hardswish + squeeze-excite blocks): no calibration method recovers
    more than ~0.73 top1 vs the 0.90 fp32 model, so it can't clear the parity gate
    without quantization-aware training. fp16 is near-lossless (~0.9995 agreement)
    at half the fp32 size and is well-supported by onnxruntime-web's WebGPU/WASM
    backends. `keep_io_types=True` leaves the input/output fp32 so the extension's
    preprocess contract (float32 NCHW in, float32 logits out) is unchanged; the cast
    happens inside the graph.
    """
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16

    model = onnx.load(str(fp32_path))
    fp16 = convert_float_to_float16(model, keep_io_types=True)
    onnx.save(fp16, str(out_path))
    return out_path


def quantize(
    fp32_path: Path,
    int8_path: Path,
    mode: str,
    calibration_x: np.ndarray | None,
) -> Path:
    from onnxruntime.quantization import QuantType, quantize_dynamic, quantize_static
    from onnxruntime.quantization import QuantFormat

    if mode == "fp16":
        return _to_fp16(fp32_path, int8_path)

    # shape-inference / cleanup pre-pass improves quantization robustness
    src = fp32_path
    try:
        from onnxruntime.quantization.shape_inference import quant_pre_process

        pre = fp32_path.with_suffix(".pre.onnx")
        quant_pre_process(str(fp32_path), str(pre))
        src = pre
    except Exception as e:  # noqa: BLE001
        print(f"[export] quant_pre_process skipped: {e}")

    if mode == "static" and calibration_x is not None and len(calibration_x) > 0:
        reader = _ArrayCalibrationReader(calibration_x)
        quantize_static(
            str(src),
            str(int8_path),
            calibration_data_reader=reader,
            quant_format=QuantFormat.QDQ,
            per_channel=True,
            activation_type=QuantType.QInt8,
            weight_type=QuantType.QInt8,
        )
    else:
        if mode == "static":
            print("[export] no calibration data -> falling back to dynamic quantization")
        quantize_dynamic(str(src), str(int8_path), weight_type=QuantType.QInt8)
    return int8_path


def _onnx_logits(onnx_path: Path, x: np.ndarray, batch: int = 64) -> np.ndarray:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    outs = []
    for i in range(0, len(x), batch):
        outs.append(sess.run(None, {name: x[i : i + batch].astype(np.float32)})[0])
    return np.concatenate(outs, axis=0) if outs else np.zeros((0,))


@torch.no_grad()
def _torch_logits(model: torch.nn.Module, x: np.ndarray, batch: int = 64) -> np.ndarray:
    outs = []
    for i in range(0, len(x), batch):
        outs.append(model(torch.from_numpy(x[i : i + batch])).cpu().numpy())
    return np.concatenate(outs, axis=0) if outs else np.zeros((0,))


def parity_check(model: torch.nn.Module, int8_path: Path, x_eval: np.ndarray) -> dict:
    if len(x_eval) == 0:
        return {"n": 0, "top1_agreement": float("nan"), "logit_mse": float("nan")}
    tl = _torch_logits(model, x_eval)
    ol = _onnx_logits(int8_path, x_eval)
    agree = float((tl.argmax(1) == ol.argmax(1)).mean())
    mse = float(np.mean((tl - ol) ** 2))
    return {"n": int(len(x_eval)), "top1_agreement": agree, "logit_mse": mse}


def export(
    checkpoint_path: Path,
    train_cfg: TrainConfig,
    label_map: LabelMap,
    preprocess_cfg: PreprocessConfig,
    splits_dir: Path,
    model_out_dir: Path,
) -> dict:
    from .train import load_tensor_split

    model_out_dir.mkdir(parents=True, exist_ok=True)
    model, _ = load_checkpoint(checkpoint_path)

    opset = int(train_cfg.get_path("export.opset", 17))
    fp32_path = model_out_dir / "icon-classifier.fp32.onnx"
    int8_path = model_out_dir / "icon-classifier.onnx"
    export_onnx(model, preprocess_cfg.input_size, preprocess_cfg.channels, fp32_path, opset)

    # calibration from val (fall back to test_id), normalized exactly like training
    cal_x = None
    n_cal = int(train_cfg.get_path("export.calibration_samples", 0))
    for split in ("val", "test_id", "train"):
        xs, _, _, _ = load_tensor_split(splits_dir / f"{split}.npz", preprocess_cfg)
        if len(xs):
            cal_x = xs.numpy()[:n_cal] if n_cal else xs.numpy()
            break

    quantize(fp32_path, int8_path, str(train_cfg.get_path("export.quantize", "static")), cal_x)

    # parity on Test-ID (fall back to val)
    par_x = None
    for split in ("test_id", "val", "train"):
        xs, _, _, _ = load_tensor_split(splits_dir / f"{split}.npz", preprocess_cfg)
        if len(xs):
            par_x = xs.numpy()
            break
    parity = parity_check(model, int8_path, par_x if par_x is not None else np.zeros((0,)))

    thr = train_cfg.get_path("export.parity", {}) or {}
    min_agree = float(thr.get("min_top1_agreement", 0.0))
    max_mse = float(thr.get("max_logit_mse", float("inf")))
    ok = (np.isnan(parity["top1_agreement"]) or parity["top1_agreement"] >= min_agree) and (
        np.isnan(parity["logit_mse"]) or parity["logit_mse"] <= max_mse
    )

    # ship the contract files alongside the model
    shutil.copyfile(paths.LABELS_JSON, model_out_dir / "labels.json")
    shutil.copyfile(paths.PREPROCESS_JSON, model_out_dir / "preprocess.json")

    mode = str(train_cfg.get_path("export.quantize", "static"))
    sizes = {
        "fp32_mb": round(fp32_path.stat().st_size / 1e6, 3),
        "quantized_mb": round(int8_path.stat().st_size / 1e6, 3),
    }
    report = {
        "checkpoint": str(checkpoint_path),
        "onnx_model": str(int8_path),
        "opset": opset,
        "quantize": mode,
        "sizes": sizes,
        "parity": parity,
        "parity_thresholds": {"min_top1_agreement": min_agree, "max_logit_mse": max_mse},
        "parity_ok": bool(ok),
    }
    (model_out_dir / "export_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if not ok:
        print("[export] WARNING: parity gate FAILED — would be a release blocker on real data")
    return report
