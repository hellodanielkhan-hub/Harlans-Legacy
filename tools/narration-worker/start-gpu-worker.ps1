# Harlan's Legacy - production narration worker on the GPU engine box.
#
# Drains the PRODUCTION narration queue (Supabase) that Admin "Generate Voice"
# fills, using the Golden recipe on CUDA. Run it from a checkout of the deployed
# main; leave the window open (the worker polls every few seconds and reports
# its presence, so Admin shows "worker: online").
#
#   powershell -ExecutionPolicy Bypass -File tools\narration-worker\start-gpu-worker.ps1
#
# The worker refuses to start (and says why) if it is not connected to Supabase,
# or if the engine interpreter has no CUDA - it never falls back to CPU synthesis.
param(
  # server .env with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (read in place, never copied)
  [string]$EnvFile  = "D:\DATA\harlans-legacy-platform\.env",
  # private Golden engine (harlan_golden.py + the CUDA venv)
  [string]$VoiceLab = "D:\DATA\harlans-legacy-platform\prototype\voicelab",
  # engine hard limit per job; the queue itself is protected by heartbeats
  [int]$EngineTimeoutMin = 60
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$python = Join-Path $VoiceLab "venv-cuda\Scripts\python.exe"
$golden = Join-Path $VoiceLab "harlan_golden.py"
foreach ($p in @($EnvFile, $python, $golden)) { if (-not (Test-Path $p)) { throw "Missing: $p" } }

$env:HARLAN_ENV_FILE          = $EnvFile
$env:HARLAN_ENGINE_CMD        = "$python $golden"     # Golden GENERATION_RECIPE.v1, pinned checkpoint
$env:HARLAN_REQUIRE_GPU       = "1"                   # CUDA or refuse - no CPU synthesis fallback
$env:HARLAN_ALIGN_DEVICE      = "cpu"                 # alignment on CPU: the display GPU's Windows watchdog (TDR) kills one long kernel
$env:HARLAN_ALIGN_MAX_SINGLE_S = "480"                # windowed alignment only for narrations longer than 8 min
$env:HARLAN_ALIGN_WINDOW_S    = "120"
$env:HARLAN_ALIGN_CONTEXT_S   = "8"
$env:HARLAN_ENGINE_TIMEOUT_MS = [string]($EngineTimeoutMin * 60 * 1000)

Write-Host "[start-gpu-worker] repo $repo"
Set-Location $repo
node (Join-Path $repo "lib\narration\worker.js") --loop
