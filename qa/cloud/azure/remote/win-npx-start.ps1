# Runs ON the Windows QA VM via
#   lab.sh exec win qa/cloud/azure/remote/win-npx-start.ps1 [PatchUv=1]
#
# Launches the published npm package and RETURNS -- win-npx-checks.ps1 does
# the interrogating.
#
# Split for a reason that cost a whole run: `az vm run-command` is bounded by
# the RunCommandWindows extension's PROVISIONING timeout, and one script that
# booted libi and then waited on it blew through with
# VMExtensionProvisioningTimeout. The launched process survives that timeout
# fine -- it was still serving /editor afterwards -- so the fix is to stop
# holding the channel open.
#
# The npx half of Windows Tier 1. Its sibling win-smoke.ps1 tests
# the NSIS installer; this one tests the PUBLISHED npm package, and the
# difference is not academic -- as of 0.1.4 the GitHub release ships macOS
# assets ONLY, so there is no "Libi Setup <v>.exe" to install and win-smoke.ps1
# cannot run at all. This needs nothing but the node `provision` already put on
# the box.
#
# What it proves:
#   1. the published tarball installs and starts under Windows node
#   2. Category A completes -- the first real execution of the 0.1.2 yt-dlp
#      boot fixes, which were written blind and have never run on Windows
#   3. the studio serves /editor, and a new user's onboarding state is right
#   4. every bundled MCP that has a server PROBES UP -- this is what exercises
#      the .bin cmd-shim path (npm writes three files per bin on Windows and
#      only the .cmd is spawnable)
#   5. the ffmpeg libi ITSELF downloaded can render drawtext. Not a generic
#      ffmpeg: the one in LIBI_HOME/bin. Windows pulls gyan.dev's "essentials"
#      build, a name that advertises a REDUCED feature set, and the identical
#      defect shipped broken text-over-video on Linux (F5).
#   6. a terminal session spawns and streams -- ConPTY, never exercised
#
# What it CANNOT prove: anything about the Electron shell, the installer, or
# SmartScreen. Those need the NSIS build and a human at an RDP session.
#
# Prints a verdict, not a transcript -- run-command truncates output near 4 KB.

param(
  [string]$Version = "0.1.4",
  [int]$Port = 3456,
  # Measured: a cold Category A on this box (ffmpeg, uv, Chromium, models)
  # completes in ~68s. Eight minutes is generous for that and still returns
  # well inside the run-command extension's provisioning timeout, which a
  # twenty-minute wait did not.
  [int]$TimeoutMinutes = 8,
  # Patch the uv win32 archive path in npx's OWN cache before launching, to
  # test a fix BEFORE it is published. The published 0.1.4 looks for uv at
  # uv-x86_64-pc-windows-msvc/uv.exe; astral-sh puts it at the zip root, so
  # Category A dies and libi cannot start on Windows at all. Patching the
  # cached copy runs the identical entry point, cache and code with exactly one
  # string changed. Remove this once a release carries the fix -- at that point
  # the UNPATCHED run is the one that has to pass.
  #
  # [int], not [switch] and not [bool]. az renders a parameter as `-Name value`
  # and delivers every value as a STRING: a [switch] consumes no value, so the
  # value falls through as a positional and binds to $Version; and PowerShell's
  # parameter binder refuses to convert a String to [bool] at all, whatever it
  # contains. [int] takes "1" cleanly. Pass PatchUv=1.
  [int]$PatchUv = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Say($m) { Write-Host "[npx-start] $m" }

# Run a native command whose stderr is NOISE, not failure.
#
# PowerShell 5.1 turns ANY output on a native command's stderr into a
# TERMINATING error when $ErrorActionPreference is "Stop" -- so `npm warn
# deprecated ...` and ffmpeg's version banner both abort the script despite
# the command succeeding. Judge these by their effects (a file appeared, a
# port answers), never by the absence of stderr.
function Invoke-Noisy {
  param([scriptblock]$Block)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Block 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}


# Locate a file inside the npx-cached libi package. `$suffix` is matched
# against the tail of the full path, so callers say 'registry\bundled.js'
# rather than a bare filename -- the package ships several same-named files
# (lib/fonts/bundled.js vs mcp/registry/bundled.js) and a bare name picks
# whichever the walk reaches first.
function Find-LibiFile($suffix) {
  $leaf = Split-Path $suffix -Leaf
  Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Filter $leaf -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'nagellabs' -and $_.FullName.EndsWith($suffix) } |
    Select-Object -First 1
}

# The node MSI edited the MACHINE PATH after this session's environment was
# captured, so re-read it or `npx` is simply not found.
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH", "User")

# Any previous run still holds $Port and would make the checks interrogate a
# stale process against a freshly-wiped home.
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$root = "$env:USERPROFILE\qa\npx"
# A FRESH home, so Category A genuinely runs. Reusing one makes a second run
# look like a first one and turns a broken cold boot into a green tick.
$libiHome = "$root\home"
Remove-Item $libiHome -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $libiHome -Force | Out-Null
$env:LIBI_HOME = $libiHome
# Opens /api/e2e/run-tool, which is how step 5's export fixture would be built.
# Default OFF for real users (RC-B) precisely because it can exec MCP tools.
$env:LIBI_ENABLE_TEST_ROUTES = "1"

$out = "$root\npx-stdout.log"
$err = "$root\npx-stderr.log"
$pkgDir = $null

Say "node $(node -v) / npm $(npm -v)"

if ($PatchUv -ne 0) {
  # Populate npx's cache without starting the studio. `-c` runs a command with
  # the package on PATH, so the download and unpack happen and nothing boots.
  Say "priming the npx cache so the package can be patched before it runs"
  Invoke-Noisy { & npx.cmd -y -p "@nagellabs/libi@$Version" -c "node -e 0" }

  # Match the REGISTRY bundled.js specifically. The package ships more than one
  # file by that name -- lib/fonts/bundled.js is the other -- and a bare
  # -Filter picked the fonts one, which of course had nothing to patch.
  $cached = Find-LibiFile 'registry\bundled.js'
  if (-not $cached) { throw "could not find the cached registry bundled.js to patch" }

  $before = Get-Content $cached.FullName -Raw
  $hits = ([regex]::Matches($before, 'uv-x86_64-pc-windows-msvc/uv\.exe')).Count
  if ($hits -eq 0) {
    # npx reuses its cache across runs, so a second run finds the first run's
    # patch already in place. Idempotent, not an error -- but only if the
    # FIXED string is what is actually there, so a genuinely wrong file (or a
    # version whose registry moved on) still fails loudly.
    $already = ([regex]::Matches($before, '"uv\.exe"')).Count
    if ($already -eq 0) { throw "neither the buggy nor the fixed uv path is in $($cached.FullName)" }
    Say "already patched ($already fixed entries) -- leaving it alone"
  } else {
    Say "patching $($cached.FullName) ($hits occurrences)"
    ($before -replace 'uv-x86_64-pc-windows-msvc/uv\.exe', 'uv.exe') |
      Set-Content $cached.FullName -NoNewline
    $after = ([regex]::Matches((Get-Content $cached.FullName -Raw), 'uv-x86_64-pc-windows-msvc/uv\.exe')).Count
    if ($after -ne 0) { throw "patch did not take" }
    Say "patch applied"
  }
}

Say "launching npx @nagellabs/libi@$Version --port $Port  (LIBI_HOME=$libiHome)"

# npx.cmd, not npx: only the .cmd shim is spawnable by CreateProcess on
# Windows -- npm writes three files per bin and the extensionless one is a
# shell script. This is the same shape as the .bin cmd-shim fix (23b23320).
$proc = Start-Process -FilePath "npx.cmd" `
  -ArgumentList "-y", "@nagellabs/libi@$Version", "--port", "$Port" `
  -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { Say "FAIL: the process exited early (code $($proc.ExitCode))"; break }
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/editor" -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep 10 }
}

$log = "$libiHome\logs\libi.log"

if (-not $ready) {
  Say "FAIL: /editor never returned 200 within $TimeoutMinutes min"
  Say "--- last stderr ---"
  Get-Content $err -Tail 15 -ErrorAction SilentlyContinue
  Say "--- last libi.log ---"
  Get-Content $log -Tail 10 -ErrorAction SilentlyContinue
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  throw "npx studio did not come up"
}

Say "1-3 OK: /editor -> 200"
$failures = @()

Say "started (pid $($proc.Id)) -- run win-npx-checks.ps1 next"
