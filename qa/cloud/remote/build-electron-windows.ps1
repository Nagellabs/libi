# Runs ON the Windows QA VM. Builds the NSIS installer from an uploaded
# working-tree tarball.
#
# Started detached by the caller, because `npm ci` + `next build` +
# build-runtime-bundle + electron-builder is a 20-40 minute job and an SSH
# session that drops mid-build would take the build with it.
#
# Everything is logged with timestamps so a poll can tell "still compiling"
# from "wedged" without re-running anything.

param(
  [string]$SrcTgz = "$env:USERPROFILE\libi-src.tgz",
  [string]$BuildDir = "$env:USERPROFILE\build"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Step($m) { Write-Host "`n[build $(Get-Date -Format HH:mm:ss)] $m" -ForegroundColor Magenta }

# The MSI/EXE installers edited the MACHINE PATH after this session's env was
# captured, so re-read it or `node` is not found.
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH", "User")

Step "unpack $SrcTgz -> $BuildDir"
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Path $BuildDir | Out-Null
# Windows 10+ ships bsdtar as tar.exe, which handles .tgz natively — no need
# for 7-Zip or a two-step gunzip.
tar -xzf $SrcTgz -C $BuildDir
if ($LASTEXITCODE -ne 0) { throw "tar extraction failed ($LASTEXITCODE)" }
Set-Location $BuildDir
Write-Host "  package.json version: $(node -p "require('./package.json').version")"

Step "npm ci"
# Not `npm install`: the lockfile is the point. A resolution that drifts on the
# QA box means we tested something other than what ships.
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }

Step "npm run build:electron"
# electron-builder is NOT given an explicit --win: electron-builder.yml already
# declares the nsis target and defaults to the host platform, which here IS
# win32. Passing it explicitly would diverge from what the release script does.
npm run build:electron
if ($LASTEXITCODE -ne 0) { throw "build:electron failed ($LASTEXITCODE)" }

Step "artifacts"
if (Test-Path "$BuildDir\release") {
  Get-ChildItem "$BuildDir\release" | Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,1)}} | Format-Table
} else {
  Write-Host "  NO release DIRECTORY — the build produced nothing"
}

Step "done"
