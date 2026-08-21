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
#   qa/cloud/azure/lab.sh down             # DELETE EVERYTHING (the whole resource group)
#   qa/cloud/azure/lab.sh allow-my-ip      # re-point the NSG at your current IP
#   qa/cloud/azure/lab.sh connect win      # print how to reach it (RDP / SSH)
#   qa/cloud/azure/lab.sh provision linux  # install build + Electron runtime deps
#
# `stop` is the one you want between sessions; `down` is the one you want when
# the work is finished. See lib/azure.sh's teardown contract for why both exist
# and which guarantee is weaker than the GCE rig's.
#
# NEVER put a credential on these machines — see lib/azure.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/azure.sh
. "$HERE/lib/azure.sh"

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; }

ensure_scaffold() {
  if az_group_exists; then return; fi
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

  az_note "creating $vm ($image, $size, ${LIBI_AZ_DISK_GB}GB) in $LIBI_AZ_LOCATION"
  az vm create \
    --resource-group "$LIBI_AZ_GROUP" --name "$vm" \
    --image "$image" --size "$size" \
    --vnet-name "$LIBI_AZ_VNET" --subnet "$LIBI_AZ_SUBNET" --nsg "$LIBI_AZ_NSG" \
    --os-disk-size-gb "$LIBI_AZ_DISK_GB" \
    --public-ip-sku Standard \
    "${auth[@]}" -o none

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

down() {
  az_group_exists || { az_note "nothing to delete — $LIBI_AZ_GROUP does not exist"; return; }
  printf '\nThis DELETES the entire %s resource group: both VMs, their disks,\n' "$LIBI_AZ_GROUP"
  printf 'NICs, public IPs, the NSG and the VNet. Artifacts still on those\n'
  printf 'machines are gone. Type DELETE to continue: '
  local answer=""; read -r answer || true
  [ "$answer" = DELETE ] || az_die "not confirmed — nothing was deleted."
  az group delete --name "$LIBI_AZ_GROUP" --yes --no-wait
  az_note "deletion started (--no-wait). Check with: lab.sh status"
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
  down)        shift; down ;;
  status)      shift; status ;;
  connect)     shift; connect "${1:-}" ;;
  provision)   shift; az_require_cli; provision "${1:-}" ;;
  allow-my-ip) shift; az_require_cli; allow_my_ip ;;
  -h|--help|"") usage ;;
  *)           usage >&2; az_die "unknown command: $1" ;;
esac
