# Unstick the RTX 4070 Laptop power cap (stuck at 30 W instead of 115 W, "SW Power Cap" active) on the Dell G16 7630.
# Needs admin: self-elevates (UAC prompt). Log: fix-gpu-power.log next to this script.
#  1. restart the NVIDIA Platform Controllers and Framework device (NVPCF, Dynamic Boost) = usual fix for the 30 W bug
#  2. if still capped: Dell thermal profile -> Performance through the AWCC WMI interface (same as Alienware Command
#     Center). Thermal_Control arg = (profile << 8) | 1 ; profiles (Linux alienware-wmi): 0xA0 balanced,
#     0xA1 balanced-performance, 0xA4 performance, 0xAB G-mode. Thermal_Information 0x0B = current profile.
#  -List : only query the BIOS (supported profile ids via Thermal_Information op 0x03, Game Shift state), change nothing
#  -Profile 0x99 : any raw profile id (hex) seen in -List
param([string]$Profile = 'performance', [switch]$List)
$log = Join-Path $PSScriptRoot 'fix-gpu-power.log'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -Wait -ArgumentList ("-ExecutionPolicy Bypass -File `"$PSCommandPath`" -Profile $Profile" + $(if ($List) { ' -List' } else { '' }))
  Get-Content $log
  exit
}
Start-Transcript -Path $log -Force | Out-Null
function Limit { (nvidia-smi --query-gpu=power.limit,power.default_limit,power.draw --format=csv,noheader) }
"before: $(Limit)"

if ($List) {
  $w = Get-CimInstance -Namespace root\WMI -ClassName AWCCWmiMethodFunction | Select-Object -First 1
  $q = { param($m, $a) try { '0x{0:X}' -f (Invoke-CimMethod -InputObject $w -MethodName $m -Arguments @{ arg2 = [uint32]$a }).argr } catch { 'err' } }
  "current profile (op 0x0B): $(& $q Thermal_Information 0x0B)"
  "sys description (op 0x02): $(& $q Thermal_Information 0x02)"
  foreach ($i in 0..15) { "profile list idx $i (op 0x03): $(& $q Thermal_Information (($i -shl 8) -bor 0x03))" }
  "game shift status (0x02): $(& $q GameShiftStatus 0x02)"
  "power information (0x00): $(& $q PowerInformation 0x00)"
  Stop-Transcript | Out-Null
  exit
}

$dev = Get-PnpDevice | Where-Object { $_.FriendlyName -match 'Platform Controllers and Framework' } | Select-Object -First 1
if ($dev) {
  "restarting $($dev.FriendlyName) ($($dev.InstanceId))"
  Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
  Start-Sleep 3
  Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
  Start-Sleep 5
  "after NVPCF restart: $(Limit)"
}

$w = Get-CimInstance -Namespace root\WMI -ClassName AWCCWmiMethodFunction -ErrorAction SilentlyContinue | Select-Object -First 1
if ($w) {
  $cur = (Invoke-CimMethod -InputObject $w -MethodName Thermal_Information -Arguments @{ arg2 = [uint32]0x0B }).argr
  "current Dell thermal profile: 0x{0:X}" -f $cur
  $id = @{ balanced = 0xA0; 'balanced-performance' = 0xA1; performance = 0xA4; gmode = 0xAB }[$Profile]
  if (-not $id -and $Profile -match '^0x[0-9a-fA-F]+$') { $id = [Convert]::ToInt32($Profile.Substring(2), 16) }
  if ($id) {
    $r = (Invoke-CimMethod -InputObject $w -MethodName Thermal_Control -Arguments @{ arg2 = [uint32](($id -shl 8) -bor 1) }).argr
    "set profile $Profile (0x{0:X}) -> return 0x{1:X}" -f $id, $r
    Start-Sleep 3
    "after profile: $(Limit)"
  }
}
Stop-Transcript | Out-Null
