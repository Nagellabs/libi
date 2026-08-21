#!/usr/bin/env bash
#
# Shared GCE helpers for the ephemeral cross-platform QA rig.
#
# Every VM this creates is DISPOSABLE and carries two independent guarantees
# that it will not outlive its run:
#
#   1. An EXIT trap in the calling script destroys it.
#   2. `--max-run-duration` + `--instance-termination-action=DELETE` makes GCE
#      itself delete the instance, even if this machine loses power mid-run.
#
# (1) alone is not enough — a killed terminal, a crashed laptop, or a `kill -9`
# skips the trap and leaves an instance billing indefinitely. (2) is the one
# that actually holds. Do not remove it.
#
# Access is IAP-tunneled ONLY. The `libi-qa` VPC has exactly one ingress rule
# (35.235.240.0/20 → tcp:22,3389) and no path from 0.0.0.0/0. Instances get an
# ephemeral EXTERNAL ip for egress (npm, nodejs.org, evermeet, gyan.dev,
# github) — an external address grants no inbound reachability by itself, since
# ingress is default-deny and the only rule is IAP-scoped.
#
# Config resolution, in order:
#   $LIBI_QA_PROJECT  →  qa/cloud/config.local.sh  →  hard error
# The project id is deliberately NOT committed: this repo is public.
#
# Written for bash 3.2 — the version macOS still ships, and the one that will
# run this. That rules out `${arr[@]}` on an empty array under `set -u`
# (use `${arr[@]+"${arr[@]}"}`), associative arrays, and `${var^^}`.
# Source it from bash, never zsh: BASH_SOURCE is a bashism.

set -euo pipefail

# lib/gce.sh → qa/cloud → repo root. Two levels up from this file's dir, not
# one: an off-by-one here silently produced an 8KB "source tarball" containing
# only qa/, which the VM would have happily tried to build.
QA_CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$QA_CLOUD_DIR/../.." && pwd)"

# ── config ────────────────────────────────────────────────────────────────────

if [[ -z "${LIBI_QA_PROJECT:-}" && -f "$QA_CLOUD_DIR/config.local.sh" ]]; then
  # shellcheck source=/dev/null
  source "$QA_CLOUD_DIR/config.local.sh"
fi

: "${LIBI_QA_PROJECT:?set LIBI_QA_PROJECT, or create qa/cloud/config.local.sh (gitignored) exporting it}"
: "${LIBI_QA_ZONE:=me-west1-a}"
: "${LIBI_QA_SUBNET:=libi-qa-mw1}"
: "${LIBI_QA_REGION:=me-west1}"

# Hard ceiling on any QA instance's life. GCE deletes it at this age regardless
# of what happened to the driving script. Generous enough for a full
# build+install+suite cycle on Windows (~2h observed ceiling), short enough that
# a forgotten VM costs a couple of dollars rather than a month of billing.
: "${LIBI_QA_MAX_RUN:=4h}"

GC="gcloud --project=$LIBI_QA_PROJECT"

# ── logging ───────────────────────────────────────────────────────────────────

qa_log()  { printf '\033[1;34m[qa]\033[0m %s\n' "$*" >&2; }
qa_warn() { printf '\033[1;33m[qa]\033[0m %s\n' "$*" >&2; }
qa_die()  { printf '\033[1;31m[qa]\033[0m %s\n' "$*" >&2; exit 1; }

# ── instance lifecycle ────────────────────────────────────────────────────────

# gce_create <name> <os:linux|windows> <machine-type> <disk-gb>
gce_create() {
  local name="$1" os="$2" machine="$3" disk="$4"
  local image_family image_project extra=()

  case "$os" in
    linux)
      image_family="ubuntu-2404-lts-amd64"
      image_project="ubuntu-os-cloud"
      ;;
    windows)
      # windows-2022 by default, NOT 2025. On windows-2025 the guest agent
      # never provisions SSH keys: it reads the sshd service's ImagePath to
      # version-check OpenSSH, gets an empty string, and logs
      #   "Could not determine if openssh version is compatible … not enough
      #    values in version "" (split to [])"
      # on EVERY boot — including boots where OpenSSH Server is already
      # installed and sshd is running. `gcloud compute ssh` then fails with a
      # bare exit 255 on an instance that reports RUNNING and healthy.
      # Reproduced 2026-08-16 across a fresh create and a reset. 2022 is the
      # combination Google documents for enable-windows-ssh.
      # Override with LIBI_QA_WIN_IMAGE to retest a newer image.
      image_family="${LIBI_QA_WIN_IMAGE:-windows-2022}"
      image_project="windows-cloud"
      # `enable-windows-ssh=TRUE` tells the guest agent to provision SSH keys
      # from metadata — but it CONFIGURES sshd, it does not install it, and the
      # windows-2025 image does not ship OpenSSH Server. Without the startup
      # script below the agent logs
      #   "Could not determine if openssh version is compatible: … service
      #    image path SYSTEM\CurrentControlSet\Services\sshd"
      # every boot, no sshd ever listens, and `gcloud compute ssh` fails with
      # exit 255 while the instance looks perfectly healthy.
      #
      # So: install the capability, start it, and restart the guest agent so it
      # re-runs its SSH setup now that there is an sshd to configure.
      extra+=(--metadata=enable-windows-ssh=TRUE)
      extra+=(--metadata-from-file=windows-startup-script-ps1="$QA_CLOUD_DIR/provision/windows-enable-ssh.ps1")
      ;;
    *) qa_die "gce_create: unknown os '$os'" ;;
  esac

  qa_log "creating $name ($os, $machine, ${disk}GB) in $LIBI_QA_ZONE"
  $GC compute instances create "$name" \
    --zone="$LIBI_QA_ZONE" \
    --machine-type="$machine" \
    --subnet="$LIBI_QA_SUBNET" \
    --image-family="$image_family" \
    --image-project="$image_project" \
    --boot-disk-size="${disk}GB" \
    --boot-disk-type=pd-balanced \
    --max-run-duration="$LIBI_QA_MAX_RUN" \
    --instance-termination-action=DELETE \
    --labels=purpose=libi-qa,os="$os" \
    ${extra[@]+"${extra[@]}"} >/dev/null

  qa_log "created $name (self-deletes after $LIBI_QA_MAX_RUN regardless of this script)"
}

# gce_destroy <name> — idempotent; safe to call from an EXIT trap.
gce_destroy() {
  local name="$1"
  if $GC compute instances describe "$name" --zone="$LIBI_QA_ZONE" >/dev/null 2>&1; then
    qa_log "destroying $name"
    $GC compute instances delete "$name" --zone="$LIBI_QA_ZONE" --quiet >/dev/null 2>&1 || \
      qa_warn "delete of $name failed — CHECK THE CONSOLE, it may still be billing"
  fi
}

# gce_wait_ssh <name> [timeout-seconds]
#
# A created instance is not a reachable instance. Linux needs the guest agent to
# publish our key; Windows additionally needs to finish sysprep and install
# OpenSSH, which is far slower (several minutes is normal, not a fault).
gce_wait_ssh() {
  local name="$1" timeout="${2:-600}" waited=0 interval=10
  qa_log "waiting for ssh on $name (timeout ${timeout}s)"
  while (( waited < timeout )); do
    if $GC compute ssh "$name" --zone="$LIBI_QA_ZONE" --tunnel-through-iap \
         --command="echo ready" --quiet >/dev/null 2>&1; then
      qa_log "ssh up on $name after ${waited}s"
      return 0
    fi
    sleep "$interval"
    waited=$(( waited + interval ))
    (( waited % 60 == 0 )) && qa_log "  …still waiting (${waited}s)"
  done
  qa_die "ssh never came up on $name after ${timeout}s"
}

# gce_ssh <name> <command...> — run a command, stream its output.
gce_ssh() {
  local name="$1"; shift
  $GC compute ssh "$name" --zone="$LIBI_QA_ZONE" --tunnel-through-iap \
    --quiet --command="$*"
}

# gce_push <name> <local-path> <remote-path>
gce_push() {
  local name="$1" src="$2" dest="$3"
  $GC compute scp --recurse --zone="$LIBI_QA_ZONE" --tunnel-through-iap --quiet \
    "$src" "$name:$dest"
}

# gce_pull <name> <remote-path> <local-path>
gce_pull() {
  local name="$1" src="$2" dest="$3"
  $GC compute scp --recurse --zone="$LIBI_QA_ZONE" --tunnel-through-iap --quiet \
    "$name:$src" "$dest"
}

# gce_tunnel <name> <port> [port...] — background port-forward so the VM's
# loopback-bound studio can be driven with real browser tooling from this Mac.
# Echoes the pid.
#
# FORWARD MORE THAN THE STUDIO PORT. libi's terminal runs its own WebSocket
# server on a SEPARATE, dynamically chosen port (see `tag:"terminal"
# op:"ws_listen"` in libi.log), and the browser connects to it directly at
# ws://127.0.0.1:<wsPort>. Forward only the studio port and the terminal pane
# renders but stays blank forever, with `ERR_CONNECTION_REFUSED` in the
# console — which looks exactly like a broken PTY and is not one. Cost an
# investigation on 2026-08-16 before the log line explained it.
#
# Read the port out of the VM first:
#   grep -o '"op":"ws_listen","port":[0-9]*' <LIBI_HOME>/logs/libi.log
gce_tunnel() {
  local name="$1"; shift
  local forwards=()
  local p
  for p in "$@"; do forwards+=(-L "${p}:localhost:${p}"); done
  [ ${#forwards[@]} -eq 0 ] && qa_die "gce_tunnel: pass at least one port"
  $GC compute ssh "$name" --zone="$LIBI_QA_ZONE" --tunnel-through-iap --quiet \
    -- -N "${forwards[@]}" &
  echo $!
}

# ── source delivery ───────────────────────────────────────────────────────────

# qa_pack_worktree <dest.tgz>
#
# Ship the WORKING TREE, not a git ref. During the week the changes under test
# are uncommitted-or-unpushed by policy (pushes are weekend-only), so a VM that
# clones from github would build the wrong code and "verify" a fix that isn't
# in it. The Friday release run uses a real tag instead — see the spec.
#
# Tracked files plus untracked-not-ignored, so a brand-new file under test is
# included while node_modules/.next/release are not.
qa_pack_worktree() {
  local dest="$1"
  qa_log "packing working tree ($REPO_ROOT) → $dest"
  # COPYFILE_DISABLE=1 is load-bearing, not hygiene. macOS bsdtar stores each
  # file's extended attributes in an AppleDouble sidecar entry named `._<file>`.
  # Those are invisible on macOS and extract as REAL FILES on Linux — so the VM
  # got `lib/._logger.ts` etc., and esbuild tried to compile all of them:
  #   ✘ [ERROR] Unexpected "\x00"  ×558  →  next-build-release failed
  # A rig artifact masquerading as a libi defect. Belt and braces with
  # --no-xattrs, which newer bsdtar honours directly.
  ( cd "$REPO_ROOT" && git ls-files -z --cached --others --exclude-standard \
      | COPYFILE_DISABLE=1 tar --no-xattrs --null -czf "$dest" -T - 2>/dev/null \
      || cd "$REPO_ROOT" && git ls-files -z --cached --others --exclude-standard \
      | COPYFILE_DISABLE=1 tar --null -czf "$dest" -T - )
  if tar -tzf "$dest" | grep -q '/\._\|^\._'; then
    qa_die "tarball still contains AppleDouble ._ sidecars — they will break the Linux build"
  fi
  local size_kb
  size_kb=$(du -k "$dest" | cut -f1)
  # A real libi source tree is tens of MB. Anything tiny means the file list
  # was empty or truncated — fail loudly rather than ship an empty tarball the
  # VM would spend twenty minutes failing to build.
  if [ "$size_kb" -lt 1000 ]; then
    qa_die "packed tarball is only ${size_kb}KB — the file list is wrong, refusing to upload"
  fi
  qa_log "packed $(du -h "$dest" | cut -f1)"
}
