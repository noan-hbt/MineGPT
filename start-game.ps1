# Single-agent, lowest-latency LFM3 server for game playing (~150-250 ms per action).
# API: http://127.0.0.1:8080/v1/chat/completions
# Client side, for speed: thinking off, temperature 0, tiny output (grammar "action arg"),
# stable prompt prefix (system prompt first, no sliding history) so the prompt cache hits.
# See game_latency.py for a working request example.

param([int]$Port = 8080, [int]$Ctx = 16384)

& "$PSScriptRoot\llama.cpp\llama-server.exe" `
    -m "$PSScriptRoot\models\LFM3-1.7B-QAD-Q4_0.gguf" `
    --alias lfm3-1.7b --host 127.0.0.1 --port $Port `
    -ngl 99 -fa on -np 1 -c $Ctx -b 2048 -ub 1024 `
    --jinja --reasoning off `
    --samplers 'penalties;top_k;temperature' --backend-sampling `
    --spec-type ngram-mod `
    -t 8 -C 0xFFFF --cpu-strict 1 --prio 2
