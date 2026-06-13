"""Export -> ONNX -> onnxruntime float run + parity helper. Guarded on heavy deps."""
import numpy as np
import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")

from iconlab.export import export_onnx, parity_check  # noqa: E402


class _Tiny(torch.nn.Module):
    def __init__(self, nc=3):
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Conv2d(3, 4, 3, padding=1), torch.nn.ReLU(),
            torch.nn.AdaptiveAvgPool2d(1), torch.nn.Flatten(), torch.nn.Linear(4, nc),
        )

    def forward(self, x):
        return self.net(x)


def test_export_and_onnx_run(tmp_path):
    model = _Tiny(nc=3).eval()
    onnx_path = tmp_path / "tiny.onnx"
    export_onnx(model, input_size=64, channels=3, out_path=onnx_path, opset=17)
    assert onnx_path.exists()

    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    x = np.zeros((2, 3, 64, 64), dtype=np.float32)
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    assert out.shape == (2, 3)


def test_parity_check_identical_model(tmp_path):
    # parity of a model against its own fp32 ONNX should be perfect agreement
    model = _Tiny(nc=3).eval()
    onnx_path = tmp_path / "tiny.onnx"
    export_onnx(model, input_size=64, channels=3, out_path=onnx_path, opset=17)
    x = np.random.RandomState(0).randn(8, 3, 64, 64).astype(np.float32)
    res = parity_check(model, onnx_path, x)
    assert res["n"] == 8
    assert res["top1_agreement"] == 1.0
    assert res["logit_mse"] < 1e-6
