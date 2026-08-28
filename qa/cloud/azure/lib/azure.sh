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
# Layer (1) exists here too: lab.sh sets an EXIT/INT/TERM trap around the
# create→arm window, and `up` re-arms an existing VM unconditionally, so a
# re-run repairs a VM whose arming was ever missed. See lab.sh around
# arm_auto_shutdown for the full story, including the residual kill -9 window.
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
# CONFIG. The subscription id is NOT committed — this repo is public. It comes
# from $LIBI_AZ_SUBSCRIPTION, usually set by qa/cloud/azure/azure.local.sh, and
# it is REQUIRED: every `az` call in this rig is pinned to it by the az()
# wrapper below. There is deliberately NO fall-through to the CLI's default
# subscription — `az login` and `az account set` change that default silently,
# and this tooling spends real money, so "whatever az currently points at" is
# exactly the wrong account to bill by accident. Even reads are pinned: a
# `status` against the wrong subscription says "the lab costs nothing" while
# VMs bill in the right one.
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

# swedencentral is not an arbitrary pick. A lab region must clear FOUR bars —
# accept new customers, offer the LIBI_AZ_*_SIZE VM size, host the Windows 11
# client image, AND offer Microsoft.DevTestLab/schedules (auto-shutdown, the
# lab's only safety net — see az_require_auto_shutdown_region below). Tested
# 2026-08-22: westeurope (the previous default) refuses new customers outright,
# northeurope has no Standard_D4s_v5, israelcentral has no DevTestLab/schedules
# so auto-shutdown cannot exist there at all; swedencentral clears all four and
# was the cheapest of the ones tested ($0.388/hr Windows D4s_v5 vs $0.408 in
# israelcentral). The README's "Which region" section records the full story.
: "${LIBI_AZ_LOCATION:=swedencentral}"
: "${LIBI_AZ_GROUP:=libi-qa}"
: "${LIBI_AZ_VNET:=libi-qa-vnet}"
: "${LIBI_AZ_SUBNET:=libi-qa-subnet}"
: "${LIBI_AZ_NSG:=libi-qa-nsg}"
: "${LIBI_AZ_ADMIN:=libiqa}"
# ── THE WINDOWS ADMIN PASSWORD, WITHOUT A HUMAN AT THE PROMPT ─────────────
# `az vm create` offers the password NO argv-free input except its interactive
# prompt. Established against the installed CLI (2.89.1, 2026-08-22), source
# and probe both: --admin-password is a plain string argument — no environment
# variable, no @file expansion (contrast ssh_key_value, which has file_type),
# no config default — and with stdin piped az refuses outright ("Please
# specify password in non-interactive mode": knack's prompt_pass requires
# sys.stdin.isatty()). Putting the value in --admin-password argv would
# publish it to `ps` for every local process, which is exactly the exposure
# this lab's no-echo/no-store design exists to avoid — so argv is not an
# option, and the ONE safe unattended path is answering the prompt itself
# over a PTY, with the value read from the macOS Keychain BY THE PTY DRIVER
# (lib/keychain-pw.expect): Keychain -> expect's memory -> az's tty. It is
# never in argv, env, a file, shell history, this shell's variables, or the
# terminal transcript (getpass disables echo before prompting).
#
# Opt-in by existence: no matching Keychain entry — or no macOS `security`,
# as on Linux — and `up win` prompts interactively exactly as it always has.
: "${LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE:=libi-qa-win-rdp}"

# The operator keypair used to reach the Windows box over SSH. Only the PUBLIC
# half is ever sent anywhere; the private key stays on this machine and is
# never read by any script here.
: "${LIBI_AZ_SSH_KEY:=$HOME/.ssh/libi-qa-azure}"
: "${LIBI_AZ_WIN_PW_KEYCHAIN_ACCOUNT:=$LIBI_AZ_ADMIN}"
# Deallocate daily as the safety net. HHmm in UTC — `az vm auto-shutdown
# --time` takes UTC only, there is no timezone parameter. 1900 UTC is 21:00
# CEST / 20:00 CET: late enough not to kill a working session, early enough to
# catch "I forgot about that VM". If you override this, convert YOUR local
# time to UTC yourself.
: "${LIBI_AZ_SHUTDOWN_TIME:=1900}"

# How long `lab.sh up` waits for resource-provider registration on a fresh
# subscription before giving up. Registration is Azure-side and asynchronous —
# `az provider register` returns while the provider is still 'Registering' —
# and typically takes 1–5 minutes per provider (they register in parallel).
: "${LIBI_AZ_PROVIDER_WAIT_SECS:=900}"

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
# on 2026-08-21 (prices.azure.com; re-check before quoting these). The default
# region has since moved to swedencentral, where the one rate re-checked on
# 2026-08-22 was slightly BETTER (Windows D4s_v5 $0.388/hr vs 0.414) — the
# table keeps the westeurope figures as sampled:
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
# the 345 MB adapter, whisper small 480 MB, Kokoro 124 MB, tracking pyenv+models
# ~2.8 GB) plus the ~1.6 GB Electron install and room for media.
#
# Azure defaults `s`-suffixed sizes to PREMIUM SSD, which is the expensive
# mistake here: 128 GB Premium (P10) is $21.68/mo to leave sitting, versus
# $9.60/mo for the same size on Standard SSD (E10). QA workloads are not
# IOPS-bound — the bottleneck is downloading models over the network — so
# Standard SSD is chosen deliberately, not as a compromise.
#
# NOTE: `--os-disk-size-gb` can only GROW an image's disk, never shrink it —
# and Azure REJECTS a request below the image's own size rather than rounding
# it up. lab.sh clamps the request to the per-platform floor below before
# creating, and prints the disk actually provisioned afterwards, so the billed
# size is measured rather than assumed.
: "${LIBI_AZ_DISK_GB:=64}"
: "${LIBI_AZ_DISK_SKU:=StandardSSD_LRS}"

# The image OS-disk floors the clamp uses. Discovering these from the image
# would beat constants, but `az vm image show` no longer reports an OS-disk
# size for these images (osDiskImage.sizeInGb came back null against the real
# subscription, CLI 2026-08-22), so there is nothing cheap to ask at run time.
#   - win11-24h2-pro ships a 127 GiB OS disk (verified in the 2026-08-21
#     preflight against the real subscription; every MicrosoftWindowsDesktop
#     client SKU to date has shipped 127 GiB). 127 GiB on Standard SSD is the
#     E10 tier, ~$9.60/mo idle — double the ~$4.80/mo of the intended 64 GB.
#   - Ubuntu2404 (Canonical 24.04 LTS server) ships a 30 GiB OS disk, so the
#     64 GB default is a genuine grow there and is preserved as-is.
# If a new image SKU ships a bigger disk, `az vm create`'s rejection message
# states the image size — update the floor from that message.
: "${LIBI_AZ_WIN_DISK_FLOOR_GB:=127}"
: "${LIBI_AZ_LINUX_DISK_FLOOR_GB:=30}"

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

# az is SHADOWED on purpose: every call in lab.sh and this file routes through
# here, so nothing can hit whatever subscription the CLI happens to default to.
# `--subscription` is a global az argument, valid on every command we use, and
# appending it wins over `az account set`. New call sites are pinned for free.
# Use `command az` if you genuinely need the raw CLI — and know why you do.
az() {
  [ -n "${LIBI_AZ_SUBSCRIPTION:-}" ] || az_die "LIBI_AZ_SUBSCRIPTION is not set.
This rig refuses to bill \"whatever subscription az currently defaults to\":
  cp qa/cloud/azure/azure.local.sh.example qa/cloud/azure/azure.local.sh
and put the intended subscription id in it."
  command az "$@" --subscription "$LIBI_AZ_SUBSCRIPTION"
}

az_require_cli() {
  # `type -P` searches PATH only — `command -v` would be fooled by the az()
  # wrapper above, which exists whether or not the CLI is installed.
  type -P az >/dev/null 2>&1 \
    || az_die "the Azure CLI is not on PATH. Install it, then \`az login\`."
  az account show >/dev/null 2>&1 \
    || az_die "not logged in, or the configured LIBI_AZ_SUBSCRIPTION is not visible
to this account — run \`az login\` yourself (it is a credential step), then
check \`az account list\` includes the subscription in azure.local.sh."
}

az_subscription() {
  # Hard requirement, same as the az() wrapper — see the CONFIG note up top.
  [ -n "${LIBI_AZ_SUBSCRIPTION:-}" ] \
    || az_die "LIBI_AZ_SUBSCRIPTION is not set — copy azure.local.sh.example to azure.local.sh"
  printf '%s' "$LIBI_AZ_SUBSCRIPTION"
}

az_vm_name() {
  case "$1" in
    win)   printf 'libi-qa-win' ;;
    linux) printf 'libi-qa-linux' ;;
    *)     az_die "unknown platform: $1 (want: win | linux)" ;;
  esac
}

# The NSG source. Fails loudly rather than silently widening to the world.
# IPv4 ONLY, forced twice (-4 and the v4-only api.ipify.org endpoint): the
# NSG rule is written as <ip>/32, so an IPv6 answer — which api64.ipify.org
# returns on any v6-capable network — would produce an inert rule and a
# silent lockout. The shape check below is the backstop for a proxy or
# captive portal handing back something that is not an address at all.
az_my_ip() {
  local ip
  ip="$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  case "$ip" in
    *[!0-9.]*|"") az_die "could not determine this machine's public IPv4 address — refusing to
create a rule, because the only alternative is opening the port to 0.0.0.0/0." ;;
  esac
  printf '%s' "$ip"
}

# Is the unattended Windows-password path available? All three must hold:
# macOS's `security` (absent on Linux — fall back to prompting, never error),
# `expect` (ships with macOS), and a MATCHING Keychain entry. The existence
# check deliberately omits -w: a metadata search does not read the secret
# data, so deciding which path to take cannot itself raise the
# keychain-access dialog — that happens at most once, inside the expect
# script, at the moment the value is actually needed.
az_win_pw_keychain_ready() {
  type -P security >/dev/null 2>&1 || return 1
  type -P expect >/dev/null 2>&1 || return 1
  security find-generic-password -a "$LIBI_AZ_WIN_PW_KEYCHAIN_ACCOUNT" \
    -s "$LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE" >/dev/null 2>&1
}

# `az vm create "$@"`, with the Admin Password prompts answered from the
# Keychain. See the LIBI_AZ_WIN_PW_KEYCHAIN_* block above for why a PTY is the
# only argv-free mechanism az has. The password flows Keychain -> expect ->
# az's tty and touches NOTHING else: not this shell (xtrace-safe — bash never
# holds it), not argv, not the environment (LAB_KC_* carry the entry's NAMES),
# not any file, and not any message either side prints on failure. expect
# spawns the real CLI rather than the az() function, so the wrapper's
# subscription pinning is reproduced here by appending --subscription — keep
# that if you touch this.
az_vm_create_with_keychain_pw() {
  local sub rc=0
  sub="$(az_subscription)"
  LAB_KC_SERVICE="$LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE" \
  LAB_KC_ACCOUNT="$LIBI_AZ_WIN_PW_KEYCHAIN_ACCOUNT" \
    expect "$HERE_AZ/keychain-pw.expect" \
      az vm create "$@" --subscription "$sub" || rc=$?
  case "$rc" in
    0)  return 0 ;;
    70) az_die "az never showed its password prompt, so nothing was sent to it — but the
create may have started. Check 'lab.sh status'; re-running 'lab.sh up win' is
safe (it repairs an existing VM instead of recreating it)." ;;
    71) az_die "az vm create exited before asking for a password — its own error is above." ;;
    72) az_die "the Keychain entry '$LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE' could not be READ
(access denied at the keychain prompt, or the entry vanished since the check).
Nothing was sent to az. Approve the access dialog and re-run, or delete the
entry to go back to the interactive prompt." ;;
    *)  return "$rc" ;;
  esac
}

az_group_exists() {
  az group exists --name "$LIBI_AZ_GROUP" -o tsv 2>/dev/null | grep -q true
}

# The ARM location the resource group ACTUALLY lives in — which is fixed at
# creation and can silently disagree with $LIBI_AZ_LOCATION if the config
# changed after the group was made. Empty when the group is absent/unreadable.
az_group_location() {
  az group show --name "$LIBI_AZ_GROUP" --query location -o tsv 2>/dev/null
}

# ── CAN AUTO-SHUTDOWN EXIST IN THIS REGION? ────────────────────────────────
#
# `az vm auto-shutdown` creates a Microsoft.DevTestLab/schedules resource, and
# NOT EVERY REGION HOSTS THAT RESOURCE TYPE. This is the distinction that bit:
# REGISTERING Microsoft.DevTestLab as a provider (subscription-wide, checked by
# ensure_providers) is NOT the same thing as the provider OFFERING `schedules`
# in a given location (Azure's own deployment footprint, per resource type).
# israelcentral passed every check the tooling had — new-customer acceptance,
# VM size, image entitlement, quota, registered providers — and then failed
# arming with LocationNotAvailableForResourceType AFTER the VM existed
# (2026-08-22; the EXIT trap deallocated it). In such a region the lab's core
# safety guarantee — the daily deallocate that bounds a forgotten VM — cannot
# exist AT ALL, so region capability is a precondition checked before anything,
# even the free scaffold, is created.
#
# The location list is asked of Azure every time rather than hardcoded — the
# footprint drifts. Two shape facts these helpers depend on, verified against
# the real CLI on 2026-08-22:
#   - the provider query returns DISPLAY names ("Sweden Central"), while
#     $LIBI_AZ_LOCATION is an ARM name ("swedencentral"); `az account
#     list-locations` is the authoritative map between the two;
#   - provider metadata is readable even while the provider is NotRegistered,
#     so `doctor` gets a real verdict before ensure_providers has run.

# All regions offering DevTestLab/schedules, as DISPLAY names, one per line.
az_devtestlab_schedule_locations() {
  az provider show --namespace Microsoft.DevTestLab \
    --query "resourceTypes[?resourceType=='schedules'].locations | [0]" -o tsv 2>/dev/null
}

# DISPLAY name for $LIBI_AZ_LOCATION; empty if the cloud has no such region.
# Deliberately `command az`, one of the rare justified bypasses of the az()
# wrapper: `az account` subcommands REJECT the global --subscription argument
# the wrapper appends ("unrecognized arguments", CLI 2026-08-22), and region
# metadata is cloud-level, not subscription-level, so the billing-safety
# pinning the wrapper exists for genuinely does not apply here.
az_location_display_name() {
  command az account list-locations \
    --query "[?name=='$LIBI_AZ_LOCATION'].displayName | [0]" -o tsv 2>/dev/null
}

# The schedules-capable regions again, as ARM names (space-separated, sorted) —
# what an operator can actually paste into LIBI_AZ_LOCATION.
az_devtestlab_schedule_locations_arm() {
  {
    command az account list-locations --query "[].[name,displayName]" -o tsv 2>/dev/null
    az_devtestlab_schedule_locations | sed $'s/^/SCHED\t/'
  } | awk -F'\t' '
      $1 != "SCHED" { arm[$2] = $1; next }
      ($2 in arm)   { print arm[$2] }
    ' | sort | paste -s -d ' ' -
}

# One word on stdout: available | unavailable | unknown-location | unreadable.
# Never dies — doctor reports every state; az_require_auto_shutdown_region is
# the enforcing variant.
az_auto_shutdown_region_state() {
  local display list
  display="$(az_location_display_name || true)"
  if [ -z "$display" ]; then printf 'unknown-location'; return 0; fi
  list="$(az_devtestlab_schedule_locations || true)"
  if [ -z "$list" ]; then printf 'unreadable'; return 0; fi
  if printf '%s\n' "$list" | grep -Fxq "$display"; then
    printf 'available'
  else
    printf 'unavailable'
  fi
}

az_require_auto_shutdown_region() {
  case "$(az_auto_shutdown_region_state)" in
    available) return 0 ;;
    unknown-location)
      az_die "'$LIBI_AZ_LOCATION' is not a region this cloud knows (az account
list-locations has no such name). Check LIBI_AZ_LOCATION in azure.local.sh —
it takes ARM names like 'swedencentral', not display names like 'Sweden Central'." ;;
    unreadable)
      az_die "could not read Microsoft.DevTestLab's region list from Azure, so there is
no way to confirm '$LIBI_AZ_LOCATION' can host auto-shutdown schedules — the
lab's only safety net. Refusing to build a lab whose safety net is unverified.
This is usually transient (network, az login) — re-run in a moment." ;;
    unavailable)
      az_die "region '$LIBI_AZ_LOCATION' does not offer Microsoft.DevTestLab/schedules —
the resource type behind 'az vm auto-shutdown'. Without it the daily
deallocate safety net CANNOT EXIST, and a forgotten VM would bill compute
indefinitely, so the lab refuses to build anything there (israelcentral failed
exactly this way on 2026-08-22, after every other check passed).
Set LIBI_AZ_LOCATION in azure.local.sh to a region that has it, e.g.:
  $(az_devtestlab_schedule_locations_arm)
(and check your pick also clears the other three bars — new-customer
acceptance, VM size, Windows 11 image; see the README's 'Which region')." ;;
  esac
}
