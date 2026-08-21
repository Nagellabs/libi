# GCE `windows-startup-script-ps1` for the Windows QA VM.
#
# Runs on every boot, before anything else can reach the machine. Its only job
# is to make `gcloud compute ssh` possible at all.
#
# `enable-windows-ssh=TRUE` makes the guest agent provision SSH keys from
# instance metadata — but it CONFIGURES sshd, it does not INSTALL it, and the
# windows-2025 image ships without OpenSSH Server. The symptom is silent: the
# instance reports RUNNING and healthy, the agent logs
#   "Could not determine if openssh version is compatible: … SYSTEM\
#    CurrentControlSet\Services\sshd"
# on every boot, and every ssh attempt dies with exit 255.
#
# Idempotent: re-running on a later boot finds the capability already present
# and simply ensures the service is up.

$ErrorActionPreference = "Stop"

try {
  $cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" |
         Where-Object { $_.State -ne "Installed" }
  if ($cap) {
    Add-WindowsCapability -Online -Name $cap.Name
  }

  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd

  # The agent decides at STARTUP whether sshd is usable, and on a FIRST boot it
  # has already made that call — and logged
  #   "Could not determine if openssh version is compatible"
  # — before this script installed anything. Bounce it so its SSH setup re-runs
  # against an sshd that now exists.
  #
  # The service name is not stable across image generations: older images use
  # `GCEAgent`, windows-2025 runs a plugin architecture logging as
  # `GCEGuestAgentManager` / `CorePlugin`. Restarting only `GCEAgent` silently
  # does nothing there, the keys never land, and ssh fails with a bare exit 255
  # on a machine that looks perfectly healthy — observed 2026-08-16.
  foreach ($svc in @("GCEAgent", "GCEGuestAgentManager", "GCEWindowsAgent")) {
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
      Restart-Service -Name $svc -Force -ErrorAction SilentlyContinue
      Write-Output "restarted $svc"
    }
  }

  Write-Output "OpenSSH Server installed and sshd started"
} catch {
  # Do not let a failure here block boot — it would leave the instance with no
  # working access path at all, and the serial log is where this gets read.
  Write-Output "enable-ssh startup script failed: $_"
}
