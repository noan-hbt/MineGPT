---
name: gpu-power-cap
description: RTX 4070 Laptop stuck at ~30 W (SW Power Cap) — fix-gpu-power.ps1 didn't help, reboot+update did
metadata:
  type: project
---
2026-11-17 night: GPU capped ~30 W under load ("SW Power Cap"), slowing training. `fix-gpu-power.ps1` (NVPCF restart +
Dell AWCC thermal profile) did not fix it. 2026-11-18 reboot + Windows/driver update (610.60) fixed it: matmul load
draws 128-133 W, 2.2-2.3 GHz, ~40 TFLOPS fp16, 87 °C (brief SW thermal slowdown = normal).

**Why:** a capped GPU silently makes trainings/benches ~4x slower.
**How to apply:** if training feels slow, check `nvidia-smi --query-gpu=power.draw,clocks_throttle_reasons.sw_power_cap
--format=csv` under load; idle draw (~20 W) tells nothing. Try a reboot first. See [[ram-budget]].
