#!/usr/bin/env bash
#
# libi's on-demand QA lab on Azure: a Windows 11 box and an Ubuntu box you can
# raise for an afternoon and put away again.
#
#   qa/cloud/azure/lab.sh doctor           # preflight: CLI, login, quota, image eligibility
#   qa/cloud/azure/lab.sh scaffold         # providers + group + vnet + NSG; FREE, no VM
#   qa/cloud/azure/lab.sh up win           # create (or start) the Windows 11 VM
#   qa/cloud/azure/lab.sh up linux         # create (or start) the Ubuntu VM
#   qa/cloud/azure/lab.sh status           # what exists, what is running, what it costs
#   qa/cloud/azure/lab.sh stop win         # DEALLOCATE — stops compute billing, keeps the disk
#   qa/cloud/azure/lab.sh snapshot win     # keep a restorable image, cheaply
#   qa/cloud/azure/lab.sh down --keep-snapshots   # END OF SESSION: delete VMs, keep snapshots
#   qa/cloud/azure/lab.sh restore win      # rebuild from the snapshot, skipping provisioning
#   qa/cloud/azure/lab.sh down             # DELETE EVERYTHING (the whole resource group)
#   qa/cloud/azure/lab.sh allow-my-ip      # re-point the NSG at your current IP
#   qa/cloud/azure/lab.sh connect win      # print how to reach it (RDP / SSH)
#   qa/cloud/azure/lab.sh provision linux  # install build + Electron runtime deps
#   qa/cloud/azure/lab.sh exec win s.ps1   # run a script ON the box, get stdout back
#   qa/cloud/azure/lab.sh desktop linux    # add xfce+xrdp so you can SEE the Ubuntu box
#
# END OF A QA SESSION, the short version:
#
#     lab.sh snapshot win && lab.sh snapshot linux && lab.sh down --keep-snapshots
#
# That leaves ~$3/month of snapshot storage and nothing else, and the next
# session starts with `restore` instead of an hour of provisioning. Keeping the
# DISKS instead would cost ~$14.40/month for the same convenience.
#
# `stop` deallocates for a break within a session; `down --keep-snapshots` is
# the end-of-session command; bare `down` is for when the lab is finished for
# good. See lib/azure.sh's teardown contract for why these differ and which
# guarantee is weaker than the GCE rig's.
#
# NEVER put a credential on these machines — see lib/azure.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/azure.sh
. "$HERE/lib/azure.sh"

# Print the header comment block as the help text. Deliberately NOT a fixed
# line range: the previous `sed -n '3,20p'` silently truncated help the moment
# the header grew. Stop at the first line that is not a comment.
usage() { sed -n '3,$p' "$0" | sed -n '/^#/!q;p' | sed 's/^# \{0,1\}//'; }

# Every resource provider this rig touches, derived from the az calls in this
# file and lib/azure.sh — keep the list in sync when adding a resource type:
#   Microsoft.Compute    — az vm / az disk / az snapshot / run-command / list-usage
#   Microsoft.Network    — az network vnet / nsg / nic / public-ip
#   Microsoft.DevTestLab — `az vm auto-shutdown` creates a
#                          microsoft.devtestlab/schedules resource; on a virgin
#                          subscription arming FAILS without it, which would
#                          leave a VM running with no safety net at all.
#                          NOTE registration is necessary but NOT sufficient:
#                          the provider must also OFFER `schedules` in
#                          $LIBI_AZ_LOCATION — a per-region footprint question,
#                          checked separately by az_require_auto_shutdown_region
#                          (lib/azure.sh) before anything is created
#   Microsoft.Resources  — resource groups; registered by default on every
#                          subscription, listed so this list is the whole truth
LAB_REQUIRED_PROVIDERS="Microsoft.Compute Microsoft.Network Microsoft.DevTestLab Microsoft.Resources"

# Register whatever is missing, then WAIT until Azure says 'Registered'.
# Registration is ASYNCHRONOUS — `az provider register` returns while the
# state is still 'Registering', and using the provider before it lands fails —
# so this polls with a bounded deadline instead of sleeping blindly or trusting
# the return. It runs BEFORE anything is created: a virgin subscription must
# never get a resource group and then die on an unregistered provider halfway
# through `up`, which leaves state behind while still failing.
# On every run after the first this is a handful of cheap read calls and no
# wait at all.
ensure_providers() {
  local ns state missing="" pending deadline
  for ns in $LAB_REQUIRED_PROVIDERS; do
    state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
    [ "$state" = Registered ] || missing="$missing $ns"
  done
  [ -n "$missing" ] || return 0
  for ns in $missing; do
    az_note "registering resource provider $ns (one-time on a fresh subscription)"
    az provider register --namespace "$ns" -o none
  done
  deadline=$(( $(date +%s) + LIBI_AZ_PROVIDER_WAIT_SECS ))
  while :; do
    pending=""
    for ns in $missing; do
      state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
      [ "$state" = Registered ] || pending="$pending $ns"
    done
    if [ -z "$pending" ]; then
      az_note "all required resource providers are registered"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      az_die "gave up after ${LIBI_AZ_PROVIDER_WAIT_SECS}s waiting for provider registration:${pending}
Registration continues server-side — nothing has been created yet, and
re-running this command once it finishes is safe. Check progress with:
  az provider show --namespace <namespace> --query registrationState"
    fi
    az_note "waiting for:${pending} (server-side, typically 1-5 min; deadline ${LIBI_AZ_PROVIDER_WAIT_SECS}s)"
    sleep 15
  done
}

# A resource group's location is FIXED at creation, but ensure_scaffold
# returns early whenever the group exists — so changing LIBI_AZ_LOCATION under
# an existing group used to leave every later create silently landing in the
# OLD region, with nothing reporting the mismatch. Detect it and stop; what to
# do about it is the OPERATOR's call, never this script's — the existing group
# may hold a provisioned box worth an hour of setup, so nothing is deleted
# automatically.
ensure_group_location_matches() {
  local actual
  actual="$(az_group_location || true)"
  # Unreadable ≠ mismatched: if the read failed, the next real az call will
  # say why with its own error rather than a misleading drift verdict.
  [ -z "$actual" ] && return 0
  [ "$actual" = "$LIBI_AZ_LOCATION" ] && return 0
  az_die "resource group $LIBI_AZ_GROUP already exists in '$actual', but LIBI_AZ_LOCATION
is '$LIBI_AZ_LOCATION'. A group's location is fixed at creation, so the lab
would keep building in '$actual' while claiming '$LIBI_AZ_LOCATION'. Either:
  - keep the existing lab: set LIBI_AZ_LOCATION=$actual in azure.local.sh, or
  - move regions: run 'lab.sh down' to delete the '$actual' lab first (snapshots
    are regional and will NOT move with you), then re-run this command and the
    scaffold is rebuilt in '$LIBI_AZ_LOCATION'.
Nothing was changed or deleted — that choice is yours."
}

ensure_scaffold() {
  # Region capability FIRST — before providers, before the group, before
  # anything at all. It is a pure read, and it gates the whole design: in a
  # region without Microsoft.DevTestLab/schedules the auto-shutdown safety net
  # cannot exist, so even the FREE scaffold must not be built there. A scaffold
  # in such a region is not billable, but it silently sets up a lab that can
  # never be safe — the failure would then surface only after `up` created a
  # billable VM, which is exactly how israelcentral bit on 2026-08-22.
  az_require_auto_shutdown_region
  # Providers next, every time: cheap when already registered, and it also
  # repairs a lab whose group exists but whose DevTestLab registration was
  # missed by an older version of this script.
  ensure_providers
  if az_group_exists; then
    ensure_group_location_matches
    return
  fi
  az_note "resource group $LIBI_AZ_GROUP does not exist — creating the scaffold"
  az group create --name "$LIBI_AZ_GROUP" --location "$LIBI_AZ_LOCATION" -o none
  az network vnet create --resource-group "$LIBI_AZ_GROUP" --name "$LIBI_AZ_VNET" \
    --address-prefix 10.20.0.0/16 --subnet-name "$LIBI_AZ_SUBNET" \
    --subnet-prefix 10.20.1.0/24 -o none
  # Default-deny inbound is the Azure default; we only ever ADD a
  # single-source rule. There is deliberately no 0.0.0.0/0 rule anywhere.
  az network nsg create --resource-group "$LIBI_AZ_GROUP" --name "$LIBI_AZ_NSG" -o none
  allow_my_ip
}

allow_my_ip() {
  local ip; ip="$(az_my_ip)"
  az_note "restricting inbound to $ip/32 (RDP 3389 + SSH 22)"

  # Two things this has to survive, both seen for real on 2026-08-22.
  #
  # 1. The rule may already exist (a re-run after the operator's IP moved), in
  #    which case create fails and update is the right move.
  # 2. The NSG may have been created SECONDS ago by ensure_scaffold and not yet
  #    be visible to a rule create — ARM is eventually consistent. That is a
  #    transient, and the old code turned it into a baffling failure: it sent
  #    create's stderr to /dev/null and fell through to update, which then died
  #    with `NotFound` on a rule that had never existed. The message named the
  #    rule, so it read like a logic bug rather than a race.
  #
  # So: keep create's error, and only treat "already exists" as the update
  # case. Anything else is retried a few times, then reported AS ITSELF.
  local attempt err
  for attempt in 1 2 3 4 5; do
    if err="$(az network nsg rule create --resource-group "$LIBI_AZ_GROUP" \
      --nsg-name "$LIBI_AZ_NSG" --name allow-operator --priority 1000 \
      --source-address-prefixes "$ip/32" --destination-port-ranges 22 3389 \
      --access Allow --protocol Tcp --direction Inbound -o none 2>&1)"; then
      return 0
    fi
    case "$err" in
      *already\ exists*|*Conflict*|*RuleExists*)
        az network nsg rule update --resource-group "$LIBI_AZ_GROUP" \
          --nsg-name "$LIBI_AZ_NSG" --name allow-operator \
          --source-address-prefixes "$ip/32" -o none
        return 0 ;;
    esac
    [ "$attempt" -lt 5 ] || break
    az_note "nsg rule create failed (attempt $attempt/5) — retrying in ${attempt}s"
    sleep "$attempt"
  done
  az_die "could not add the operator NSG rule after 5 attempts. Azure said:
$err"
}

# Deallocate on a daily schedule. This is the ONLY thing standing between a
# forgotten VM and a month of compute billing — see lib/azure.sh. It is weaker
# than GCE's self-delete, and Azure gives `az vm create` no way to attach the
# schedule atomically — arming is unavoidably a SECOND call after create (an
# ARM template could bundle both resources in one deployment, but a deployment
# can still create the VM and then fail the schedule, so even that does not
# close the gap; it only relocates it). Three things keep the gap from being a
# hole someone falls through:
#   1. arming is the VERY NEXT call after `az vm create` returns — nothing
#      sits between them;
#   2. the EXIT/INT/TERM trap below covers the window: LAB_UNARMED_VM is set
#      just before create and cleared by arm_auto_shutdown, so a Ctrl-C or
#      crash in between arms — or failing that, deallocates — the VM on the
#      way out;
#   3. `up` re-arms an EXISTING VM unconditionally (the call is idempotent),
#      so a re-run REPAIRS a VM whose arming was ever missed instead of
#      ignoring it.
# Residual window, stated plainly rather than papered over: kill -9, power
# loss or a dead laptop DURING `az vm create` skips the trap while the ARM
# deployment completes server-side — that VM runs unarmed (~$10/day for the
# Windows box) until the next `up`, or until you notice via `lab.sh status`.
# No client-side design removes that case; it is why (3) exists.
arm_auto_shutdown() {
  local vm="$1"
  az vm auto-shutdown --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --time "$LIBI_AZ_SHUTDOWN_TIME" -o none
  LAB_UNARMED_VM=""
  az_note "auto-shutdown armed: deallocates daily at $LIBI_AZ_SHUTDOWN_TIME UTC"
}

# The trap half of the story above. LAB_UNARMED_VM is non-empty exactly while
# a VM may exist in Azure without its auto-shutdown schedule.
LAB_UNARMED_VM=""
lab_disarm_guard() {
  [ -n "${LAB_UNARMED_VM:-}" ] || return 0
  local vm="$LAB_UNARMED_VM"; LAB_UNARMED_VM=""
  printf '\n!! interrupted between "az vm create" and arming auto-shutdown for %s\n' "$vm" >&2
  if az vm auto-shutdown --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
       --time "$LIBI_AZ_SHUTDOWN_TIME" -o none 2>/dev/null; then
    printf '!! recovered: auto-shutdown armed (deallocates daily at %s UTC)\n' \
      "$LIBI_AZ_SHUTDOWN_TIME" >&2
  elif az vm deallocate --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
         --no-wait -o none 2>/dev/null; then
    printf '!! could not arm; deallocation requested instead — %s will not bill compute.\n' "$vm" >&2
    printf '!! re-run "lab.sh up" to start it; that also (re)arms auto-shutdown.\n' >&2
  else
    printf '!! could NOT arm or deallocate %s — it may still be mid-creation, and the\n' "$vm" >&2
    printf '!! deployment can complete server-side, leaving it RUNNING and UNARMED.\n' >&2
    printf '!! Run "lab.sh up <win|linux>" again (it repairs arming on an existing VM),\n' >&2
    printf '!! or check with "lab.sh status".\n' >&2
  fi
}
trap lab_disarm_guard EXIT
# Ctrl-C / SIGTERM do not run the EXIT trap on their own — route them into it.
trap 'exit 130' INT
trap 'exit 143' TERM

# Install what BUILDING and RUNNING libi needs. Reuses the provisioners written
# for the GCE rig verbatim — they turned out to contain no cloud-specific calls,
# and they carry details worth not re-deriving: Ubuntu 24.04's 64-bit time_t
# transition renamed libasound2 -> libasound2t64, libgtk-3-0 -> libgtk-3-0t64
# and friends, so every electron-on-linux guide written before 2024 lists
# package names that no longer resolve.
#
# They deliberately do NOT install ffmpeg, ffprobe, uv or Chromium. libi
# provisions those itself in Category A, and that provisioning is exactly what
# this rig exists to test — an apt-installed ffmpeg on PATH would mask a broken
# download URL and turn a real finding into a false pass. That is precisely how
# the Linux `drawtext` bug (F5) survived as long as it did.
provision() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh provision <win|linux>"
  local vm ip; vm="$(az_vm_name "$plat")"

  if [ "$plat" = linux ]; then
    # Only the Linux path reaches the box over the network, so only it needs an
    # address. Windows goes through the control plane, which addresses the VM by
    # NAME — demanding a public IP there would refuse a perfectly provisionable
    # machine (and one deliberately left without an IP is the safer shape).
    ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
    [ -n "$ip" ] || az_die "$vm has no public IP — is it up?"
    az_note "provisioning $vm (node 22, build toolchain, xvfb + electron runtime libs)"
    scp -o StrictHostKeyChecking=accept-new \
      "$HERE/../provision/ubuntu.sh" "$LIBI_AZ_ADMIN@$ip:/tmp/provision-ubuntu.sh"
    ssh -o StrictHostKeyChecking=accept-new "$LIBI_AZ_ADMIN@$ip" \
      "bash /tmp/provision-ubuntu.sh"
    az_note "xvfb is installed — the AppImage/deb can be booted headless with:"
    az_note "  LIBI_HOME=~/qa/home xvfb-run -a ./Libi-<v>.AppImage --no-sandbox"
  else
    # These images ship no sshd, but provisioning never needed ssh: windows.ps1
    # is non-interactive, so it goes through the same control-plane channel all
    # Windows QA uses (see exec_on below) — no SSH, no RDP, no open port and no
    # credential on the box. This branch used to tell you to RDP in and run it
    # by hand, which was a real cost for no benefit; verified 2026-08-22, node
    # + git installed on libi-qa-win with nobody at a screen.
    az_note "provisioning $vm (node 22 + git) via the Azure control plane"
    exec_on win "$HERE/../provision/windows.ps1"
    # Bootstrap the better channel while we are here. run-command's real job is
    # to make itself unnecessary: it truncates output near 4 KB, dies on the
    # extension's provisioning timeout, and a client killed mid-call wedges the
    # VM into answering Conflict forever -- which has now cost two full rebuilds
    # of the resource group. Non-fatal: a box without sshd is still usable via
    # run-command, just painfully.
    if [ -f "${LIBI_AZ_SSH_KEY}.pub" ]; then
      ssh_setup win || az_note "sshd setup failed -- falling back to run-command only"
    else
      az_note "no ${LIBI_AZ_SSH_KEY}.pub -- skipping sshd setup (see 'lab.sh ssh-setup win')"
    fi
  fi
}

# Run a script ON the VM and get its stdout back HERE.
#
# THIS IS HOW AUTOMATED QA IS DRIVEN, and it is worth understanding why it is
# not ssh. `az vm run-command invoke` goes through the AZURE CONTROL PLANE via
# the VM's guest agent: no SSH, no RDP, no open port, and — the part that
# matters — no key or credential on the QA machine. That is the same
# no-credentials rule the GCE rig had, satisfied without an inbound channel.
#
# It is what makes Windows QA scriptable at all. The packaged app exposes NO
# CDP (electron/main.ts gates it on isDev), so it cannot be driven with
# Playwright the way the dev shell can. What CAN be driven: install silently
# (NSIS accepts /S), launch it, then interrogate the app's own HTTP server and
# its logs — the port is published to $LIBI_HOME/port. All of that is a script,
# and this runs it.
#
# What it CANNOT do is see. SmartScreen's dialog, the installer's UX, and "does
# the terminal panel look right" need eyes on a screen — that is RDP, and it is
# the genuinely human half of the playbook. Do not pretend otherwise.
#
# Caveats: output is truncated around 4 KB, and there is a ~90-minute ceiling.
# Write scripts that print a verdict, not a transcript.
exec_on() {
  local plat="${1:-}" script="${2:-}"
  [ -n "$plat" ] && [ -n "$script" ] || az_die "usage: lab.sh exec <win|linux> <script-file> [name=value ...]"
  [ -f "$script" ] || az_die "no such script: $script"
  shift 2 || true
  # Anything left is a script parameter. az binds `name=value` to the matching
  # PowerShell `param()` entry BY NAME, which is why these are name=value and
  # not bare positionals.
  #
  # GOTCHA for the scripts on the other end: az renders each pair as
  # `-Name value`, and a [switch] consumes NO value, so its `value` falls
  # through and binds to whichever parameter is first in the param() block.
  # Declare boolean parameters as [bool], never [switch] -- `PatchUv=true`
  # against a [switch] silently set the FIRST parameter to "true" instead.
  # And pass booleans as `Name=1` / `Name=0`: every value arrives as a STRING,
  # and PowerShell will not coerce the string "true" to a boolean.
  local params=()
  if [ "$#" -gt 0 ]; then
    local kv
    for kv in "$@"; do
      case "$kv" in
        *=*) ;;
        *) az_die "script parameters must be name=value, got: $kv" ;;
      esac
      params+=("$kv")
    done
  fi
  local vm cmd; vm="$(az_vm_name "$plat")"
  if [ "$plat" = win ]; then cmd=RunPowerShellScript; else cmd=RunShellScript; fi

  # This channel CANNOT carry non-ASCII, so scripts are transliterated on the
  # way out. An em dash (E2 80 94) arrives on the box as `a<EUR>"` — note the
  # trailing DOUBLE QUOTE, which terminates whatever string literal it sat in
  # and takes the rest of the script's parse with it. The failure is loud but
  # deeply misleading: PowerShell reports "Missing closing '}'" tens of lines
  # from the real cause.
  #
  # This is NOT PowerShell 5.1 reading a BOM-less file as Windows-1252, which
  # was the obvious hypothesis: a probe with a UTF-8 BOM prepended mangles
  # identically (verified 2026-08-22), so the re-encoding happens in az or the
  # guest plugin, upstream of anything a script can declare about itself.
  #
  # Doing this here rather than in each script is deliberate. Comments survive
  # mangling unhurt, so the hazard is invisible until the day someone writes a
  # dash inside a STRING — win-smoke.ps1 carried exactly that defect, unrun and
  # unnoticed, for its whole life. Authors should not have to know.
  local sanitized rc=0
  sanitized="$(mktemp -t libi-lab-exec)" || az_die "could not create a temp file"
  LC_ALL=en_US.UTF-8 sed \
    -e 's/—/--/g' -e 's/–/-/g' -e 's/…/.../g' -e 's/→/->/g' \
    -e "s/’/'/g" -e "s/‘/'/g" -e "s/“/'/g" -e "s/”/'/g" \
    "$script" | LC_ALL=C tr -cd '\0-\177' > "$sanitized"
  if ! cmp -s "$script" "$sanitized"; then
    az_note "note: $script contains non-ASCII; sent transliterated (this channel cannot carry it)"
  fi

  az_note "running $script on $vm via the Azure control plane (no SSH, no credential on the box)"
  if [ "${#params[@]}" -gt 0 ]; then
    az_note "script parameters: ${params[*]}"
    az vm run-command invoke --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
      --command-id "$cmd" --scripts "@$sanitized" \
      --parameters "${params[@]}" \
      --query "value[].message" -o tsv || rc=$?
  else
    az vm run-command invoke --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
      --command-id "$cmd" --scripts "@$sanitized" \
      --query "value[].message" -o tsv || rc=$?
  fi
  rm -f "$sanitized"
  return $rc
}

# Put the operator's PUBLIC key on the Windows box and turn on sshd.
#
# run-command stays the bootstrap -- it is the only channel that works on a
# fresh box -- but it is a poor one to keep using: output truncates near 4 KB,
# the extension's provisioning timeout kills anything long, and a client killed
# mid-call leaves every later invocation returning Conflict until the VM is
# rebuilt. One run-command call buys a channel with none of those limits.
ssh_setup() {
  local plat="${1:-win}"
  [ "$plat" = win ] || az_die "ssh-setup is for win (linux has sshd from birth)"
  local pub="${LIBI_AZ_SSH_KEY}.pub"
  [ -f "$pub" ] || az_die "no public key at $pub
Create the pair first (the private half never leaves this machine):
  ssh-keygen -t ed25519 -f ${LIBI_AZ_SSH_KEY} -N '' -C libi-qa-azure-operator"

  # The key is INLINED rather than passed as a run-command parameter: az sends
  # parameters as `-Name value` and a public key contains spaces, so it would
  # arrive split across three arguments.
  local tmp; tmp="$(mktemp -t libi-lab-ssh)" || az_die "could not create a temp file"
  {
    printf "\$PublicKey = '%s'\n" "$(tr -d '\r\n' < "$pub")"
    cat "$HERE/remote/enable-ssh.ps1"
  } > "$tmp"
  az_note "enabling sshd on $(az_vm_name win) and installing $(basename "$pub")"
  exec_on win "$tmp"
  local rc=$?
  rm -f "$tmp"
  [ $rc -eq 0 ] || return $rc
  az_note "now use: lab.sh ssh win            (interactive)"
  az_note "          lab.sh ssh win '<cmd>'   (one command, full output, no 4KB cap)"
}

# Copy a PowerShell script to the Windows box, ASCII-safe.
#
# scp delivers bytes intact, but PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as
# Windows-1252 — so an em dash in a COMMENT becomes `a<EUR>"`, and that stray
# double quote opens a string that swallows the rest of the parse. The failure
# is reported tens of lines away ("Missing closing '}'"), which is how it cost
# a 30-minute Electron build that never started.
#
# Same class as the mangling exec_on handles, different cause: there az
# re-encodes upstream (a BOM does not help), here the file is fine and the
# READER is wrong. Transliterating to ASCII fixes both, so both paths do it.
#
# Only for text scripts. Never route a tarball or any binary through this.
push_script() {
  local plat="${1:-}" src="${2:-}" dest="${3:-}"
  [ "$plat" = win ] || az_die "usage: lab.sh push-script win <local.ps1> <remote-name>"
  [ -f "$src" ] || az_die "no such file: $src"
  [ -n "$dest" ] || az_die "usage: lab.sh push-script win <local.ps1> <remote-name>"
  local vm ip; vm="$(az_vm_name win)"
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP -- is it up?"
  local tmp; tmp="$(mktemp -t libi-lab-push)" || az_die "could not create a temp file"
  LC_ALL=en_US.UTF-8 sed \
    -e 's/—/--/g' -e 's/–/-/g' -e 's/…/.../g' -e 's/→/->/g' \
    -e "s/’/'/g" -e "s/‘/'/g" -e "s/“/'/g" -e "s/”/'/g" \
    "$src" | LC_ALL=C tr -cd '\0-\177' > "$tmp"
  cmp -s "$src" "$tmp" || az_note "note: $(basename "$src") contained non-ASCII; pushed transliterated"
  scp -o StrictHostKeyChecking=accept-new -i "$LIBI_AZ_SSH_KEY" \
    "$tmp" "$LIBI_AZ_ADMIN@$ip:C:/Users/$LIBI_AZ_ADMIN/$dest"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# Open an RDP session to the Windows box on THIS Mac.
#
# Tier 2 of the playbook -- the half that needs eyes. It also unlocks
# screenshotting: an SSH session lands in session 0, which has no desktop, so
# a capture taken from there comes back BLACK rather than failing. Capturing
# anything real requires an interactive session to exist, and this is what
# creates one. Keep the window OPEN: a disconnected session survives but stops
# rendering, and captures silently go black again.
#
# The password is NOT handled here. It is the local Windows account password
# chosen at create time, it lives in the operator's Keychain, and it is typed
# into the RDP client by a human -- see the password section in README.md.
rdp() {
  local plat="${1:-win}"
  [ "$plat" = win ] || az_die "rdp is for win (for linux run 'lab.sh desktop linux' first)"
  local app="/Applications/Windows App.app"
  [ -d "$app" ] || az_die "no RDP client found at $app
Install one:  brew install --cask windows-app"

  local vm ip; vm="$(az_vm_name win)"
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP -- is it up?"

  # A .rdp file rather than an rdp:// URL: the URL scheme is not registered by
  # every build of the client, a file is, and the file can carry the settings
  # that make a QA session usable (a real resolution, clipboard for pasting
  # commands in).
  local f="${TMPDIR:-/tmp}/libi-qa-win.rdp"
  cat > "$f" <<RDP
full address:s:$ip:3389
username:s:$LIBI_AZ_ADMIN
screen mode id:i:2
desktopwidth:i:1920
desktopheight:i:1080
redirectclipboard:i:1
audiomode:i:2
RDP
  az_note "opening an RDP session to $ip as $LIBI_AZ_ADMIN"
  az_note "password: the one in your Keychain --"
  az_note "  security find-generic-password -a $LIBI_AZ_ADMIN -s $LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE -w"
  az_note "KEEP THE WINDOW OPEN while screenshots are being taken -- a"
  az_note "disconnected session stops rendering and captures come back black."
  open -a "$app" "$f"
}

# ssh to a VM with the lab's own key. Windows only for now; the Linux box is
# reached with the same command shape but its stock key.
ssh_to() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh ssh <win|linux> [command...]"
  shift || true
  local vm ip; vm="$(az_vm_name "$plat")"
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP -- is it up?"
  local key_args=()
  [ "$plat" = win ] && key_args=(-i "$LIBI_AZ_SSH_KEY")
  # BatchMode: fail with a real error instead of hanging on a password prompt
  # when the key is not installed -- 'lab.sh ssh-setup win' is the fix.
  #
  # Keepalives are not optional here. QA commands routinely sit silent for
  # minutes (a Category A install, a poll loop), and without traffic the
  # connection gets dropped somewhere in the path -- observed as
  # "Connection reset by peer" mid-run, which reads exactly like the remote
  # process dying when it has not. ServerAlive probes keep the link warm and
  # turn a genuine death into a bounded failure instead of an ambiguous one.
  ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=8 \
    -o TCPKeepAlive=yes \
    "${key_args[@]}" "$LIBI_AZ_ADMIN@$ip" "$@"
}

# Give the Ubuntu box a real desktop you can look at.
#
# xvfb (installed by `provision`) lets the app RUN headless, which is enough for
# scripted checks — HTTP 200, logs, Category A completing. It is NOT enough to
# LOOK at the app, and some Linux findings are visual. This adds xfce + xrdp so
# the same box can be RDP'd into with the same client used for Windows.
#
# Opt-in rather than default: it is a few hundred MB and a couple of minutes,
# and most runs never need it.
desktop() {
  local plat="${1:-}"; [ "$plat" = linux ] || az_die "desktop is for linux (Windows already has one)"
  local vm ip; vm="$(az_vm_name linux)"
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP — is it up?"
  az_note "installing xfce + xrdp on $vm (a few minutes)"
  ssh -o StrictHostKeyChecking=accept-new "$LIBI_AZ_ADMIN@$ip" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq xfce4 xfce4-goodies xrdp
echo xfce4-session | sudo tee /home/*/.xsession >/dev/null || true
sudo adduser xrdp ssl-cert 2>/dev/null || true
sudo systemctl enable --now xrdp
echo "[desktop] xrdp listening on 3389"
REMOTE
  az_note "RDP to $ip with user $LIBI_AZ_ADMIN — 3389 is already open to your IP in the NSG"
}

up() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh up <win|linux>"
  local vm; vm="$(az_vm_name "$plat")"
  ensure_scaffold

  if az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -o none 2>/dev/null; then
    az_note "$vm exists — starting it rather than recreating"
    # Re-arm BEFORE starting, unconditionally: the call is idempotent, works on
    # a deallocated VM, and is what repairs a VM whose original arming window
    # was interrupted (see arm_auto_shutdown). Never trust that it already ran.
    arm_auto_shutdown "$vm"
    az vm start --resource-group "$LIBI_AZ_GROUP" --name "$vm" -o none
    connect "$plat"
    return
  fi

  local image size floor auth=() win_pw_from_keychain=0
  if [ "$plat" = win ]; then
    image="$LIBI_AZ_WIN_IMAGE"; size="$LIBI_AZ_WIN_SIZE"; floor="$LIBI_AZ_WIN_DISK_FLOOR_GB"
    # A Windows VM needs a password. We do NOT generate, store, echo or read one
    # INTO THIS SHELL, ever: either `az vm create` prompts for it interactively
    # and it goes straight to Azure, or — when the operator has stored it in the
    # macOS Keychain under $LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE — the prompt is
    # answered over a PTY by lib/keychain-pw.expect, which reads the value from
    # `security` itself. Both routes keep it out of this repo, argv (`ps`), the
    # environment, shell history, and any agent transcript; the Keychain route
    # exists precisely because --admin-password argv would trade the prompt's
    # safety for a ps-readable leak. See lib/azure.sh for the full story.
    auth=(--admin-username "$LIBI_AZ_ADMIN")
    if az_win_pw_keychain_ready; then
      win_pw_from_keychain=1
      az_note "admin password: Keychain entry '$LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE' found — az's"
      az_note "prompt will be answered from it; the value itself never appears anywhere here."
      az_note "(macOS may show a keychain-access dialog to approve the read — on a locked"
      az_note " keychain, 'unattended' still needs that one human click)"
    else
      az_note "you will be prompted for an admin password — it is never stored here"
      az_note "(optional: store it once with 'security add-generic-password -a $LIBI_AZ_WIN_PW_KEYCHAIN_ACCOUNT"
      az_note " -s $LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE -w' and later 'up win' runs answer the prompt themselves"
      az_note " — see the README's password section)"
    fi
  else
    image="$LIBI_AZ_LINUX_IMAGE"; size="$LIBI_AZ_LINUX_SIZE"; floor="$LIBI_AZ_LINUX_DISK_FLOOR_GB"
    auth=(--admin-username "$LIBI_AZ_ADMIN" --generate-ssh-keys)
  fi

  # `--os-disk-size-gb` can only GROW an image's disk — Azure REJECTS a request
  # below the image's own size rather than rounding it up. Clamp to the image
  # floor (see lib/azure.sh for where the numbers come from) and say what that
  # does to the bill, because disks bill on PROVISIONED size, not requested.
  local disk_gb="$LIBI_AZ_DISK_GB"
  if [ "$disk_gb" -lt "$floor" ]; then
    az_note "NOTE: the $plat image ships a ${floor}GB OS disk and Azure can only GROW it,"
    az_note "so the requested ${disk_gb}GB would be REJECTED. Provisioning ${floor}GB instead."
    az_note "COST: disks bill on the PROVISIONED size, so budget for ${floor}GB — for scale,"
    az_note "127GB Standard SSD is the E10 tier at ~\$9.60/mo idle vs ~\$4.80/mo for 64GB."
    az_note "Snapshot + down --keep-snapshots after each session (the README's default"
    az_note "workflow) is what keeps that idle cost near zero."
    disk_gb="$floor"
  fi

  az_note "creating $vm ($image, $size, ${disk_gb}GB $LIBI_AZ_DISK_SKU) in $LIBI_AZ_LOCATION"
  # --storage-sku is NOT cosmetic: Azure defaults `s`-suffixed sizes to Premium
  # SSD, and a 128 GB Premium disk left sitting is $21.68/mo against $9.60/mo
  # for Standard SSD. Nothing we do here is IOPS-bound.
  local create_args=(
    --resource-group "$LIBI_AZ_GROUP" --name "$vm"
    --image "$image" --size "$size"
    --vnet-name "$LIBI_AZ_VNET" --subnet "$LIBI_AZ_SUBNET" --nsg "$LIBI_AZ_NSG"
    --os-disk-size-gb "$disk_gb"
    --storage-sku "$LIBI_AZ_DISK_SKU"
    --public-ip-sku Standard
    "${auth[@]}" -o none
  )
  LAB_UNARMED_VM="$vm"   # picked up by lab_disarm_guard if we die before arming
  if [ "$win_pw_from_keychain" = 1 ]; then
    az_vm_create_with_keychain_pw "${create_args[@]}"
  else
    az vm create "${create_args[@]}"
  fi

  # Arm IMMEDIATELY — nothing may sit between create and this call, because
  # this schedule is the only thing that stops a forgotten VM from billing.
  arm_auto_shutdown "$vm"

  # Report what was ACTUALLY created — the provisioned size is what the disk
  # bills on. The clamp above should make this equal the request; it is
  # measured anyway rather than assumed.
  local made
  # NB: the field is diskSizeGB with a capital B, and JMESPath is
  # case-sensitive — "diskSizeGb" returns null, not an error, so az EXITS 0
  # with empty output and the || fallback below never fires. Hence the ${:-?}.
  made="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --query "storageProfile.osDisk.diskSizeGB" -o tsv 2>/dev/null || true)"
  made="${made:-?}"
  az_note "os disk actually provisioned: ${made}GB (requested ${disk_gb}GB) — the disk bills on ${made}GB"

  if [ "$plat" = linux ]; then
    provision linux
  else
    az_note "next: RDP in and run qa/cloud/provision/windows.ps1 (see 'lab.sh provision win')"
  fi
  connect "$plat"
}

stop() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh stop <win|linux>"
  local vm; vm="$(az_vm_name "$plat")"
  # `deallocate`, NOT `stop`. A merely stopped VM still bills for compute;
  # deallocated does not. This distinction is the whole point of the command.
  az vm deallocate --resource-group "$LIBI_AZ_GROUP" --name "$vm" -o none
  az_note "$vm deallocated — compute billing stopped, disk retained"
}

# A provisioned box is worth roughly an hour of setup — Category A, the model
# downloads, the tracking pyenv. Keeping its DISK to avoid redoing that costs
# $9.60/mo (Windows, Standard SSD). Keeping a SNAPSHOT of the same disk costs
# ~$0.05/GB/mo on USED space only — about $2.50/mo for a ~50 GB Windows box.
#
# So the cheap option and the fast option are the same option: delete the VMs
# after every session, keep a snapshot, and restore from it next time.
snapshot() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh snapshot <win|linux>"
  local vm name disk
  vm="$(az_vm_name "$plat")"
  name="${vm}-snap"
  disk="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --query "storageProfile.osDisk.managedDisk.id" -o tsv 2>/dev/null)" \
    || az_die "$vm not found — nothing to snapshot"
  [ -n "$disk" ] || az_die "$vm has no managed OS disk"

  # Deallocate first: a snapshot of a running Windows box is crash-consistent,
  # which for our purposes (restore and keep testing) is a coin flip on whether
  # the filesystem comes back clean.
  az_note "deallocating $vm first so the snapshot is filesystem-consistent"
  az vm deallocate --resource-group "$LIBI_AZ_GROUP" --name "$vm" -o none

  az snapshot delete --resource-group "$LIBI_AZ_GROUP" --name "$name" -o none 2>/dev/null || true
  az_note "creating incremental snapshot $name (bills used space only)"
  az snapshot create \
    --resource-group "$LIBI_AZ_GROUP" --name "$name" \
    --source "$disk" --incremental true \
    --sku "$LIBI_AZ_SNAPSHOT_SKU" -o none
  local used
  used="$(az snapshot show --resource-group "$LIBI_AZ_GROUP" --name "$name" \
    --query "diskSizeGB" -o tsv 2>/dev/null || true)"
  used="${used:-?}"
  az_note "snapshot $name created (~${used}GB provisioned; billed on used bytes)"
  az_note "you can now 'lab.sh down' and restore later with 'lab.sh restore $plat'"
}

restore() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh restore <win|linux>"
  local vm name size
  vm="$(az_vm_name "$plat")"; name="${vm}-snap"
  [ "$plat" = win ] && size="$LIBI_AZ_WIN_SIZE" || size="$LIBI_AZ_LINUX_SIZE"
  az snapshot show --resource-group "$LIBI_AZ_GROUP" --name "$name" >/dev/null 2>&1 \
    || az_die "no snapshot $name — use 'lab.sh up $plat' for a fresh build"

  # Same preconditions as `up`, checked here too because restore does NOT go
  # through ensure_scaffold: it creates a billable VM and then arms
  # auto-shutdown, so it must refuse in a region where the schedule cannot
  # exist, and refuse under a drifted LIBI_AZ_LOCATION (the snapshot lives in
  # the GROUP's region, whatever the config now claims).
  az_require_auto_shutdown_region
  ensure_group_location_matches

  # No admin password here, by construction — for EITHER platform. Attaching
  # an existing (specialized) OS disk carries the accounts already on it, and
  # az's own validator skips auth entirely for that storage profile, so `az vm
  # create --attach-os-disk` never prompts. The password chosen at `up win`
  # (or its Keychain copy — see up()) simply keeps working on the restored box.
  az_note "restoring $vm from $name (skips provisioning entirely)"
  az disk create --resource-group "$LIBI_AZ_GROUP" --name "${vm}-osdisk" \
    --source "$name" --sku "$LIBI_AZ_DISK_SKU" -o none
  # Same create→arm discipline as `up`: guard the window, arm immediately.
  LAB_UNARMED_VM="$vm"
  az vm create --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --attach-os-disk "${vm}-osdisk" \
    --os-type "$([ "$plat" = win ] && echo windows || echo linux)" \
    --size "$size" \
    --vnet-name "$LIBI_AZ_VNET" --subnet "$LIBI_AZ_SUBNET" --nsg "$LIBI_AZ_NSG" \
    --public-ip-sku Standard -o none
  arm_auto_shutdown "$vm"
  az_note "$vm restored. NOTE: its public IP is NEW — run 'lab.sh allow-my-ip'."
  connect "$plat"
}

down() {
  az_group_exists || { az_note "nothing to delete — $LIBI_AZ_GROUP does not exist"; return; }
  # Snapshots live in the same resource group, so a plain `down` destroys them
  # too. Say so before asking, rather than after.
  local snaps
  snaps="$(az snapshot list --resource-group "$LIBI_AZ_GROUP" --query "length(@)" -o tsv 2>/dev/null || echo 0)"
  printf '\nThis DELETES the entire %s resource group: both VMs, their disks,\n' "$LIBI_AZ_GROUP"
  printf 'NICs, public IPs, the NSG and the VNet. Artifacts still on those\n'
  printf 'machines are gone.\n'
  if [ "${snaps:-0}" -gt 0 ] 2>/dev/null; then
    printf '\nIt also deletes %s SNAPSHOT(S) in this group — the thing that would let\n' "$snaps"
    printf 'you skip an hour of provisioning next session. If you want to keep the\n'
    printf 'lab restorable, Ctrl-C and run "lab.sh down --keep-snapshots" instead.\n'
  fi
  printf 'Type DELETE to continue: '
  local answer=""; read -r answer || true
  [ "$answer" = DELETE ] || az_die "not confirmed — nothing was deleted."
  az group delete --name "$LIBI_AZ_GROUP" --yes --no-wait
  az_note "deletion started (--no-wait). Check with: lab.sh status"
}

# Tear down everything that bills meaningfully while keeping the snapshots, so
# the next session is a `restore` rather than a rebuild. This is the intended
# end-of-session command.
down_keep_snapshots() {
  az_group_exists || { az_note "nothing to delete — $LIBI_AZ_GROUP does not exist"; return; }
  local vms
  vms="$(az vm list --resource-group "$LIBI_AZ_GROUP" --query "[].name" -o tsv 2>/dev/null)"
  for vm in $vms; do
    az_note "deleting VM $vm (its snapshot, if any, is kept)"
    az vm delete --resource-group "$LIBI_AZ_GROUP" --name "$vm" --yes -o none
  done
  # VM delete leaves the OS disk, NIC and public IP behind — the classic Azure
  # orphan trio, and the reason a "deleted" lab keeps billing.
  for d in $(az disk list --resource-group "$LIBI_AZ_GROUP" --query "[?diskState=='Unattached'].name" -o tsv 2>/dev/null); do
    az_note "deleting orphaned disk $d"
    az disk delete --resource-group "$LIBI_AZ_GROUP" --name "$d" --yes -o none
  done
  for n in $(az network nic list --resource-group "$LIBI_AZ_GROUP" --query "[?virtualMachine==null].name" -o tsv 2>/dev/null); do
    az network nic delete --resource-group "$LIBI_AZ_GROUP" --name "$n" -o none
  done
  for p in $(az network public-ip list --resource-group "$LIBI_AZ_GROUP" --query "[?ipConfiguration==null].name" -o tsv 2>/dev/null); do
    az_note "releasing unattached public IP $p (Standard IPs bill hourly)"
    az network public-ip delete --resource-group "$LIBI_AZ_GROUP" --name "$p" -o none
  done
  az_note "VMs, disks, NICs and IPs gone; snapshots kept. Next session: lab.sh restore <win|linux>"
  status
}

status() {
  if ! az_group_exists; then
    echo "resource group $LIBI_AZ_GROUP: absent — the lab costs nothing"
    return
  fi
  # The group's ACTUAL location, not $LIBI_AZ_LOCATION — printing the config
  # here is how a drifted region stays invisible (a group's location is fixed
  # at creation; the config can silently disagree).
  local group_loc
  group_loc="$(az_group_location || true)"
  echo "resource group: $LIBI_AZ_GROUP (${group_loc:-location unreadable})"
  if [ -n "$group_loc" ] && [ "$group_loc" != "$LIBI_AZ_LOCATION" ]; then
    echo "  WARNING: LIBI_AZ_LOCATION is '$LIBI_AZ_LOCATION' but this group lives in"
    echo "  '$group_loc' — 'lab.sh doctor' explains, and up/scaffold/restore will refuse."
  fi
  echo
  echo "VMs:"
  az vm list --resource-group "$LIBI_AZ_GROUP" --show-details \
    --query "[].{name:name, size:hardwareProfile.vmSize, state:powerState, ip:publicIps}" \
    -o table 2>/dev/null || echo "  none"
  echo
  echo "Disks (these bill even while a VM is deallocated):"
  az disk list --resource-group "$LIBI_AZ_GROUP" \
    --query "[].{name:name, gb:diskSizeGB, state:diskState}" -o table 2>/dev/null || echo "  none"
  echo
  echo "Public IPs (a reserved-but-unattached Standard IP bills hourly):"
  az network public-ip list --resource-group "$LIBI_AZ_GROUP" \
    --query "[].{name:name, ip:ipAddress, sku:sku.name}" -o table 2>/dev/null || echo "  none"
  echo
  echo "A VM showing 'VM deallocated' costs only its disk. 'VM running' costs compute too."
}

connect() {
  local plat="${1:-}"; [ -n "$plat" ] || az_die "usage: lab.sh connect <win|linux>"
  local vm ip; vm="$(az_vm_name "$plat")"
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP (is it created and running?)"
  echo
  if [ "$plat" = win ]; then
    echo "Windows: open Microsoft Remote Desktop and connect to  $ip"
    echo "  user: $LIBI_AZ_ADMIN   password: the one you set at create time"
  else
    echo "Linux:  ssh $LIBI_AZ_ADMIN@$ip"
  fi
  echo "Reachable only from the IP recorded in the NSG — run 'lab.sh allow-my-ip' if your network changed."
}

doctor() {
  az_require_cli
  echo "subscription: $(az_subscription)"
  echo "account:      $(az account show --query user.name -o tsv)"
  echo "location:     $LIBI_AZ_LOCATION"
  echo
  # Preconditions FIRST, each reported on its own line — and deliberately NOT
  # auto-fixed. doctor's contract is "costs nothing and changes nothing", so it
  # diagnoses and `up` repairs (ensure_providers + ensure_scaffold run there);
  # a doctor that registers providers or creates groups is a doctor you
  # hesitate to run. The split exists because the probe below validates a
  # deployment INTO the resource group: on the first real subscription this ran
  # against it printed UNAVAILABLE while the actual causes were unregistered
  # providers and a missing group — an entitlement verdict that meant nothing.
  echo "— lab preconditions —"
  local ns state ready=1 shed_state group_loc
  for ns in $LAB_REQUIRED_PROVIDERS; do
    state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
    if [ "$state" = Registered ]; then
      echo "  provider $ns: Registered"
    else
      echo "  provider $ns: ${state} — 'lab.sh up <win|linux>' registers it and waits"
      ready=0
    fi
  done
  # Registration above is subscription-wide; whether the provider OFFERS the
  # schedules resource type in THIS region is a separate, per-region question —
  # and it is the one that decides whether auto-shutdown, the lab's only safety
  # net, can exist at all. Provider metadata is readable even while
  # NotRegistered, so this verdict is real regardless of the lines above.
  shed_state="$(az_auto_shutdown_region_state)"
  case "$shed_state" in
    available)
      echo "  auto-shutdown capability in $LIBI_AZ_LOCATION: available (DevTestLab/schedules)" ;;
    unavailable)
      echo "  auto-shutdown capability in $LIBI_AZ_LOCATION: NOT AVAILABLE — this region has no"
      echo "    Microsoft.DevTestLab/schedules, so the daily-deallocate safety net cannot"
      echo "    exist and the lab refuses to build here. Regions that do offer it:"
      az_devtestlab_schedule_locations_arm | fold -s -w 72 | sed 's/^/    /'
      ready=0 ;;
    unknown-location)
      echo "  auto-shutdown capability: LIBI_AZ_LOCATION '$LIBI_AZ_LOCATION' is not a region"
      echo "    this cloud knows — ARM names ('swedencentral'), not display names"
      ready=0 ;;
    unreadable)
      echo "  auto-shutdown capability in $LIBI_AZ_LOCATION: could not read the provider's"
      echo "    region list (transient? re-run doctor) — unverified, treat as not ready"
      ready=0 ;;
  esac
  if az_group_exists; then
    group_loc="$(az_group_location || true)"
    if [ -z "$group_loc" ] || [ "$group_loc" = "$LIBI_AZ_LOCATION" ]; then
      echo "  resource group $LIBI_AZ_GROUP: exists"
    else
      echo "  resource group $LIBI_AZ_GROUP: exists — but in '$group_loc', while"
      echo "    LIBI_AZ_LOCATION says '$LIBI_AZ_LOCATION'. A group's location is fixed at"
      echo "    creation, so the lab would keep building in '$group_loc'. Set"
      echo "    LIBI_AZ_LOCATION=$group_loc to keep it, or 'lab.sh down' to move regions."
      ready=0
    fi
  else
    echo "  resource group $LIBI_AZ_GROUP: absent — 'lab.sh up <win|linux>' creates it"
    ready=0
  fi
  echo
  echo "— Windows 11 client image eligibility —"
  # Azure enforces client-image entitlement at DEPLOY time, so listing it proves
  # nothing. This asks Azure to VALIDATE a deployment without creating one, and
  # KEEPS the error: a verdict that cannot say why is not a verdict.
  if [ "$ready" -ne 1 ]; then
    echo "  NOT PROBED — the preconditions above are missing, so a validate probe would"
    echo "  fail because of THEM and say nothing about entitlement. Fix them (one"
    echo "  'lab.sh up' does both; it registers providers and builds the free scaffold"
    echo "  before creating anything billable), then re-run doctor for a real verdict."
  else
    local probe_err
    if probe_err="$(az vm create --resource-group "$LIBI_AZ_GROUP" --name probe-only \
         --image "$LIBI_AZ_WIN_IMAGE" --size "$LIBI_AZ_WIN_SIZE" \
         --admin-username "$LIBI_AZ_ADMIN" --admin-password 'Probe!NotUsed123' \
         --validate -o none 2>&1 >/dev/null)"; then
      echo "  OK — $LIBI_AZ_WIN_IMAGE deploys on this subscription"
    else
      echo "  Azure rejected the validate-only deployment. Its error, verbatim:"
      printf '%s\n' "$probe_err" | sed 's/^/    | /'
      case "$probe_err" in
        *MissingSubscriptionRegistration*|*NotRegistered*|*ResourceGroupNotFound*)
          echo "  SETUP-INCOMPLETE — the error above names a lab precondition, not image"
          echo "  entitlement. Fix it (usually just 'lab.sh up'), then re-run doctor." ;;
        *)
          echo "  UNAVAILABLE — with the preconditions green, this subscription genuinely"
          echo "  cannot deploy the Windows 11 client image (the error above is Azure's"
          echo "  reason). Fall back to $LIBI_AZ_WIN_FALLBACK_IMAGE (Server), but note the"
          echo "  tradeoff: Server matches CI, while SmartScreen and installer UX are"
          echo "  CLIENT-OS questions — which is what real users actually have." ;;
      esac
    fi
  fi
  echo
  echo "— quota for $LIBI_AZ_WIN_SIZE family in $LIBI_AZ_LOCATION —"
  az vm list-usage --location "$LIBI_AZ_LOCATION" \
    --query "[?contains(name.value,'standardDSv5Family')].{name:localName, used:currentValue, limit:limit}" \
    -o table 2>/dev/null || echo "  (could not read quota)"
  echo
  status
}

# Help works without config; EVERYTHING else requires the subscription BEFORE
# the first az call. The az() wrapper also enforces this, but several call
# sites send az's stderr to /dev/null (az_group_exists, the tsv queries), which
# would swallow its error and let e.g. `status` report an absent lab it never
# actually looked for. Failing here keeps the failure loud.
case "${1:-}" in
  -h|--help|"") usage; exit 0 ;;
esac
az_subscription >/dev/null

case "${1:-}" in
  doctor)      shift; doctor ;;
  # Providers + resource group + vnet + NSG, and nothing billable: every
  # resource here is free, the meter only starts at `up`. Exists so the
  # image-entitlement question can be answered BEFORE committing to a VM —
  # `doctor` cannot probe until the preconditions are real, and making the
  # only path to them the one that also creates a VM defeats the point.
  scaffold)    shift; az_require_cli; ensure_scaffold; az_note "scaffold ready — nothing billable created; re-run 'lab.sh doctor'" ;;
  up)          shift; up "${1:-}" ;;
  stop)        shift; stop "${1:-}" ;;
  snapshot)    shift; az_require_cli; snapshot "${1:-}" ;;
  restore)     shift; az_require_cli; restore "${1:-}" ;;
  down)        shift
               if [ "${1:-}" = "--keep-snapshots" ]; then down_keep_snapshots; else down; fi ;;
  status)      shift; status ;;
  connect)     shift; connect "${1:-}" ;;
  ssh-setup)   shift; az_require_cli; ssh_setup "${1:-win}" ;;
  ssh)         shift; az_require_cli; ssh_to "$@" ;;
  rdp)         shift; az_require_cli; rdp "${1:-win}" ;;
  push-script) shift; az_require_cli; push_script "$@" ;;
  provision)   shift; az_require_cli; provision "${1:-}" ;;
  exec)        shift; az_require_cli; exec_on "$@" ;;
  desktop)     shift; az_require_cli; desktop "${1:-}" ;;
  allow-my-ip) shift; az_require_cli; allow_my_ip ;;
  *)           usage >&2; az_die "unknown command: $1" ;;
esac
