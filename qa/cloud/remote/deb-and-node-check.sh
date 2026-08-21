#!/usr/bin/env bash
#
# Runs ON the Ubuntu QA VM. Closes two Linux gaps a build alone cannot:
#
#   G1  the .deb is a SHIPPING artifact — "it builds" is not "it installs".
#       dpkg -i it as a real user would, then launch the INSTALLED binary
#       (not the one in release/) and check it serves the studio.
#
#   G3  the managed linux-x64 Node download. Category A only fetches it when
#       no system node clears MIN_NODE_MAJOR (20). Every run so far had Node 22
#       from this rig's own provisioning, which MASKED the path entirely — so
#       the pinned sha256 for node-<v>-linux-x64.tar.gz has never been checked
#       against a real download. Stock Ubuntu 24.04 ships Node 18, so real
#       users DO hit this, and a wrong hash bricks them at first boot.
#
# G3 works by hiding the system node rather than uninstalling it: the AppImage
# is Electron and carries its own runtime, so it boots fine without one.
# Everything is restored in a trap, even on failure.

set -uo pipefail

DEB="${1:?usage: deb-and-node-check.sh <path-to-deb>}"
pass=0; fail=0
ok()   { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

# ── G1: install the deb ────────────────────────────────────────────────────
#
# `apt install ./file.deb`, NOT `dpkg -i`. dpkg does not resolve dependencies —
# by design — so `dpkg -i` fails on any package that declares them and leaves it
# half-installed in `iU`. That is dpkg behaving correctly, not a packaging bug,
# and it is what a first version of this check misreported as a shipping defect.
# What a real user actually does is double-click the file (a graphical installer
# resolves deps) or run `apt install ./…`, so that is what we test.
#
# This VM is a minimal server image, so the desktop libraries the package
# depends on (libnotify4, libxss1, xdg-utils, libsecret-1-0) are genuinely
# absent here and apt has to fetch them — which makes this a STRONGER test than
# a desktop machine, where they would already be present and a wrong dependency
# list would go unnoticed.
step "G1. install the shipping .deb the way a user does (apt resolves deps)"
sudo apt-get update -qq >/dev/null 2>&1
sudo apt-get install -y -qq "$DEB" >/tmp/dpkg.log 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "apt install succeeded (dependencies resolved)"
  echo "     pulled in: $(grep -oE "libnotify4|libxss1|xdg-utils|libsecret-1-0" /tmp/dpkg.log | sort -u | tr '\n' ' ')"
else
  bad "apt install failed (rc=$rc): $(tail -4 /tmp/dpkg.log | tr '\n' ' ')"
fi

# `ii` = installed AND configured. `iU` means the postinst never ran, which is
# what leaves the /usr/bin symlink missing.
state=$(dpkg -l libi 2>/dev/null | awk '/^[a-z]{2}/{print $1}' | head -1)
[ "$state" = "ii" ] && ok "package state is 'ii' (installed + configured)" \
  || bad "package state is '$state' — not fully configured"

step "what did it put on the system?"
dpkg -L libi 2>/dev/null | grep -E "\.desktop$|^/opt/Libi/libi$" | head -4

# Look on the FILESYSTEM, not in `dpkg -L`. electron-builder's postinst creates
# the launcher with `update-alternatives --install /usr/bin/libi …` AFTER
# unpacking, so it is not a packaged file and never appears in `dpkg -L`.
# Checking the manifest instead reported a perfectly good package as having no
# launcher.
BIN=$(command -v libi 2>/dev/null)
if [ -n "$BIN" ]; then
  ok "launcher on PATH: $BIN → $(readlink -f "$BIN")"
else
  [ -x /opt/Libi/libi ] && { BIN=/opt/Libi/libi; bad "no /usr/bin/libi symlink — postinst's update-alternatives did not run"; } \
                        || bad "no launcher anywhere: neither /usr/bin/libi nor /opt/Libi/libi"
fi
DESKTOP=$(dpkg -L libi 2>/dev/null | grep "\.desktop$" | head -1)
if [ -n "$DESKTOP" ]; then
  ok "desktop entry: $DESKTOP"
  # The executableName override exists because packaging identity was once
  # derived from the npm registry name (@nagellabslibi). Prove it stuck.
  if grep -qi "nagellabs" "$DESKTOP" 2>/dev/null; then
    bad "desktop entry still carries the scoped npm name: $(grep -i exec "$DESKTOP" | head -1)"
  else
    ok "desktop entry Exec is clean: $(grep -i "^Exec" "$DESKTOP" | head -1)"
  fi
else
  bad "no .desktop entry — the app would not appear in the launcher"
fi

step "boot the INSTALLED binary (not the one in release/)"
if [ -n "$BIN" ]; then
  rm -rf ~/qa/debhome && mkdir -p ~/qa/debhome
  LIBI_HOME=~/qa/debhome nohup xvfb-run -a "$BIN" --no-sandbox >~/deb-boot.log 2>&1 &
  for i in $(seq 1 60); do
    [ -s ~/qa/debhome/port ] && break
    sleep 5
  done
  P=$(cat ~/qa/debhome/port 2>/dev/null)
  if [ -n "$P" ] && curl -sf --max-time 10 "http://localhost:$P/api/runtime" >/dev/null; then
    ok "installed .deb boots and serves the studio on port $P"
    echo "     $(curl -s --max-time 10 "http://localhost:$P/api/runtime/update" | head -c 120)"
  else
    bad "installed .deb did not serve the studio (see ~/deb-boot.log)"
  fi
  pkill -f "$BIN" 2>/dev/null
fi

# ── G3: managed node download ──────────────────────────────────────────────
step "G3. force the managed linux-x64 Node download (hide the system node)"

NODE_REAL=$(command -v node 2>/dev/null)
restore_node() {
  if [ -n "${NODE_REAL:-}" ] && [ -f "${NODE_REAL}.qa-hidden" ]; then
    sudo mv "${NODE_REAL}.qa-hidden" "$NODE_REAL"
    echo "  (restored $NODE_REAL)"
  fi
}
trap restore_node EXIT

if [ -z "$NODE_REAL" ]; then
  bad "no system node found to hide — cannot set up this test"
else
  sudo mv "$NODE_REAL" "${NODE_REAL}.qa-hidden"
  if command -v node >/dev/null 2>&1; then
    bad "node still resolves after hiding it — another copy is on PATH: $(command -v node)"
  else
    ok "system node hidden — Category A must now fetch its own"
  fi

  rm -rf ~/qa/nodehome && mkdir -p ~/qa/nodehome
  # The Electron AppImage carries its own runtime, so it starts without a
  # system node; Category A is what has to go and get one.
  LIBI_HOME=~/qa/nodehome nohup xvfb-run -a "$HOME/build/release/Libi-0.1.1.AppImage" \
    --no-sandbox >~/nodeboot.log 2>&1 &

  for i in $(seq 1 90); do
    [ -s ~/qa/nodehome/port ] && break
    sleep 5
  done

  MANAGED=~/qa/nodehome/bin/node
  if [ -e "$MANAGED" ] && [ ! -L "$MANAGED" ]; then
    ok "managed node was DOWNLOADED (a real file, not a symlink to the system one)"
    echo "     version: $("$MANAGED" -v 2>&1 | head -1)"
    echo "     size:    $(du -h "$MANAGED" | cut -f1)"
    # This is the assertion that matters: the pinned sha256 in
    # lib/runtime/node-runtime.ts is only meaningful if the downloaded binary
    # actually RUNS. A mismatched hash should have aborted the install.
    if "$MANAGED" -e 'process.exit(0)' 2>/dev/null; then
      ok "downloaded node executes — the pinned linux-x64 sha256 is good"
    else
      bad "downloaded node does not execute — pinned sha256 or archive layout is wrong"
    fi
  elif [ -L "$MANAGED" ]; then
    bad "bin/node is still a symlink ($(readlink "$MANAGED")) — the download path did not run"
  else
    bad "no managed node at $MANAGED (see ~/nodeboot.log)"
  fi

  P2=$(cat ~/qa/nodehome/port 2>/dev/null)
  if [ -n "$P2" ] && curl -sf --max-time 10 "http://localhost:$P2/api/runtime" >/dev/null; then
    ok "libi boots correctly with NO system node at all"
  else
    bad "libi did not come up without a system node (see ~/nodeboot.log)"
  fi
  pkill -f "Libi-0.1.1.AppImage" 2>/dev/null
fi

printf '\n\033[1m== %d passed, %d failed ==\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
