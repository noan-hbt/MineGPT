#!/bin/bash
# B19: train on GPT synthetic episodes (1000-1007), eval on held-out episodes (1008-1009 GPT + DeepSeek) + real test.
cd "$(dirname "$0")/.."
PY=b21/.venv/Scripts/python.exe
T=gpt_test,ds_test,test
run() { echo "=== $(date +%T) $*"; $PY -u b19/sft.py "$@" 2>&1 | grep --line-buffered -vE "rope_parameters|[Ww]arning"; }
run --model models/LFM2.5-350M-hf --mode zero --test-files gpt_test,ds_test
run --model models/LFM2.5-350M-hf --mode full --epochs 2 --train-file gpt_train --tag=-gpt --test-files $T
echo "=== STAGE1_DONE $(date +%T)"
run --model models/LFM3-1.7B-hf --mode lora --epochs 2 --train-file gpt_train --tag=-gpt --test-files $T
run --model models/LFM3-1.7B-hf --mode lora --adapter b19/runs/LFM3-1.7B-lora --test-files gpt_test,ds_test
run --model models/LFM3-1.7B-hf --mode zero --test-files gpt_test,ds_test
echo "=== ALL_DONE $(date +%T)"
