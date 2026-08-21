#!/usr/bin/env bash
#
# Shared Azure helpers for libi's on-demand QA lab.
#
# WHY AZURE AND NOT GCE. One specific reason, not a preference: `gcloud compute
# ssh` never reached a Windows instance across four boots — the guest agent
# version-checks sshd's ImagePath, gets an empty string, and never provisions
# keys (diagnosed in qa/cloud/lib/gce.sh). Azure reaches Windows over RDP and
# WinRM without that. Everything else about the GCE rig's design was right and
# is deliberately copied here.
#
# ── THE TEARDOWN CONTRACT — read before changing anything ──────────────────
#
# The GCE rig's hardest-won rule: an EXIT trap is NOT a teardown guarantee. A
# killed terminal, a crashed laptop or `kill -9` skips it and leaves an instance
# billing indefinitely. It therefore had TWO independent guarantees, and the
# second is the one that actually held:
#   1. an EXIT trap in the calling script, and
#   2. `--max-run-duration` + `--instance-termination-action=DELETE` — the CLOUD
#      deleting the VM even if this laptop is at the bottom of a river.
#
# AZURE HAS NO EQUIVALENT OF (2). There is no per-VM "delete yourself after N
# hours". This rig substitutes the nearest thing, and it is WEAKER — stated
# plainly rather than papered over:
#   2a. `az vm auto-shutdown` — a schedule that DEALLOCATES the VM at a fixed
#       time daily. Deallocation stops COMPUTE billing, the overwhelming
#       majority of the cost. It does NOT delete the disk.
#   2b. Everything lives in ONE resource group, so `down` is a single
#       `az group delete` removing VM, disk, NIC, public IP, NSG and VNet
#       together — no orphan hunting, which is how cloud rigs leak disks.
#
# The consequence you must know: a forgotten VM costs its DISK (single-digit
# dollars/month), not its compute. Bounded and survivable, unlike a forgotten
# running VM. `lab.sh status` makes checking one command.
#
# ── ACCESS ────────────────────────────────────────────────────────────────
# Inbound is restricted to the operator's CURRENT public IP, never 0.0.0.0/0 —
# the same posture as the GCE rig's IAP-only ingress, reached differently
# because Azure Bastion costs more per hour than these VMs do. If your IP moves
# (new network, VPN), re-run `lab.sh allow-my-ip`.
#
# ── NO CREDENTIALS ON THESE MACHINES, EVER ────────────────────────────────
# Inherited verbatim from the GCE rig and not negotiable. `gh` auth is a
# credential; so is an npm token, a cloud login, FAL_KEY, ELEVENLABS_API_KEY,
# ANTHROPIC_API_KEY. The VM builds, artifacts come back here, uploads happen
# where the token already lives. That is exactly why
# `scripts/release-electron-platform.js` splits `--build` from `--attach`.
#
# CONFIG. The subscription id is NOT committed — this repo is public. Resolved
# from: $LIBI_AZ_SUBSCRIPTION → qa/cloud/azure/azure.local.sh → the CLI default.
#
# Written for bash 3.2 (what macOS ships): no associative arrays, no ${var^^},
# and ${arr[@]+"${arr[@]}"} for possibly-empty arrays under `set -u`. Source
# from bash, never zsh — BASH_SOURCE is a bashism.
set -euo pipefail

HERE_AZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$HERE_AZ/../azure.local.sh" ]; then
  # shellcheck disable=SC1091
  . "$HERE_AZ/../azure.local.sh"
fi

: "${LIBI_AZ_LOCATION:=westeurope}"
: "${LIBI_AZ_GROUP:=libi-qa}"
: "${LIBI_AZ_VNET:=libi-qa-vnet}"
: "${LIBI_AZ_SUBNET:=libi-qa-subnet}"
: "${LIBI_AZ_NSG:=libi-qa-nsg}"
: "${LIBI_AZ_ADMIN:=libiqa}"
# Deallocate daily as the safety net. 19:00 local: late enough not to kill a
# working session, early enough to catch "I forgot about that VM".
: "${LIBI_AZ_SHUTDOWN_TIME:=1900}"
: "${LIBI_AZ_TIMEZONE:=W. Europe Standard Time}"

# Sizing — the smallest box that still runs everything we intend to test.
#
# SCOPE DECISION: local MUSIC generation (ACE-Step) is deliberately OUT of
# scope for the lab. It wants ~14 GB free RAM and pulls 7.7 GB of weights, and
# it is the one heavy surface with no platform-specific risk — it is the same
# Python wheels everywhere. Excluding it is what lets this be a 16 GB box.
# Local TRACKING is explicitly IN scope: it is CPU-heavy, and it is exactly the
# kind of native/pyenv path that breaks per-platform.
#
# Why NOT burstable (B4ms is ~half the Windows hourly rate for the same
# 4 vCPU/16 GB): tracking is a sustained all-core load for 10-20 minutes, which
# is precisely what exhausts B-series credits. A throttled run would not fail
# outright, it would come back SLOW — and we would have no way to tell a real
# platform regression from a spent credit balance. Paying ~$0.21/hr more to
# remove that confound is the right trade for a rig whose entire purpose is
# trusting the result.
#
# Real pay-as-you-go rates, westeurope, pulled from the Azure retail price API
# on 2026-08-21 (prices.azure.com; re-check before quoting these):
#
#   size              vCPU/RAM   linux $/hr   windows $/hr
#   Standard_D4s_v5     4/16       0.230        0.414        <- chosen
#   Standard_B4ms       4/16       0.192        0.208        burstable, rejected
#   Standard_D2s_v5     2/8        0.115        0.207        too small
#
# An 8-hour session is therefore ~$3.31 Windows + ~$1.84 Linux. Compute is
# NOT where the money goes — idle disks are. See LIBI_AZ_DISK_SKU below.
: "${LIBI_AZ_WIN_SIZE:=Standard_D4s_v5}"
: "${LIBI_AZ_LINUX_SIZE:=Standard_D4s_v5}"

# Disk. Without music, libi's own footprint is ~10 GB (Chromium, ffmpeg, node,
# the 212 MB adapter, whisper small 480 MB, Kokoro 124 MB, tracking pyenv+models
# ~2.8 GB) plus the ~1.6 GB Electron install and room for media.
#
# Azure defaults `s`-suffixed sizes to PREMIUM SSD, which is the expensive
# mistake here: 128 GB Premium (P10) is $21.68/mo to leave sitting, versus
# $9.60/mo for the same size on Standard SSD (E10). QA workloads are not
# IOPS-bound — the bottleneck is downloading models over the network — so
# Standard SSD is chosen deliberately, not as a compromise.
#
# NOTE: `--os-disk-size-gb` can only GROW an image's disk, never shrink it.
# Windows marketplace images ship a large OS disk, so the Windows box will
# likely land at its image size regardless of what is set here. `lab.sh status`
# prints the disk actually created, so this is measured rather than assumed.
: "${LIBI_AZ_DISK_GB:=64}"
: "${LIBI_AZ_DISK_SKU:=StandardSSD_LRS}"

# Snapshot storage, for `lab.sh down --snapshot`. Standard HDD LRS snapshots are
# $0.05/GB/month and incremental snapshots bill only USED space — so a Windows
# box with ~50 GB used costs ~$2.50/mo to keep, against $9.60/mo for keeping its
# disk. That is what makes "delete the VMs, keep a restorable image" both the
# cheapest AND the fastest option. See the README's cost section.
: "${LIBI_AZ_SNAPSHOT_SKU:=Standard_LRS}"

# Windows 11 24H2 Pro confirmed available to this subscription 2026-08-21.
# Azure gates MicrosoftWindowsDesktop CLIENT images behind subscription
# eligibility and enforces it at DEPLOY time, not list time — so `doctor` probes
# with a real validation rather than trusting that the listing showed it.
: "${LIBI_AZ_WIN_IMAGE:=MicrosoftWindowsDesktop:windows-11:win11-24h2-pro:latest}"
: "${LIBI_AZ_WIN_FALLBACK_IMAGE:=Win2022Datacenter}"
: "${LIBI_AZ_LINUX_IMAGE:=Ubuntu2404}"

az_die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
az_note() { printf '  %s\n' "$*"; }

az_require_cli() {
  command -v az >/dev/null 2>&1 \
    || az_die "the Azure CLI is not on PATH. Install it, then \`az login\`."
  az account show >/dev/null 2>&1 \
    || az_die "not logged in — run \`az login\` yourself; it is a credential step."
}

az_subscription() {
  if [ -n "${LIBI_AZ_SUBSCRIPTION:-}" ]; then printf '%s' "$LIBI_AZ_SUBSCRIPTION"; return; fi
  local current
  current="$(az account show --query id -o tsv 2>/dev/null || true)"
  [ -n "$current" ] || az_die "no subscription set, and none in azure.local.sh"
  printf '%s' "$current"
}

az_vm_name() {
  case "$1" in
    win)   printf 'libi-qa-win' ;;
    linux) printf 'libi-qa-linux' ;;
    *)     az_die "unknown platform: $1 (want: win | linux)" ;;
  esac
}

# The NSG source. Fails loudly rather than silently widening to the world.
az_my_ip() {
  local ip
  ip="$(curl -fsS --max-time 10 https://api64.ipify.org 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "could not determine this machine's public IP — refusing to
create a rule, because the only alternative is opening the port to 0.0.0.0/0."
  printf '%s' "$ip"
}

az_group_exists() {
  az group exists --name "$LIBI_AZ_GROUP" -o tsv 2>/dev/null | grep -q true
}
