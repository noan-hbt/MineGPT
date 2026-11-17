# Local vanilla 1.21.11 server, offline-mode (for the Mineflayer bot). Join from client: Multiplayer > localhost
$java = "$env:LOCALAPPDATA\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime\java-runtime-delta\windows-x64\java-runtime-delta\bin\java.exe"
Set-Location "$PSScriptRoot\mcserver"
& $java -Xms1G -Xmx2G -jar server.jar nogui
