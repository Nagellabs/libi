#!/usr/bin/env bash
#
# libi's on-demand QA lab on Azure: a Windows 11 box and an Ubuntu box you can
# raise for an afternoon and put away again.
#
#   qa/cloud/azure/lab.sh doctor           # preflight: CLI, login, quota, image eligibility
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

ensure_scaffold() {
  if az_group_exists; then return; fi
  az_note "registering Microsoft.Compute (needed for run-command; one-time, idempotent)"
  az provider register --namespace Microsoft.Compute --wait -o none 2>/dev/null || true
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
  az network nsg rule create --resource-group "$LIBI_AZ_GROUP" \
    --nsg-name "$LIBI_AZ_NSG" --name allow-operator --priority 1000 \
    --source-address-prefixes "$ip/32" --destination-port-ranges 22 3389 \
    --access Allow --protocol Tcp --direction Inbound -o none 2>/dev/null \
  || az network nsg rule update --resource-group "$LIBI_AZ_GROUP" \
    --nsg-name "$LIBI_AZ_NSG" --name allow-operator \
    --source-address-prefixes "$ip/32" -o none
}

# Deallocate on a daily schedule. This is the ONLY thing standing between a
# forgotten VM and a month of compute billing — see lib/azure.sh. It is weaker
# than GCE's self-delete, so it is applied at CREATE time, never as a follow-up
# someone can forget.
arm_auto_shutdown() {
  local vm="$1"
  az vm auto-shutdown --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --time "$LIBI_AZ_SHUTDOWN_TIME" -o none
  az_note "auto-shutdown armed: deallocates daily at $LIBI_AZ_SHUTDOWN_TIME"
}

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
  ip="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" -d --query publicIps -o tsv 2>/dev/null || true)"
  [ -n "$ip" ] || az_die "$vm has no public IP — is it up?"

  if [ "$plat" = linux ]; then
    az_note "provisioning $vm (node 22, build toolchain, xvfb + electron runtime libs)"
    scp -o StrictHostKeyChecking=accept-new \
      "$HERE/../provision/ubuntu.sh" "$LIBI_AZ_ADMIN@$ip:/tmp/provision-ubuntu.sh"
    ssh -o StrictHostKeyChecking=accept-new "$LIBI_AZ_ADMIN@$ip" \
      "bash /tmp/provision-ubuntu.sh"
    az_note "xvfb is installed — the AppImage/deb can be booted headless with:"
    az_note "  LIBI_HOME=~/qa/home xvfb-run -a ./Libi-<v>.AppImage --no-sandbox"
  else
    # Windows has no ssh by default on these images; RDP in and run it there.
    az_note "copy qa/cloud/provision/windows.ps1 to the box and run it in PowerShell:"
    az_note "  powershell -ExecutionPolicy Bypass -File windows.ps1"
    az_note "(Windows provisioning is manual on purpose — no SSH on the client image,"
    az_note " and putting a key there would be a credential on a QA VM.)"
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
  [ -n "$plat" ] && [ -n "$script" ] || az_die "usage: lab.sh exec <win|linux> <script-file>"
  [ -f "$script" ] || az_die "no such script: $script"
  local vm cmd; vm="$(az_vm_name "$plat")"
  if [ "$plat" = win ]; then cmd=RunPowerShellScript; else cmd=RunShellScript; fi
  az_note "running $script on $vm via the Azure control plane (no SSH, no credential on the box)"
  az vm run-command invoke --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --command-id "$cmd" --scripts "@$script" \
    --query "value[].message" -o tsv
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
    az vm start --resource-group "$LIBI_AZ_GROUP" --name "$vm" -o none
    connect "$plat"
    return
  fi

  local image size auth=()
  if [ "$plat" = win ]; then
    image="$LIBI_AZ_WIN_IMAGE"; size="$LIBI_AZ_WIN_SIZE"
    # A Windows VM needs a password. We do NOT generate, store, echo or read one
    # here: `az vm create` prompts for it interactively and it goes straight to
    # Azure. Nothing in this repo, this shell's history, or an agent transcript
    # ever sees it.
    auth=(--admin-username "$LIBI_AZ_ADMIN")
    az_note "you will be prompted for an admin password — it is never stored here"
  else
    image="$LIBI_AZ_LINUX_IMAGE"; size="$LIBI_AZ_LINUX_SIZE"
    auth=(--admin-username "$LIBI_AZ_ADMIN" --generate-ssh-keys)
  fi

  az_note "creating $vm ($image, $size, ${LIBI_AZ_DISK_GB}GB $LIBI_AZ_DISK_SKU) in $LIBI_AZ_LOCATION"
  # --storage-sku is NOT cosmetic: Azure defaults `s`-suffixed sizes to Premium
  # SSD, and a 128 GB Premium disk left sitting is $21.68/mo against $9.60/mo
  # for Standard SSD. Nothing we do here is IOPS-bound.
  az vm create \
    --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --image "$image" --size "$size" \
    --vnet-name "$LIBI_AZ_VNET" --subnet "$LIBI_AZ_SUBNET" --nsg "$LIBI_AZ_NSG" \
    --os-disk-size-gb "$LIBI_AZ_DISK_GB" \
    --storage-sku "$LIBI_AZ_DISK_SKU" \
    --public-ip-sku Standard \
    "${auth[@]}" -o none

  # Report what was ACTUALLY created. `--os-disk-size-gb` can only grow an
  # image's disk, so a Windows image may land larger than requested; that is
  # the number the cost maths has to use, not the one we asked for.
  local made
  made="$(az vm show --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --query "storageProfile.osDisk.diskSizeGb" -o tsv 2>/dev/null || echo "?")"
  az_note "os disk actually provisioned: ${made}GB (requested ${LIBI_AZ_DISK_GB}GB)"

  arm_auto_shutdown "$vm"
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
    --query "diskSizeGb" -o tsv 2>/dev/null || echo "?")"
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

  az_note "restoring $vm from $name (skips provisioning entirely)"
  az disk create --resource-group "$LIBI_AZ_GROUP" --name "${vm}-osdisk" \
    --source "$name" --sku "$LIBI_AZ_DISK_SKU" -o none
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
  echo "resource group: $LIBI_AZ_GROUP ($LIBI_AZ_LOCATION)"
  echo
  echo "VMs:"
  az vm list --resource-group "$LIBI_AZ_GROUP" --show-details \
    --query "[].{name:name, size:hardwareProfile.vmSize, state:powerState, ip:publicIps}" \
    -o table 2>/dev/null || echo "  none"
  echo
  echo "Disks (these bill even while a VM is deallocated):"
  az disk list --resource-group "$LIBI_AZ_GROUP" \
    --query "[].{name:name, gb:diskSizeGb, state:diskState}" -o table 2>/dev/null || echo "  none"
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
  echo "— Windows 11 client image eligibility —"
  # Azure enforces client-image entitlement at DEPLOY time, so listing it proves
  # nothing. This asks Azure to VALIDATE a deployment without creating one.
  if az vm create --resource-group "$LIBI_AZ_GROUP" --name probe-only \
       --image "$LIBI_AZ_WIN_IMAGE" --size "$LIBI_AZ_WIN_SIZE" \
       --admin-username "$LIBI_AZ_ADMIN" --admin-password 'Probe!NotUsed123' \
       --validate -o none 2>/dev/null; then
    echo "  OK — $LIBI_AZ_WIN_IMAGE deploys on this subscription"
  else
    echo "  UNAVAILABLE — this subscription cannot deploy the Windows 11 client image."
    echo "  Fall back to $LIBI_AZ_WIN_FALLBACK_IMAGE (Server), but note the tradeoff:"
    echo "  Server matches CI, while SmartScreen and installer UX are CLIENT-OS"
    echo "  questions — which is what real users actually have."
  fi
  echo
  echo "— quota for $LIBI_AZ_WIN_SIZE family in $LIBI_AZ_LOCATION —"
  az vm list-usage --location "$LIBI_AZ_LOCATION" \
    --query "[?contains(name.value,'standardDSv5Family')].{name:localName, used:currentValue, limit:limit}" \
    -o table 2>/dev/null || echo "  (could not read quota)"
  echo
  status
}

case "${1:-}" in
  doctor)      shift; doctor ;;
  up)          shift; up "${1:-}" ;;
  stop)        shift; stop "${1:-}" ;;
  snapshot)    shift; az_require_cli; snapshot "${1:-}" ;;
  restore)     shift; az_require_cli; restore "${1:-}" ;;
  down)        shift
               if [ "${1:-}" = "--keep-snapshots" ]; then down_keep_snapshots; else down; fi ;;
  status)      shift; status ;;
  connect)     shift; connect "${1:-}" ;;
  provision)   shift; az_require_cli; provision "${1:-}" ;;
  exec)        shift; az_require_cli; exec_on "${1:-}" "${2:-}" ;;
  desktop)     shift; az_require_cli; desktop "${1:-}" ;;
  allow-my-ip) shift; az_require_cli; allow_my_ip ;;
  -h|--help|"") usage ;;
  *)           usage >&2; az_die "unknown command: $1" ;;
esac
