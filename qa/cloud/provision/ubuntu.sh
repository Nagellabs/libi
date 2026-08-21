#!/usr/bin/env bash
#
# Runs ON the Ubuntu QA VM. Idempotent — safe to re-run while iterating, which
# is the point: re-provisioning is cheap, recreating the VM is not.
#
# Installs only what BUILDING and RUNNING libi needs. Deliberately NOT ffmpeg,
# ffprobe, uv, or Chromium: libi provisions those itself in Category A, and
# that provisioning is precisely what this rig exists to test. An apt-installed
# ffmpeg on PATH would mask a broken download URL and turn a real finding into
# a false pass.

set -euo pipefail

log() { printf '\033[1;36m[provision]\033[0m %s\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive

log "apt update"
sudo apt-get update -qq

# Node 22. Ubuntu 24.04 ships Node 18, below libi's MIN_NODE_MAJOR of 20, and a
# user on 18 is a separate test case — not the baseline we want here.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
log "node $(node -v), npm $(npm -v)"

# Build toolchain + Electron's runtime libraries.
#
# The `t64` suffixes are NOT typos: Ubuntu 24.04's 64-bit time_t transition
# renamed libasound2 → libasound2t64, libgtk-3-0 → libgtk-3-0t64, and friends.
# Every electron-on-linux guide written before 2024 lists the old names, all of
# which fail to resolve on noble.
log "installing build + electron runtime deps"
sudo apt-get install -y -qq \
  build-essential python3 python3-venv git rsync jq \
  fakeroot dpkg-dev \
  libfuse2t64 \
  xvfb \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libgtk-3-0t64 libgbm1 libasound2t64 libxshmfence1 libxdamage1 \
  libxrandr2 libxcomposite1 libxkbcommon0 libpango-1.0-0 libcairo2

log "versions"
echo "  node    $(node -v)"
echo "  npm     $(npm -v)"
echo "  python3 $(python3 --version 2>&1)"
echo "  arch    $(uname -m)"
echo "  kernel  $(uname -r)"
echo "  distro  $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  cpus    $(nproc)"
echo "  memory  $(free -h | awk '/^Mem:/{print $2}')"
echo "  disk    $(df -h / | awk 'NR==2{print $4" free of "$2}')"

log "done"
