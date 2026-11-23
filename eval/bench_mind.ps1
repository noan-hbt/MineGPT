# Bench local GGUF models as the mind policy (lockstep, sim 1) on the easy cards, one llama-server at a time.
# Usage: powershell -File eval/bench_mind.ps1 [-Cards craft.planks,gather.chop_tree,nav.goto_place] [-Seeds 1,2]
# Output: eval/results/mind_<tag>.txt + data/own/<date>/*_M_<tag>_cards.jsonl ; done marker eval/results/mind_DONE.txt
# -Grammar: GBNF-constrained decoding (bot/dsl/gbnf.js), server reasoning off (the think: lines are the reasoning)
param([string]$Cards = 'craft.planks,gather.chop_tree,nav.goto_place', [string]$Seeds = '1,2', [int]$Sim = 1,
  [switch]$Grammar, [string]$Models = 'lfm3,bonsai', [string]$Suffix = '')
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\noanh\Desktop\Dev\localai'
$paths = [ordered]@{
  lfm3   = "$root\models\LFM3-1.7B-QAD-Q4_0.gguf"
  bonsai = "$root\models\compare\Ternary-Bonsai-2-2B-Q2_0.gguf"
}
Set-Location "$root\bot"
node sim/instance.js stop $Sim | Out-Null
node sim/instance.js start $Sim | Out-Null
foreach ($m in $Models.Split(',')) {
  $tag = $m + $(if ($Grammar) { '_g' } else { '' }) + $Suffix
  $log = "$root\eval\results\mind_$tag.txt"
  $srv = Start-Process "$root\llama.cpp\llama-server.exe" -PassThru -WindowStyle Hidden -RedirectStandardError "$root\eval\results\mind_${tag}_server.log" -ArgumentList (@(
    '-m', $paths[$m], '--host', '127.0.0.1', '--port', '8080', '-ngl', '99', '-fa', 'on', '-c', '16384', '-np', '1',
    '--load-mode', 'none', '--jinja', '--reasoning-format', 'deepseek') + $(if ($Grammar) { @('--reasoning', 'off') } else { @('--reasoning-budget', '256') }))
  $ok = $false
  foreach ($i in 1..90) { Start-Sleep 2; try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break } } catch {} }
  if ($ok) {
    node sim/run_cards.js --sim $Sim --lock --policy mind --llm http://127.0.0.1:8080 --max-tokens 1024 $(if ($Grammar) { '--grammar' }) --only $Cards --seeds $Seeds --name "M_$tag" *> $log
  } else { "llama-server did not come up" | Out-File $log }
  Stop-Process -Id $srv.Id -Force
  Start-Sleep 3
}
node sim/instance.js stop $Sim | Out-Null
Get-Date | Out-File "$root\eval\results\mind_DONE.txt"
