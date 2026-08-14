#!/usr/bin/env bash
# Regenerate test fixtures under __tests__/helpers/fixtures/video.
# Run manually after editing; outputs are committed.
set -euo pipefail
cd "$(dirname "$0")"

# clip-red-3s.mp4 — 3s, 320x240, solid red, AAC 1kHz sine at -20dB
ffmpeg -y \
  -f lavfi -i "color=c=red:s=320x240:d=3:r=24" \
  -f lavfi -i "sine=frequency=1000:duration=3" \
  -filter:a "volume=-20dB" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
  -c:a aac -b:a 96k \
  -shortest clip-red-3s.mp4

# clip-green-3s.mp4 — 3s, 320x240, solid green, AAC 440Hz sine
ffmpeg -y \
  -f lavfi -i "color=c=green:s=320x240:d=3:r=24" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -filter:a "volume=-20dB" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
  -c:a aac -b:a 96k \
  -shortest clip-green-3s.mp4

# tone-5s.m4a — 5s mono AAC tone at 660Hz
ffmpeg -y \
  -f lavfi -i "sine=frequency=660:duration=5" \
  -c:a aac -b:a 96k tone-5s.m4a

# logo-64.png — 64x64 solid blue PNG
ffmpeg -y -f lavfi -i "color=c=blue:s=64x64:d=1" -frames:v 1 -update 1 logo-64.png
