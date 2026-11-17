# Launch LFM3-1.7B (QAD-Q4_0) with llama.cpp CUDA, tuned for RTX 4070 Laptop 8GB.
# OpenAI-compatible API: http://127.0.0.1:8080/v1  (UI: http://127.0.0.1:8080)
#
# Usage:  .\start-lfm3.ps1                 # 8 parallel slots, 16k ctx each
#         .\start-lfm3.ps1 -Slots 16 -CtxPerSlot 8192
#         .\start-lfm3.ps1 -Reasoning off  # skip <think> for faster answers

param(
    [int]$Slots = 8,
    [int]$CtxPerSlot = 16384,
    [int]$Port = 8080,
    [ValidateSet('on', 'off', 'auto')][string]$Reasoning = 'auto',
    [ValidateSet('deepseek', 'none')][string]$ReasoningFormat = 'deepseek'
)

$root = $PSScriptRoot
$ctx = $Slots * $CtxPerSlot

& "$root\llama.cpp\llama-server.exe" `
    -m "$root\models\LFM3-1.7B-QAD-Q4_0.gguf" `
    --alias lfm3-1.7b `
    --host 127.0.0.1 --port $Port `
    -ngl 99 -fa on `
    -c $ctx -np $Slots --no-kv-unified `
    -b 2048 -ub 1024 `
    --cache-reuse 256 `
    --jinja --reasoning $Reasoning --reasoning-format $ReasoningFormat `
    --temp 0.1 --top-k 50 --repeat-penalty 1.1 `
    --samplers 'penalties;top_k;temperature' --backend-sampling `
    -t 8 -C 0xFFFF --cpu-strict 1 --prio 2 --threads-http 8 `
    --metrics
