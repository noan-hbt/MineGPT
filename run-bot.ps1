# Runs the Minecraft LLM bot and restarts it if it crashes or gets disconnected. Ctrl+C to quit.
param([string]$Goal = "")
Set-Location "$PSScriptRoot\mcbot"
while ($true) {
    if ($Goal) { node --max-old-space-size=2048 bot.js --goal $Goal } else { node --max-old-space-size=2048 bot.js }
    Write-Host "[run-bot] bot exited ($LASTEXITCODE), restarting in 5 s..."
    Start-Sleep 5
}
