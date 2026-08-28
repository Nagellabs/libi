# Runs ON the Windows QA VM. Idempotent. OPT-IN, and separate from
# windows.ps1 on purpose.
#
# windows.ps1 installs only what RUNNING libi needs, deliberately: the whole
# point of the rig is to watch libi provision its own dependencies, and a
# pre-installed ffmpeg would turn a real finding into a false pass. Building
# the Electron shell is a different job with a much heavier toolchain, and
# most QA sessions never need it.
#
# Why it is needed at all: `electron-builder install-app-deps` rebuilds native
# modules against Electron's ABI. better-sqlite3 finds a prebuild and is done
# in seconds; node-pty does NOT, so node-gyp compiles it from source and needs
# Python plus the MSVC C++ toolchain. Without them `npm ci` dies with
#
#   Error: Could not find any Python installation to use
#     at PythonFinder.fail (node_modules/node-gyp/lib/find-python.js)
#
# GitHub's windows-2022 runner ships both preinstalled, which is why CI builds
# succeed on a machine nobody provisioned — and why this gap stayed invisible
# until the first build on our own box.
#
# Budget ~15-25 minutes and ~5 GB the first time. Re-running is fast.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Step($m) { Write-Host "`n[build-tools] $m" -ForegroundColor Magenta }

$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH", "User")

Step "python"
# Direct MSI/EXE rather than winget, matching windows.ps1's reasoning: fewer
# moving parts than bootstrapping App Installer on a fresh image.
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  $py = "$env:TEMP\python-installer.exe"
  Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" -OutFile $py
  # InstallAllUsers so node-gyp finds it regardless of which account builds.
  Start-Process $py -ArgumentList "/quiet","InstallAllUsers=1","PrependPath=1","Include_test=0" -Wait
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Host "  python $(python --version 2>&1)"

Step "visual studio build tools (C++)"
# VCTools is the workload node-gyp needs. This is the slow part.
#
# The Spectre component is NOT optional and NOT covered by
# --includeRecommended. node-pty's vcxproj sets SpectreMitigation, so MSBuild
# refuses the whole rebuild without it:
#
#   error MSB8040: Spectre-mitigated libraries are required for this project.
#   [node_modules\node-pty\build\conpty.vcxproj]
#
# GitHub's windows-2022 runner ships them, so CI never sees this — it only
# appears on a box someone provisioned by hand.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$SPECTRE = "Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre"
$VCTOOLS = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"

function Has-Component($id) {
  if (-not (Test-Path $vswhere)) { return $null }
  $p = & $vswhere -products * -requires $id -property installationPath 2>$null
  if ($p) { return $p } else { return $null }
}

$vcPath      = Has-Component $VCTOOLS
$spectrePath = Has-Component $SPECTRE

if ($vcPath -and $spectrePath) {
  Write-Host "  already complete: $vcPath"
} else {
  $bt = "$env:TEMP\vs_BuildTools.exe"
  if (-not (Test-Path $bt)) {
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $bt
  }
  # VS2022 (v17), not "latest": node-gyp 11.5.0 -- what the lockfile carries --
  # cannot detect Visual Studio 2026 at all, which is the same reason
  # build-windows.yml pins its runner to windows-2022 rather than
  # windows-latest.
  if ($vcPath) {
    # Already installed but missing a component: modify in place. A plain
    # --add install against an existing installation is a no-op.
    Write-Host "  adding missing components to $vcPath"
    Start-Process $bt -ArgumentList `
      "modify","--installPath","`"$vcPath`"",
      "--add",$VCTOOLS,"--add",$SPECTRE,
      "--quiet","--wait","--norestart","--nocache" -Wait
  } else {
    Write-Host "  installing VCTools + Spectre libraries"
    Start-Process $bt -ArgumentList `
      "--quiet","--wait","--norestart","--nocache",
      "--add",$VCTOOLS,"--add",$SPECTRE,
      "--includeRecommended" -Wait
  }
  Write-Host "  installed"
}

Step "verify node-gyp can see them"
Write-Host "  python: $(if (Get-Command python -ErrorAction SilentlyContinue) { (Get-Command python).Source } else { 'MISSING' })"
Write-Host "  msvc:    $(if (Has-Component $VCTOOLS) { Has-Component $VCTOOLS } else { 'MISSING' })"
Write-Host "  spectre: $(if (Has-Component $SPECTRE) { 'present' } else { 'MISSING -- node-pty will fail with MSB8040' })"

Step "done"
