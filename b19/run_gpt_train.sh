#!/bin/bash
# B19: only the two trainings on GPT synthetic episodes (rerun after the --tag bug).
cd "$(dirname "$0")/.."
PY=b21/.venv/Scripts/python.exe
T=gpt_test,ds_test,test
run() { echo "=== $(date +%T) $*"; $PY -u b19/sft.py "$@" 2>&1 | grep --line-buffered -vE "rope_parameters|[Ww]arning"; }
run --model models/LFM2.5-350M-hf --mode full --epochs 2 --train-file gpt_train --tag=-gpt --test-files $T
echo "=== STAGE1_DONE $(date +%T)"
run --model models/LFM3-1.7B-hf --mode lora --epochs 2 --train-file gpt_train --tag=-gpt --test-files $T
echo "=== ALL_DONE $(date +%T)"
