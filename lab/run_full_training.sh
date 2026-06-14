#!/usr/bin/env bash
# Full real-data training run: build -> train -> export(int8+parity) -> evaluate.
# Logs each stage with timestamps to artifacts/full_run.log.
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate

LOG=artifacts/full_run.log
mkdir -p artifacts
: > "$LOG"

stage() { echo "" | tee -a "$LOG"; echo "===== [$(date '+%H:%M:%S')] $1 =====" | tee -a "$LOG"; }

stage "1/4 build_dataset (provenance -> manifest -> render -> bake splits)"
python scripts/build_dataset.py 2>&1 | tee -a "$LOG"

stage "2/4 train (timm mobilenetv3_small_100, 30 epochs, MPS)"
python scripts/train.py 2>&1 | tee -a "$LOG"

stage "3/4 export (ONNX int8 static + parity gate)"
python scripts/export.py 2>&1 | tee -a "$LOG"

stage "4/4 evaluate (top1/3, macro-F1, ECE, risk-coverage, OOD AUROC)"
python scripts/evaluate.py 2>&1 | tee -a "$LOG"

stage "DONE"
