# Runs ON the Windows QA VM via `lab.sh ssh-setup win`, which PREPENDS a
# `$PublicKey = '...'` line before sending this. It is not a param() block
# because az delivers run-command parameters as `-Name value` and an OpenSSH
# public key contains spaces, which would arrive as three separate arguments.
#
# Why bother, when run-command already executes scripts here: run-command is a
# terrible interactive channel. It truncates output near 4 KB, it is bounded by
# the RunCommandWindows extension's provisioning timeout (a script that boots
# libi and waits on it blows straight through), and a client killed mid-call
# leaves the VM answering every later invocation with Conflict -- which cost a
# rebuild of the whole resource group to clear. SSH has none of those
# properties.
#
# On the credential rule: what lands here is a PUBLIC key. It authorises the
# operator's laptop; it grants nothing to anyone holding it, and it cannot be
# used to reach anything else. The private half never leaves the Mac. That is
# categorically different from an API token or a signed-in CLI, which is what
# "no credentials on QA VMs" exists to prevent. Port 22 is already open to the
# operator's IP alone -- the NSG rule allow-operator has always covered it.
#
# Idempotent: safe to re-run on a box that already has sshd.

$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "[enable-ssh] $m" }

if (-not $PublicKey) { throw "no public key was prepended -- run this via 'lab.sh ssh-setup win'" }

Say "installing the OpenSSH Server capability (absent on this image by default)"
$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Where-Object { $_.State -ne "Installed" }
if ($cap) { Add-WindowsCapability -Online -Name $cap.Name | Out-Null; Say "installed $($cap.Name)" }
else { Say "already installed" }

Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Say "sshd running: $((Get-Service sshd).Status)"

# Add-WindowsCapability creates OpenSSH-Server-In-TCP scoped to the PRIVATE
# profile, and an Azure NIC is classified PUBLIC -- so inbound 22 is dropped
# even though sshd is listening, the NSG allows the port, and the rule reports
# Enabled=True. The symptom is a bare "Operation timed out" with nothing wrong
# anywhere you would think to look.
$fw = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($fw) {
  Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -Profile Any -Enabled True
  Say "firewall rule scoped to Any (was: $($fw.Profile); this NIC is $((Get-NetConnectionProfile).NetworkCategory))"
} else {
  # Older images ship no rule at all rather than a mis-scoped one.
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH SSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any | Out-Null
  Say "firewall rule created (none existed)"
}

# PowerShell rather than cmd.exe, so a non-interactive `ssh box '<command>'`
# behaves like the run-command scripts this replaces.
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -PropertyType String -Force | Out-Null
Say "default shell set to powershell.exe"

# An ADMIN user's keys go in administrators_authorized_keys, NOT
# ~/.ssh/authorized_keys -- sshd_config on Windows ships a Match Group
# administrators block that redirects there, and a key in the home directory is
# silently ignored for admins. This is the single most common reason Windows
# key auth "just does not work".
$akFile = "$env:ProgramData\ssh\administrators_authorized_keys"
$existing = ""
if (Test-Path $akFile) { $existing = Get-Content $akFile -Raw }
if ($existing -notmatch [regex]::Escape($PublicKey.Trim())) {
  Add-Content -Path $akFile -Value $PublicKey.Trim()
  Say "key appended"
} else {
  Say "key already present"
}

# sshd REFUSES to read that file unless it is owned by Administrators/SYSTEM
# with inheritance off -- and it fails closed and silently, falling back to
# password auth. Set the ACL explicitly.
icacls $akFile /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
Say "acl set on $akFile"

Restart-Service sshd
Say "sshd restarted -- ssh should now work with the operator key"
