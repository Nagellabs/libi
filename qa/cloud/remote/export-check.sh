#!/usr/bin/env bash
#
# Runs ON a QA VM against a booted libi. Exercises BOTH export classifier
# families and reports which backend each one actually took.
#
#   ./export-check.sh <studio-port> <libi-home>
#
# Why two pieces rather than one:
#   `lib/export/classifier.ts` picks a backend from the composition's shape. A
#   piece whose only content is a TEXT overlay has no video base to stream-copy
#   or ffmpeg-overlay onto, so it falls through to `chromium-render` — the
#   off-browser Chromium renderer, and by far the likeliest thing to break on a
#   headless box with no GPU. A piece built around a real video file takes the
#   ffmpeg path instead. One piece cannot cover both.
#
# The assertion is deliberately on the OUTPUT FILE, not the job status: an
# export job can report success having written a zero-byte or unplayable file.
# Every produced file is probed with the bundled ffprobe and must report a
# video stream with a non-zero duration.

set -uo pipefail

PORT="${1:?usage: export-check.sh <port> <libi-home>}"
LIBI_HOME="${2:?usage: export-check.sh <port> <libi-home>}"
API="http://localhost:${PORT}/api"
FFMPEG="$LIBI_HOME/bin/ffmpeg"
FFPROBE="$LIBI_HOME/bin/ffprobe"
WORK="$HOME/qa/export-check"

pass=0; fail=0
ok()   { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

rm -rf "$WORK"; mkdir -p "$WORK"

# ── helpers ────────────────────────────────────────────────────────────────
new_piece() {
  curl -s -X POST "$API/pieces" -H 'content-type: application/json' -d '{}' \
    | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1
}

# comp_dim <pieceId> <width|height>
comp_dim() {
  curl -s "$API/pieces/$1/composition" \
    | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2
}

# wait_job <jobId> — poll until terminal, echo the final status
wait_job() {
  local id="$1" i status
  for i in $(seq 1 120); do
    status=$(curl -s "$API/jobs/$id/status" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$status" in
      completed|failed|cancelled|error) echo "$status"; return 0 ;;
    esac
    sleep 5
  done
  echo "timeout"
}

# probe_output <file> — must be a real, playable video
probe_output() {
  local f="$1"
  local dur
  dur=$("$FFPROBE" -v error -select_streams v:0 -show_entries format=duration \
        -of default=nw=1:nk=1 "$f" 2>/dev/null | head -1)
  [ -z "$dur" ] && return 1
  awk -v d="$dur" 'BEGIN{exit !(d+0 > 0)}'
}

# backend_for <jobId> — the backend the export layer actually chose.
backend_for() {
  grep "\"jobId\":\"$1\"" "$LIBI_HOME/logs/libi.log" 2>/dev/null \
    | grep -o '"backend":"[a-z-]*"' | head -1 | cut -d'"' -f4
}

# ── A. text-only → expects the chromium-render fallback ────────────────────
step "A. text-only piece (no video base → chromium-render fallback)"
PA=$(new_piece)
if [ -z "$PA" ]; then bad "could not create a piece"; else ok "piece $PA"; fi
curl -s -X POST "$API/pieces/$PA/overlays" -H 'content-type: application/json' -d '{
  "kind":"text","content":"Linux export check","startTime":0,"duration":3,
  "rect":{"x":40,"y":120,"width":560,"height":120},"z":1
}' -o "$WORK/a-overlay.json"
grep -q '"success":true' "$WORK/a-overlay.json" && ok "text overlay added" \
  || bad "text overlay rejected: $(cat "$WORK/a-overlay.json")"

JA=$(curl -s -X POST "$API/export" -H 'content-type: application/json' \
      -d "{\"pieceId\":\"$PA\",\"filename\":\"qa-text\",\"format\":\"mp4\"}" \
      | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$JA" ]; then bad "export A was not enqueued"; else
  ok "export A job $JA"
  SA=$(wait_job "$JA"); [ "$SA" = "completed" ] && ok "export A status=$SA" || bad "export A status=$SA"
fi

# ── B. real video → expects an ffmpeg backend ──────────────────────────────
#
# The overlay MUST be "base-shaped" or this silently tests nothing new:
# `isBaseShapedVideoOverlay` requires startTime 0, opacity 1, fit cover, the
# lowest z, and a rect EXACTLY equal to the composition's dimensions. Miss any
# of those and `resolveExportBase` returns null, the classifier falls through to
# chromium-render, and the run reports two green exports that both took the SAME
# backend. That is exactly what the first version of this script did.
step "B. video piece (base-shaped overlay → ffmpeg backend)"
PB=$(new_piece)
[ -n "$PB" ] && ok "piece $PB" || bad "could not create a piece"

CW=$(comp_dim "$PB" width); CH=$(comp_dim "$PB" height)
: "${CW:=1920}"; : "${CH:=1080}"
ok "composition is ${CW}x${CH} — generating a clip that matches it exactly"

"$FFMPEG" -y -f lavfi -i "testsrc=size=${CW}x${CH}:rate=30:duration=3" \
          -f lavfi -i sine=frequency=440:duration=3 \
          -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
          "$WORK/clip.mp4" >"$WORK/ffmpeg.log" 2>&1
if [ -s "$WORK/clip.mp4" ]; then ok "fixture clip.mp4 ($(du -h "$WORK/clip.mp4" | cut -f1))"
else bad "could not generate a fixture (see $WORK/ffmpeg.log)"; fi

# mediaWidth/mediaHeight matter: `streamCopyPreservesFraming` compares the
# SOURCE dimensions against the composition, and unknown dimensions disqualify
# the `-c copy` fast path.
curl -s -X POST "$API/pieces/$PB/upload" \
  -F "file=@$WORK/clip.mp4" -F "mediaWidth=$CW" -F "mediaHeight=$CH" -F "mediaDuration=3" \
  -o "$WORK/b-upload.json"
FID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$WORK/b-upload.json" | head -1)
[ -n "$FID" ] && ok "uploaded file $FID" || bad "upload failed: $(head -c 300 "$WORK/b-upload.json")"

if [ -n "$FID" ]; then
  curl -s -X POST "$API/pieces/$PB/overlays" -H 'content-type: application/json' -d "{
    \"kind\":\"video\",\"fileId\":\"$FID\",\"startTime\":0,\"duration\":3,
    \"rect\":{\"x\":0,\"y\":0,\"width\":$CW,\"height\":$CH},\"z\":0
  }" -o "$WORK/b-overlay.json"
  grep -q '"success":true' "$WORK/b-overlay.json" && ok "video overlay added" \
    || bad "video overlay rejected: $(cat "$WORK/b-overlay.json")"

  JB=$(curl -s -X POST "$API/export" -H 'content-type: application/json' \
        -d "{\"pieceId\":\"$PB\",\"filename\":\"qa-video\",\"format\":\"mp4\"}" \
        | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$JB" ]; then bad "export B was not enqueued"; else
    ok "export B job $JB"
    SB=$(wait_job "$JB"); [ "$SB" = "completed" ] && ok "export B status=$SB" || bad "export B status=$SB"
  fi
fi

# ── verify the OUTPUTS, not the statuses ───────────────────────────────────
step "probe every produced file (a 'completed' job can still write garbage)"
found=0
while IFS= read -r f; do
  found=$((found+1))
  if probe_output "$f"; then
    ok "$(basename "$f") is a playable video ($(du -h "$f" | cut -f1))"
  else
    bad "$(basename "$f") exists but ffprobe finds no usable video stream"
  fi
done < <(find "$HOME" -maxdepth 4 -name "qa-text*.mp4" -o -maxdepth 4 -name "qa-video*.mp4" 2>/dev/null)
[ "$found" -eq 0 ] && bad "no exported files found anywhere under \$HOME"

# ── C. base video + a composited overlay → ffmpeg-overlay ──────────────────
#
# `stream-copy-trim` ships the source bytes verbatim, so it can only be used
# when NOTHING has to be drawn on top. Add one flat text overlay above the base
# and the classifier must switch to `ffmpeg-overlay`, which builds a real filter
# graph and RE-ENCODES — a different backend, different ffmpeg invocation, and
# the one that actually exercises drawtext (hence libfreetype) in the binary
# libi downloaded for this platform.
step "C. base video + composited text (→ ffmpeg-overlay, the re-encode graph)"
PC=$(new_piece)
[ -n "$PC" ] && ok "piece $PC" || bad "could not create a piece"

if [ -n "${FID:-}" ] && [ -n "$PC" ]; then
  # Same clip, re-uploaded into this piece: files are piece-scoped.
  curl -s -X POST "$API/pieces/$PC/upload" \
    -F "file=@$WORK/clip.mp4" -F "mediaWidth=$CW" -F "mediaHeight=$CH" -F "mediaDuration=3" \
    -o "$WORK/c-upload.json"
  FIDC=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$WORK/c-upload.json" | head -1)
  [ -n "$FIDC" ] && ok "uploaded file $FIDC" || bad "upload C failed"

  curl -s -X POST "$API/pieces/$PC/overlays" -H 'content-type: application/json' -d "{
    \"kind\":\"video\",\"fileId\":\"$FIDC\",\"startTime\":0,\"duration\":3,
    \"rect\":{\"x\":0,\"y\":0,\"width\":$CW,\"height\":$CH},\"z\":0
  }" -o "$WORK/c-base.json"
  grep -q '"success":true' "$WORK/c-base.json" && ok "base video overlay added" \
    || bad "base overlay rejected: $(cat "$WORK/c-base.json")"

  # Flat text (no place3d / threeD) keeps the ffmpeg drawtext path rather than
  # forcing the chromium fallback.
  curl -s -X POST "$API/pieces/$PC/overlays" -H 'content-type: application/json' -d "{
    \"kind\":\"text\",\"content\":\"overlaid\",\"startTime\":0,\"duration\":3,
    \"rect\":{\"x\":100,\"y\":100,\"width\":800,\"height\":150},\"z\":5
  }" -o "$WORK/c-text.json"
  grep -q '"success":true' "$WORK/c-text.json" && ok "composited text overlay added" \
    || bad "text overlay rejected: $(cat "$WORK/c-text.json")"

  JC=$(curl -s -X POST "$API/export" -H 'content-type: application/json' \
        -d "{\"pieceId\":\"$PC\",\"filename\":\"qa-overlay\",\"format\":\"mp4\"}" \
        | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$JC" ]; then bad "export C was not enqueued"; else
    ok "export C job $JC"
    SC=$(wait_job "$JC"); [ "$SC" = "completed" ] && ok "export C status=$SC" || bad "export C status=$SC"
  fi
fi

# ── the assertion that makes this test worth running ───────────────────────
step "backends actually chosen — they MUST differ"
BA=$(backend_for "${JA:-none}"); BB=$(backend_for "${JB:-none}")
BC=$(backend_for "${JC:-none}")
echo "  A (text-only)        → ${BA:-unknown}"
echo "  B (base video)       → ${BB:-unknown}"
echo "  C (base + composite) → ${BC:-unknown}"
case "$BC" in
  ffmpeg-overlay) ok "C took the re-encode graph as intended ($BC)" ;;
  *) bad "C took '$BC' — expected ffmpeg-overlay for a base + composited overlay" ;;
esac

case "$BA" in
  chromium-render|canvas-source) ok "A took the render fallback as intended ($BA)" ;;
  *) bad "A took '$BA' — expected the render fallback for a text-only piece" ;;
esac
case "$BB" in
  stream-copy-trim|ffmpeg-overlay) ok "B took an ffmpeg backend as intended ($BB)" ;;
  *) bad "B took '$BB' — expected an ffmpeg backend for a base-shaped video piece" ;;
esac
# Three cases must produce THREE distinct backends. Any collision means this
# run covered fewer code paths than its pass count implies — the exact false
# green the first version of this script produced.
distinct=$(printf '%s\n%s\n%s\n' "$BA" "$BB" "$BC" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
if [ "$distinct" -eq 3 ]; then
  ok "three cases, three distinct backends — every path genuinely covered"
else
  bad "only $distinct distinct backend(s) across three cases — a case silently duplicated another"
fi

# ── the media pipeline every import triggers ───────────────────────────────
#
# Uploading a video kicks off proxy generation and a filmstrip. Both are pure
# ffmpeg, both run for EVERY user who imports footage, and both are invisible
# until they fail — the editor just never gets a scrub-friendly proxy or a
# timeline thumbnail strip. Cheap to assert here, so assert it.
# Proxy and filmstrip generation are LAZY, not eager-on-import: proxies are
# enqueued on demand (lib/proxy/enqueue.ts) and a 3-second clip that is already
# ≤1080p may legitimately never need one — a proxy IS a ≤1080p scrub-friendly
# stand-in, so for this fixture it would be a stand-in for itself.
#
# So this reports rather than asserts. If either pipeline DID run, an error in
# it is a real failure and is treated as one; silence is recorded as
# "not exercised", which is honest, instead of a red FAIL for a job that had no
# reason to run or a green PASS for one that never ran.
step "media pipeline: proxy + filmstrip (lazy — reported, not asserted)"
sleep 10
for tag in proxy filmstrip; do
  # `grep -c` PRINTS 0 and EXITS 1 on no match, so `|| echo 0` appended a
  # second line and `[ "$n" -gt 0 ]` then died with "integer expression
  # expected". Let the printed 0 stand and swallow the exit status.
  n=$(grep -c "\"tag\":\"$tag\"" "$LIBI_HOME/logs/libi.log" 2>/dev/null || true)
  [ -z "$n" ] && n=0
  if [ "$n" -gt 0 ]; then
    errs=$(grep "\"tag\":\"$tag\"" "$LIBI_HOME/logs/libi.log" | grep -c '"level":50\|"level":60')
    if [ "$errs" -eq 0 ]; then
      ok "$tag ran clean ($n events)"
    else
      bad "$tag logged $errs error-level event(s)"
      grep "\"tag\":\"$tag\"" "$LIBI_HOME/logs/libi.log" | grep '"level":50\|"level":60' | tail -2 | cut -c1-220
    fi
  else
    echo "  NOT EXERCISED  $tag — nothing requested one for this fixture"
  fi
done

step "uv (the python toolchain local models depend on)"
if "$LIBI_HOME/bin/uv" --version >/dev/null 2>&1; then
  ok "uv runs: $("$LIBI_HOME/bin/uv" --version 2>&1 | head -1)"
else
  bad "uv did not execute — every local-model path depends on it"
fi

printf '\n\033[1m== %d passed, %d failed ==\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
