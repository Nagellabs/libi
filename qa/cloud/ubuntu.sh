#!/usr/bin/env bash
#
# One command: create an Ubuntu QA VM, provision it, build the Linux desktop
# artifacts from the local working tree, and leave it running for interactive
# verification.
#
#   qa/cloud/ubuntu.sh                # build + leave the VM up to drive
#   qa/cloud/ubuntu.sh --destroy      # tear down and exit
#   qa/cloud/ubuntu.sh --npx-only     # skip the desktop build
#
# The VM is NOT auto-destroyed on success: the whole point of a build run is to
# then drive the app on it. `--max-run-duration` still guarantees GCE deletes
# it, so forgetting costs hours, never a month. Destroy explicitly when done.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gce.sh
source "$HERE/lib/gce.sh"

VM="${LIBI_QA_UBUNTU_VM:-libi-qa-ubuntu}"
MACHINE="${LIBI_QA_UBUNTU_MACHINE:-e2-standard-8}"
DISK="${LIBI_QA_UBUNTU_DISK:-100}"
NPX_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --destroy) gce_destroy "$VM"; exit 0 ;;
    --npx-only) NPX_ONLY=1 ;;
    *) qa_die "unknown flag: $arg" ;;
  esac
done

TARBALL="${TMPDIR:-/tmp}/libi-src-$$.tgz"
trap 'rm -f "$TARBALL"' EXIT

qa_log "=== 1/5 create ==="
gce_create "$VM" linux "$MACHINE" "$DISK"
gce_wait_ssh "$VM" 600

qa_log "=== 2/5 provision ==="
gce_push "$VM" "$HERE/provision/ubuntu.sh" '~/provision-ubuntu.sh'
gce_ssh "$VM" 'chmod +x ~/provision-ubuntu.sh && ~/provision-ubuntu.sh'

qa_log "=== 3/5 upload source ==="
qa_pack_worktree "$TARBALL"
gce_push "$VM" "$TARBALL" '~/libi-src.tgz'
gce_push "$VM" "$HERE/remote/build-electron-linux.sh" '~/build-electron-linux.sh'

if [ "$NPX_ONLY" -eq 1 ]; then
  qa_log "=== 4/5 skipped (--npx-only) ==="
else
  qa_log "=== 4/5 build (detached; poll ~/build.log on the VM) ==="
  gce_ssh "$VM" 'chmod +x ~/build-electron-linux.sh && nohup ~/build-electron-linux.sh > ~/build.log 2>&1 & echo started'
fi

qa_log "=== 5/5 VM is up ==="
cat <<EOF

  poll     gcloud compute ssh $VM --zone=$LIBI_QA_ZONE --tunnel-through-iap \\
             --project=$LIBI_QA_PROJECT --command='tail -20 ~/build.log'
  tunnel   gcloud compute ssh $VM --zone=$LIBI_QA_ZONE --tunnel-through-iap \\
             --project=$LIBI_QA_PROJECT -- -N -L 4111:localhost:<port>
  destroy  $0 --destroy

EOF
