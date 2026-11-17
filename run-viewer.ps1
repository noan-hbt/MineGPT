# Browser spectator view of the bot on http://127.0.0.1:3007 (exposed by the Tailscale funnel on :8443).
# Restarts the viewer if it disconnects (server restart, kick). Ctrl+C to quit.
param([string]$Target = "auto")
Set-Location "$PSScriptRoot\mcbot"
while ($true) {
    node viewer.js --target $Target
    Write-Host "[run-viewer] viewer exited ($LASTEXITCODE), restarting in 5 s..."
    Start-Sleep 5
}
