# Runs ON the Windows QA VM (PowerShell). Idempotent.
#
# Installs only what BUILDING and RUNNING libi needs. Deliberately NOT ffmpeg,
# ffprobe, uv or Chromium: libi provisions those itself in Category A, and that
# provisioning is exactly what this rig exists to test. A winget-installed
# ffmpeg on PATH would mask a broken download and turn a real finding into a
# false pass — which is precisely how the Linux drawtext bug (F5) survived.

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n[provision] $m" -ForegroundColor Magenta }

# Windows Server images ship with IE-mode security prompts that break silent
# downloads, and a progress bar that makes Invoke-WebRequest ~10x slower.
$ProgressPreference = "SilentlyContinue"

Step "node"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  # winget is not present on Server images without the App Installer package,
  # so fetch the MSI directly — fewer moving parts than bootstrapping winget.
  $nodeMsi = "$env:TEMP\node.msi"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.20.0/node-v22.20.0-x64.msi" -OutFile $nodeMsi
  Start-Process msiexec.exe -ArgumentList "/i", $nodeMsi, "/quiet", "/norestart" -Wait
  # The installer edits the MACHINE PATH; this process still has the old one.
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Host "  node $(node -v)"
Write-Host "  npm  $(npm -v)"

Step "git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  $gitExe = "$env:TEMP\git.exe"
  Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe" -OutFile $gitExe
  # /VERYSILENT is Inno Setup's; NOCANCEL+NORESTART keep it non-interactive.
  Start-Process $gitExe -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-" -Wait
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Host "  git $(git --version)"

Step "environment"
Write-Host "  os      $((Get-CimInstance Win32_OperatingSystem).Caption)"
Write-Host "  version $((Get-CimInstance Win32_OperatingSystem).Version)"
Write-Host "  arch    $env:PROCESSOR_ARCHITECTURE"
Write-Host "  cpus    $env:NUMBER_OF_PROCESSORS"
Write-Host "  memory  $([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)) GB"
Write-Host "  disk    $([math]::Round((Get-PSDrive C).Free/1GB,1)) GB free"
Write-Host "  shell   $($PSVersionTable.PSVersion)"

Step "done"
