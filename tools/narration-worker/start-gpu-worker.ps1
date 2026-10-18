# Harlan's Legacy - production narration worker on the GPU engine box.
#
# Starts the SUPERVISOR (lib/narration/supervisor.js), which keeps one narration worker
# running, restarts it if it exits (bounded backoff), stops retrying on configuration
# errors, and logs every start/exit/restart with exit codes to
#   %LOCALAPPDATA%\harlans-narration\logs\worker.log
# The worker drains the PRODUCTION narration queue (Supabase) that Admin "Generate Voice"
# fills, using the Golden engine release (hash-verified against its MANIFEST.json) on CUDA.
# Started at logon by the Startup shortcut "Harlan narration GPU worker.lnk".
#
#   powershell -ExecutionPolicy Bypass -File tools\narration-worker\start-gpu-worker.ps1
#
param(
  # server .env with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (read in place, never copied)
  [string]$EnvFile  = "D:\DATA\harlans-legacy-platform\.env",
  # voice assets: ref_typical.wav, hfcache, torchcache + the CUDA python venv
  [string]$VoiceLab = "D:\DATA\harlans-legacy-platform\prototype\voicelab",
  # private, version-controlled Golden engine release (golden\harlan_golden.py + MANIFEST.json)
  [string]$EnginePackage = "D:\DATA\harlans-engine",
  # use the previous single-file engine in $VoiceLab instead of the release (rollback only)
  [switch]$LegacyEngine,
  # engine hard limit per job; the queue itself is protected by heartbeats
  [int]$EngineTimeoutMin = 60,
  # free commit memory required before a job starts. Measured worst case of golden-engine 1.1:
  # 8.8 GB (+1.7 GB margin). The legacy single-process engine needs 12.5 GB (10.45 GB + margin).
  [double]$MinCommitGB = 0
)
$ErrorActionPreference = "Stop"
try { $Host.UI.RawUI.WindowTitle = "Harlan's Legacy narration GPU worker (keep open)" } catch {}
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$python = Join-Path $VoiceLab "venv-cuda\Scripts\python.exe"
if ($LegacyEngine) { $golden = Join-Path $VoiceLab "harlan_golden.py"; $manifest = $null }
else { $golden = Join-Path $EnginePackage "golden\harlan_golden.py"; $manifest = Join-Path $EnginePackage "MANIFEST.json" }
foreach ($p in @($EnvFile, $python, $golden)) { if (-not (Test-Path $p)) { throw "Missing: $p" } }
if ($manifest -and -not (Test-Path $manifest)) { throw "Missing: $manifest" }

$env:HARLAN_ENV_FILE          = $EnvFile
$env:HARLAN_ENGINE_CMD        = "$python $golden"     # Golden GENERATION_RECIPE.v1, pinned checkpoint, fp32
if ($manifest) { $env:HARLAN_ENGINE_MANIFEST = $manifest } else { Remove-Item Env:HARLAN_ENGINE_MANIFEST -ErrorAction SilentlyContinue }
$env:HARLAN_VOICELAB_DIR      = $VoiceLab             # voice reference + model caches stay here
$env:HARLAN_REQUIRE_GPU       = "1"                   # CUDA or refuse - no CPU synthesis fallback
$env:HARLAN_ALIGN_DEVICE      = "cpu"                 # alignment on CPU: the display GPU's Windows watchdog (TDR) kills one long kernel
$env:HARLAN_ALIGN_MAX_SINGLE_S = "480"                # windowed alignment only for narrations longer than 8 min
$env:HARLAN_ALIGN_WINDOW_S    = "120"
$env:HARLAN_ALIGN_CONTEXT_S   = "8"
$env:HARLAN_ENGINE_TIMEOUT_MS = [string]($EngineTimeoutMin * 60 * 1000)
if ($MinCommitGB -le 0) { $MinCommitGB = $(if ($LegacyEngine) { 12.5 } else { 10.5 }) }
$env:HARLAN_WORKER_MIN_COMMIT_GB = [string]$MinCommitGB

Write-Host "[start-gpu-worker] repo $repo"
Write-Host "[start-gpu-worker] engine $golden $(if ($manifest) { "(release manifest $manifest)" } else { '(LEGACY, unversioned)' }); memory floor $MinCommitGB GB"
Set-Location $repo
node (Join-Path $repo "lib\narration\supervisor.js")
Write-Host "[start-gpu-worker] supervisor exited with code $LASTEXITCODE at $(Get-Date -Format s)"
