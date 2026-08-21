# Runs ON the Windows QA VM via `lab.sh exec win qa/cloud/azure/remote/win-smoke.ps1`.
#
# The SCRIPTABLE half of Windows QA. Prints a verdict, not a transcript —
# run-command truncates output around 4 KB.
#
# What this can prove, without anyone looking at a screen:
#   - the installer runs unattended (NSIS accepts /S)
#   - the app launches and stays up
#   - Category A completes — the first real test of the 0.1.2 yt-dlp boot fixes,
#     which were written blind and have never executed on Windows
#   - the studio serves /editor
#   - a brand-new user's onboarding state is correct
#
# What it CANNOT prove, and must not be read as proving: what SmartScreen says,
# whether the installer UX is sane, or whether the terminal panel works. Those
# need eyes on the screen — RDP in for them.
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "[win-smoke] $m" }

$installer = Get-ChildItem "$env:USERPROFILE\qa\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) { throw "no installer in $env:USERPROFILE\qa — copy 'Libi Setup <v>.exe' there first" }

Say "installing $($installer.Name) silently"
Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait

$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Libi.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { throw "Libi.exe not found after install" }
Say "installed: $($exe.FullName)"

# A FRESH home, so Category A genuinely runs. Never the default user home —
# that would make a second run look like a first one.
$home_ = "$env:USERPROFILE\qa\home"
Remove-Item $home_ -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $home_ -Force | Out-Null
$env:LIBI_HOME = $home_

Say "launching with LIBI_HOME=$home_"
$proc = Start-Process -FilePath $exe.FullName -PassThru

# The packaged shell binds an EPHEMERAL port and publishes it to $LIBI_HOME/port
# — LIBI_PORT is dev-only (electron/main.ts gates it on isDev), so do not guess.
$portFile = Join-Path $home_ "port"
$deadline = (Get-Date).AddMinutes(12)   # Category A downloads ffmpeg/uv/models
while (-not (Test-Path $portFile) -and (Get-Date) -lt $deadline) { Start-Sleep 5 }
if (-not (Test-Path $portFile)) {
  Say "FAIL: no port file after 12 min — Category A probably died"
  Get-Content "$home_\logs\libi.log" -Tail 20 -ErrorAction SilentlyContinue
  throw "Category A did not complete"
}
$port = (Get-Content $portFile).Trim()
Say "server port: $port"

$editor = (Invoke-WebRequest "http://127.0.0.1:$port/editor" -UseBasicParsing).StatusCode
$state  = (Invoke-WebRequest "http://127.0.0.1:$port/api/onboarding/state" -UseBasicParsing).Content
Say "GET /editor -> $editor"
Say "onboarding state -> $state"

# The two lines that matter most: did Category A finish, and did yt-dlp install?
$log = "$home_\logs\libi.log"
$done = Select-String -Path $log -Pattern "Category A complete" -ErrorAction SilentlyContinue | Select-Object -Last 1
$ytdlp = Select-String -Path $log -Pattern "yt-dlp" -ErrorAction SilentlyContinue | Select-Object -Last 1
Say "category A: $($done.Line)"
Say "yt-dlp:     $($ytdlp.Line)"
$errs = (Select-String -Path $log -Pattern '"level":(50|60)' -ErrorAction SilentlyContinue | Measure-Object).Count
Say "log entries at level>=50: $errs"

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
# `if` is a statement, not an expression, in PowerShell 5.1 — which is what
# these images ship. Keep this as a plain branch.
if ($editor -eq 200 -and $errs -eq 0) {
  Say "VERDICT: PASS (scriptable half only — SmartScreen/UX/terminal still need eyes)"
} else {
  Say "VERDICT: INVESTIGATE"
}
