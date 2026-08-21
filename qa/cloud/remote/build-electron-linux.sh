#!/usr/bin/env bash
#
# Runs ON the Ubuntu QA VM. Builds the Linux desktop artifacts (AppImage + deb)
# from an uploaded working-tree tarball.
#
# Detached by the caller (nohup) because `npm ci` + `next build` +
# build-runtime-bundle + electron-builder is a 20-40 minute job and an SSH
# session that drops mid-build would take the build with it.
#
# Everything is logged to ~/build.log with timestamps, so a poll can tell
# "still compiling" from "wedged" without re-running anything.

set -euo pipefail

SRC_TGZ="${1:-$HOME/libi-src.tgz}"
BUILD_DIR="${2:-$HOME/build}"

step() { printf '\n\033[1;35m[build %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }

step "unpacking $SRC_TGZ → $BUILD_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
tar -xzf "$SRC_TGZ" -C "$BUILD_DIR"
cd "$BUILD_DIR"
echo "  $(find . -maxdepth 1 -type f | wc -l) root files, package.json version: $(node -p 'require("./package.json").version')"

step "npm ci"
# Not `npm install`: the lockfile is the point. A resolution that drifts on the
# QA box would mean we tested something other than what ships.
npm ci --no-audit --no-fund

step "npm run build:electron"
# prebuild:electron runs the third-party-notices check and fetches the Electron
# binary; build:electron then does rebuild-for-electron → compile:electron →
# next-build-release → build-runtime-bundle → electron-builder.
#
# electron-builder is NOT given an explicit --linux: electron-builder.yml
# already declares linux targets and defaults to the host platform, which here
# IS linux. Passing it explicitly would diverge from what the release script
# will eventually do.
npm run build:electron

step "artifacts"
ls -lh release/ 2>/dev/null || echo "  NO release/ DIRECTORY — build produced nothing"

step "done"
