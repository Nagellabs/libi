#!/usr/bin/env bash
#
# Publish the onboarding demo's media to the public GCS bucket.
#
# A fresh install's "show me how it works" downloads 21 files from
# https://storage.googleapis.com/libi-public-assets/onboarding/<version>/<slug>
# and hard-fails on any sha256 mismatch. Until those objects exist with the
# pinned bytes, the onboarding demo is broken for every new user. This script
# is what puts them there.
#
#   bash scripts/publish-onboarding-assets.sh --version v1              # plan only
#   bash scripts/publish-onboarding-assets.sh --version v1 --execute    # publish
#   bash scripts/publish-onboarding-assets.sh --version v1 --verify-only
#
# ── Three properties this script exists to guarantee ───────────────────────
#
# 1. DRY RUN IS THE DEFAULT. Publishing takes an explicit --execute. A stray
#    invocation — a shell-history arrow-up, a copy-paste into the wrong
#    terminal — prints a plan and touches nothing. The dry run needs no
#    credentials at all: it is arithmetic over local files.
#
# 2. IT NEVER CHANGES WHAT A PUBLISHED URL SERVES. Objects ship
#    `Cache-Control: public, max-age=31536000, immutable`, so a client that has
#    fetched one may hold it for a year. That is why the version lives in the
#    PATH: a v2 film publishes to onboarding/v2/ and every already-released
#    client keeps working off onboarding/v1/ forever. Replacing bytes at a
#    published URL would mean some users get the new file, some get the old
#    one out of cache, and the ones in between get a sha256 mismatch and a
#    failed build.
#
#    The guard decides on BYTES, not on existence. Every occupied destination
#    is fetched over its public URL and hashed before anything is uploaded. If
#    all of them match the pinned records, this is our own interrupted run and
#    it resumes; if any differs — or cannot be read, so cannot be proved — it
#    aborts and tells you to publish a new version directory. Refusing on mere
#    existence would enforce the same property while also forbidding the one
#    thing you will actually need at 11pm: re-running after object 12 of 21
#    died on a transient 503.
#
# 3. IT VERIFIES AS A STRANGER WOULD. After upload every object is re-fetched
#    over plain HTTPS with `curl -q` — no gcloud, no credentials, no .curlrc —
#    and hashed against the pinned record. `gcloud` reading the bucket back
#    proves only that WE can read it, which is not the question. The question
#    is whether a brand-new user on a fresh machine can, and only an
#    unauthenticated GET answers it.
#
# ── The bytes are not reproducible ─────────────────────────────────────────
#
# Three of the 21 are CRF-20 x264 re-encodes, and x264 output is
# encoder-build dependent — re-running the recorded ffmpeg command will NOT
# reproduce the pinned hashes. The bytes exist in exactly two places:
#
#   docs-local/onboarding-v1/assets/                (gitignored, this repo)
#   ~/Documents/dev/libi-onboarding-assets-v1/      (backup, see ENCODER.txt)
#
# So the script hashes every staged file and compares it to
# lib/onboarding/piece/<version>/assets.ts BEFORE it does anything else. A
# divergence is caught while it is still a local problem, not after it is a
# published one.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────

BUCKET="libi-public-assets"
PROJECT="libi-prod"
PROJECT_NUMBER="444646001209"
LOCATION="US"
CACHE_CONTROL="public, max-age=31536000, immutable"

# Written out in full, not composed from $BUCKET, so that a test can assert it
# is character-for-character DEFAULT_ONBOARDING_ASSET_BASE from
# lib/onboarding/piece/asset-base.ts. Publishing to a prefix the runtime does
# not read from is a silent, expensive mistake.
PUBLIC_BASE="https://storage.googleapis.com/libi-public-assets/onboarding"

VERSION="v1"
DRY_RUN=1
VERIFY_ONLY=0
ASSETS_DIR=""
FALLBACK_ASSETS_DIR="${HOME}/Documents/dev/libi-onboarding-assets-v1"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Publish the onboarding demo's media to gs://libi-public-assets.

  bash scripts/publish-onboarding-assets.sh --version v1              # plan only
  bash scripts/publish-onboarding-assets.sh --version v1 --execute    # publish
  bash scripts/publish-onboarding-assets.sh --version v1 --verify-only

Dry run is the default and needs no credentials. Read the comment header of
this file before using --execute: the bytes are not reproducible and objects
are published immutable for a year.

Options:
  --version <vN>     Version directory to publish (default: v1).
  --execute          Actually create the bucket and upload. Without it,
                     nothing outside this machine is touched.
  --verify-only      Skip upload; only re-fetch and hash-check what is
                     already published. Read-only, unauthenticated.
  --assets-dir <d>   Where the staged bytes are (default:
                     docs-local/onboarding-<version>/assets, falling back to
                     the backup copy under ~/Documents/dev/).
  -h, --help         This text.
USAGE
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

# ── Arguments ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version needs a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --execute)
      DRY_RUN=0
      shift
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --assets-dir)
      [[ $# -ge 2 ]] || die "--assets-dir needs a value"
      ASSETS_DIR="$2"
      shift 2
      ;;
    --assets-dir=*)
      ASSETS_DIR="${1#--assets-dir=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

# One path segment, and the shape the runtime's own guard accepts. Validated
# rather than trusted: VERSION is interpolated into both an object path and a
# URL, and "../.." would quietly rebase everything on the bucket root.
[[ "$VERSION" =~ ^v[0-9]+$ ]] || die "--version must look like v1, v2, … (got: ${VERSION})"

# A third, independent statement of what v1 IS. assets.ts and manifest.json are
# generated from the same records, so they agree with each other even when both
# are wrong in the same way — truncate both to 3 records and the script would
# happily publish 3 objects and report success. These two numbers are written by
# hand and asserted against by a test that sums ONBOARDING_ASSETS_V1 itself.
EXPECTED_OBJECTS=""
EXPECTED_BYTES=""
case "$VERSION" in
  v1) EXPECTED_OBJECTS=21; EXPECTED_BYTES=14796113 ;;
esac

VERSION_UPPER="$(printf '%s' "$VERSION" | tr '[:lower:]' '[:upper:]')"
OBJECT_PREFIX="onboarding/${VERSION}/"
BASE_URL="${PUBLIC_BASE}/${VERSION}"

MANIFEST="${REPO_ROOT}/docs-local/onboarding-${VERSION}/manifest.json"
PINNED_TS="${REPO_ROOT}/lib/onboarding/piece/${VERSION}/assets.ts"
ASSET_BASE_TS="${REPO_ROOT}/lib/onboarding/piece/asset-base.ts"

if [[ -z "$ASSETS_DIR" ]]; then
  ASSETS_DIR="${REPO_ROOT}/docs-local/onboarding-${VERSION}/assets"
  if [[ ! -d "$ASSETS_DIR" && -d "$FALLBACK_ASSETS_DIR" ]]; then
    printf 'NOTE: %s is missing; using the backup copy at %s\n' \
      "$ASSETS_DIR" "$FALLBACK_ASSETS_DIR"
    ASSETS_DIR="$FALLBACK_ASSETS_DIR"
  fi
fi

[[ "$PUBLIC_BASE" == *"/${BUCKET}/"* ]] \
  || die "PUBLIC_BASE (${PUBLIC_BASE}) does not name bucket ${BUCKET}"

# ── Helpers ────────────────────────────────────────────────────────────────

# Every state-changing command goes through here. In a dry run it prints what
# it would have done and returns success; nothing else in this file is allowed
# to call gcloud with a verb that writes.
mutate() {
  # %q so the printed line is copy-pasteable: `--cache-control=public, max-age=…`
  # is ONE argument, and echoing it unquoted would suggest otherwise.
  local shown
  shown="$(printf '%q ' "$@")"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '    would run: %s\n' "$shown"
    return 0
  fi
  printf '    running: %s\n' "$shown"
  "$@"
}

# The ONLY way a read-only gcloud call is made. Reads are allowed outside the
# dry-run gate (a dry run makes none at all — it exits before this point), but
# they still go through one named door so a test can tell a read from a write
# instead of matching verbs against a list that will go stale.
gcloud_read() {
  gcloud "$@"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "neither shasum nor sha256sum is available"
  fi
}

# `wc -c` rather than stat, whose flags differ between BSD and GNU.
size_of() {
  wc -c < "$1" | tr -d '[:space:]'
}

# Fetch $1 over plain HTTPS as a stranger would: no gcloud, no credentials, and
# `-q` so a ~/.curlrc on this machine cannot inject any. Body to $2, response
# headers to $3. This is the ONLY way this script reads a published object —
# a `gcloud` read would prove that WE can reach it, which is not the question.
fetch_public() {
  curl -q -fsS --retry 3 --retry-delay 2 --max-time 300 -D "$3" -o "$2" "$1"
}

# Last value of a response header, name matched case-insensitively. A redirect
# chain writes several blocks into one dump; the last one is the real response.
header_value() {
  tr -d '\r' < "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -n "s/^$2: *//p" \
    | tail -1
}

TMPDIR_RUN="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_RUN"; }
trap cleanup EXIT

# A Ctrl-C during upload is the case most likely to leave a half-published
# version behind, and the worst moment to give the operator no information.
on_interrupt() {
  upload_progress_summary
  exit 130
}
trap on_interrupt INT TERM

# ── Step 1: reconcile the pinned records with the manifest ─────────────────
#
# assets.ts is what the RUNTIME checks downloads against; manifest.json is what
# the extractor wrote. They are generated from the same records, so any
# disagreement means one of them was edited by hand and we do not know which
# one is right. Node does the parsing so the script needs neither jq nor tsx.

echo "libi onboarding asset publish"
echo "  version        ${VERSION}"
echo "  bucket         gs://${BUCKET}  (project ${PROJECT}, ${PROJECT_NUMBER})"
echo "  object prefix  ${OBJECT_PREFIX}"
echo "  public base    ${BASE_URL}"
echo "  staged bytes   ${ASSETS_DIR}"
echo

[[ -f "$MANIFEST" ]] || die "manifest not found: ${MANIFEST}"
[[ -f "$PINNED_TS" ]] || die "pinned records not found: ${PINNED_TS}"
[[ -d "$ASSETS_DIR" ]] || die "staged assets directory not found: ${ASSETS_DIR}
The bytes are not reproducible — see the header of this script for the two
places they live."

RECORDS="${TMPDIR_RUN}/records.tsv"

node - "$PINNED_TS" "$MANIFEST" "$ASSET_BASE_TS" "$VERSION_UPPER" "$PUBLIC_BASE" \
  > "$RECORDS" <<'NODE'
const fs = require("node:fs");
const [tsPath, manifestPath, assetBasePath, versionUpper, publicBase] =
  process.argv.slice(2);

const fail = (msg) => {
  process.stderr.write(`preflight: ${msg}\n`);
  process.exit(1);
};

// --- the pinned records the runtime verifies downloads against -------------
const exportName = `ONBOARDING_ASSETS_${versionUpper}`;
const ts = fs.readFileSync(tsPath, "utf8");
const start = ts.indexOf(`export const ${exportName}`);
if (start === -1) fail(`${tsPath} has no ${exportName} export`);
const end = ts.indexOf("\n];", start);
if (end === -1) fail(`${tsPath}: could not find the end of ${exportName}`);
const body = ts.slice(start, end);

const RECORD =
  /\{\s*slug:\s*"([^"]+)",\s*kind:\s*"([^"]+)",\s*bytes:\s*(\d+),\s*sha256:\s*"([0-9a-f]{64})",\s*contentType:\s*"([^"]+)",?\s*\}/g;
const pinned = [];
for (const m of body.matchAll(RECORD)) {
  pinned.push({
    slug: m[1],
    kind: m[2],
    bytes: Number(m[3]),
    sha256: m[4],
    contentType: m[5],
  });
}
if (pinned.length === 0) {
  fail(
    `${tsPath}: parsed 0 records out of ${exportName}. The generated field ` +
      `order (slug, kind, bytes, sha256, contentType) probably changed — ` +
      `fix the regex in this script rather than publishing unverified bytes.`,
  );
}

// --- the manifest the extractor wrote -------------------------------------
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`${manifestPath} is not valid JSON: ${e.message}`);
}
const staged = Array.isArray(manifest.assets) ? manifest.assets : null;
if (!staged) fail(`${manifestPath} has no "assets" array`);

// --- they must agree, exactly ---------------------------------------------
const key = (a) => `${a.slug}|${a.bytes}|${a.sha256}|${a.contentType}`;
const pinnedByS = new Map(pinned.map((a) => [a.slug, a]));
const stagedByS = new Map(staged.map((a) => [a.slug, a]));
const problems = [];
if (pinned.length !== staged.length) {
  problems.push(
    `count: assets.ts has ${pinned.length}, manifest.json has ${staged.length}`,
  );
}
for (const [slug, a] of pinnedByS) {
  const b = stagedByS.get(slug);
  if (!b) {
    problems.push(`${slug}: pinned in assets.ts, absent from manifest.json`);
  } else if (key(a) !== key(b)) {
    problems.push(`${slug}: assets.ts ${key(a)} != manifest.json ${key(b)}`);
  }
}
for (const slug of stagedByS.keys()) {
  if (!pinnedByS.has(slug)) {
    problems.push(`${slug}: in manifest.json, not pinned in assets.ts`);
  }
}

// --- and the URL we publish to must be the URL the runtime reads from ------
const assetBase = fs.readFileSync(assetBasePath, "utf8");
if (!assetBase.includes(`"${publicBase}"`)) {
  problems.push(
    `${assetBasePath} does not declare ${publicBase} as ` +
      `DEFAULT_ONBOARDING_ASSET_BASE — publishing there would put the files ` +
      `somewhere no install downloads from`,
  );
}

if (problems.length) {
  fail(`records disagree, refusing to publish:\n  - ${problems.join("\n  - ")}`);
}

for (const a of pinned) {
  process.stdout.write(
    [a.slug, String(a.bytes), a.sha256, a.contentType].join("\t") + "\n",
  );
}
NODE

echo "Preflight: assets.ts and manifest.json agree, and both name ${PUBLIC_BASE}."

# ── Step 2: the staged bytes must BE the pinned bytes ──────────────────────

PLANNED=0
TOTAL_BYTES=0
MISMATCHES=0

echo
echo "Plan — objects that would be published to gs://${BUCKET}/${OBJECT_PREFIX}"
echo

while IFS=$'\t' read -r slug bytes sha ctype; do
  [[ -n "$slug" ]] || continue
  local_file="${ASSETS_DIR}/${slug}"
  if [[ ! -f "$local_file" ]]; then
    printf '  MISSING  %-24s (expected at %s)\n' "$slug" "$local_file"
    MISMATCHES=$((MISMATCHES + 1))
    continue
  fi
  actual_size="$(size_of "$local_file")"
  actual_sha="$(sha256_of "$local_file")"
  if [[ "$actual_size" != "$bytes" ]]; then
    printf '  BAD SIZE %-24s pinned %s, staged %s\n' "$slug" "$bytes" "$actual_size"
    MISMATCHES=$((MISMATCHES + 1))
    continue
  fi
  if [[ "$actual_sha" != "$sha" ]]; then
    printf '  BAD HASH %-24s pinned %s\n' "$slug" "$sha"
    printf '           %-24s staged %s\n' "" "$actual_sha"
    MISMATCHES=$((MISMATCHES + 1))
    continue
  fi
  printf '  ok  %-24s %10s bytes  %-10s -> %s%s\n' \
    "$slug" "$bytes" "$ctype" "$OBJECT_PREFIX" "$slug"
  PLANNED=$((PLANNED + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + bytes))
done < "$RECORDS"

if [[ "$MISMATCHES" -gt 0 ]]; then
  die "${MISMATCHES} staged file(s) do not match the pinned records.
These bytes are NOT reproducible — do not re-encode to make them match. Get
the originals from ~/Documents/dev/libi-onboarding-assets-v1/ (ENCODER.txt),
or re-run the extractor to mint new hashes and re-verify the film."
fi

if [[ -n "$EXPECTED_OBJECTS" ]]; then
  if [[ "$PLANNED" != "$EXPECTED_OBJECTS" || "$TOTAL_BYTES" != "$EXPECTED_BYTES" ]]; then
    die "${VERSION} is ${EXPECTED_OBJECTS} objects / ${EXPECTED_BYTES} bytes, but this
run assembled ${PLANNED} objects / ${TOTAL_BYTES} bytes.
assets.ts and manifest.json agreeing with each other does not make them right —
they are generated from the same records. Something dropped or added assets in
both. Do not publish a partial film."
  fi
else
  printf 'NOTE: no expected object count is recorded for %s — publishing what\n' "$VERSION"
  printf '      assets.ts and manifest.json agree on, unchecked against a third source.\n'
fi

echo
awk -v n="$PLANNED" -v b="$TOTAL_BYTES" \
  'BEGIN { printf "Verified locally: %d objects, %d bytes (%.1f MB).\n", n, b, b/1048576 }'

# ── Step 3: publish ────────────────────────────────────────────────────────

ensure_gcloud() {
  command -v gcloud >/dev/null 2>&1 \
    || die "the Cloud SDK is not on PATH. Install it and authenticate first."
}

# --execute is already an explicit opt-in, so this is belt-and-braces. It is
# here because the action is once-ever against production and effectively
# irreversible: the objects go out immutable for a year. Free to add, and the
# one moment it matters is the moment nobody would have caught it otherwise.
confirm_execute() {
  [[ -t 0 ]] || die "--execute needs an interactive terminal for confirmation.
Run it by hand in the release window; do not wire it into a pipeline."
  echo
  printf 'About to publish %d objects (%d bytes) to gs://%s/%s\n' \
    "$PLANNED" "$TOTAL_BYTES" "$BUCKET" "$OBJECT_PREFIX"
  printf 'They will be served %s — effectively permanent.\n' "$CACHE_CONTROL"
  printf 'Type PUBLISH to continue: '
  # `|| true` because under `set -e` a read that hits EOF would abort here with
  # no message at all — safe, but the operator would be left staring at a bare
  # prompt wondering what happened.
  local answer=""
  read -r answer || true
  [[ "$answer" == "PUBLISH" ]] || die "not confirmed — nothing was done."
}

ensure_bucket() {
  echo
  echo "Bucket gs://${BUCKET}"
  if gcloud_read storage buckets describe "gs://${BUCKET}" \
      --format="value(name)" >/dev/null 2>&1; then
    echo "    already exists — leaving its settings alone"
  else
    echo "    absent — creating"
    mutate gcloud storage buckets create "gs://${BUCKET}" \
      --project="${PROJECT}" \
      --location="${LOCATION}" \
      --uniform-bucket-level-access \
      --no-public-access-prevention
  fi
  # Idempotent: re-adding an existing binding is a no-op. This is the grant
  # that makes an unauthenticated GET work at all.
  mutate gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member=allUsers \
    --role=roles/storage.objectViewer
}

# Decide, for ALL destinations, before ANY upload — and decide on BYTES, not on
# existence.
#
# The safety property is "never change what a published URL serves", because
# objects go out `immutable, max-age=31536000` and a client that fetched one may
# hold it for a year. Refusing on mere EXISTENCE enforces that property but also
# forbids something provably safe: re-running after our OWN run died partway.
# That case is not hypothetical — a transient 503, an expired token or a Ctrl-C
# at object 12 of 21 leaves 12 published, and "publish v2 instead" is the wrong
# remedy, because `v1` is baked into lib/onboarding/piece/v1/ and the runner. It
# would mean a source change at 11pm mid-window.
#
# So every occupied path is fetched over its public URL and hashed against the
# pinned record. Byte-identical everywhere means this IS our content and the run
# resumes (`--no-clobber` skips those objects; verify_public still checks all
# 21). One byte different anywhere — or one occupied object we cannot read
# publicly, so cannot prove — and it aborts exactly as before.
check_destinations() {
  echo
  echo "Checking what is already published under ${OBJECT_PREFIX}"
  local occupied=0 identical=0 conflicting=0
  CONFLICTS=""
  while IFS=$'\t' read -r slug bytes sha ctype; do
    [[ -n "$slug" ]] || continue
    gcloud_read storage objects describe \
      "gs://${BUCKET}/${OBJECT_PREFIX}${slug}" \
      --format="value(name)" >/dev/null 2>&1 || continue
    occupied=$((occupied + 1))
    local body="${TMPDIR_RUN}/pre-${slug}"
    local hdrs="${TMPDIR_RUN}/preh-${slug}"
    if ! fetch_public "${BASE_URL}/${slug}" "$body" "$hdrs"; then
      printf '    CONFLICT  %-24s exists but is not publicly readable\n' "$slug"
      CONFLICTS="${CONFLICTS}
  ${slug} — exists, could not be fetched anonymously, so its bytes are unknown"
      conflicting=$((conflicting + 1))
      continue
    fi
    local got_sha
    got_sha="$(sha256_of "$body")"
    if [[ "$got_sha" == "$sha" ]]; then
      printf '    same      %-24s already published, byte-identical\n' "$slug"
      identical=$((identical + 1))
    else
      printf '    CONFLICT  %-24s published bytes differ from the pinned record\n' "$slug"
      CONFLICTS="${CONFLICTS}
  ${slug} — published ${got_sha}
  ${slug} — pinned    ${sha}"
      conflicting=$((conflicting + 1))
    fi
  done < "$RECORDS"

  if [[ "$conflicting" -gt 0 ]]; then
    die "${conflicting} of ${occupied} already-published object(s) are NOT the
bytes this run would publish:${CONFLICTS}

No object was uploaded or modified by this run. (The bucket may have just been
created and the allUsers binding applied — that is all that happened.)

Objects are served \`${CACHE_CONTROL}\`, so a client that already fetched one
may cache it for a year. Replacing bytes at a live URL gives some users the new
file, some the cached old one, and some a sha256 mismatch and a failed build.
Publish a NEW version directory instead:
  bash scripts/publish-onboarding-assets.sh --version v2 --execute
and move DEFAULT_ONBOARDING_ASSET_BASE's consumers to it."
  fi

  RESUMING="$identical"
  if [[ "$occupied" -eq 0 ]]; then
    echo "    clear — all ${PLANNED} destinations are free"
  else
    printf '    %d of %d already published and byte-identical — resuming, %d to upload\n' \
      "$identical" "$PLANNED" "$((PLANNED - identical))"
  fi
}

upload_all() {
  echo
  echo "Uploading (${RESUMING:-0} of ${PLANNED} already present will be skipped)"
  UPLOAD_INDEX=0
  while IFS=$'\t' read -r slug bytes sha ctype; do
    [[ -n "$slug" ]] || continue
    UPLOAD_INDEX=$((UPLOAD_INDEX + 1))
    printf '  [%2d/%d] %s\n' "$UPLOAD_INDEX" "$PLANNED" "$slug"
    # --no-clobber is both the resume mechanism and the last line of defence:
    # it sets ifGenerationMatch=0, so a colliding write loses the race rather
    # than winning it.
    if ! mutate gcloud storage cp \
      --no-clobber \
      --cache-control="${CACHE_CONTROL}" \
      --content-type="${ctype}" \
      "${ASSETS_DIR}/${slug}" \
      "gs://${BUCKET}/${OBJECT_PREFIX}${slug}"; then
      upload_progress_summary
      die "upload failed on object ${UPLOAD_INDEX} of ${PLANNED} (${slug}).
Re-run the SAME command — it is safe. Objects already uploaded are byte-identical
to the pinned records, so the destination check will recognise them and resume."
    fi
  done < "$RECORDS"
  UPLOAD_INDEX=0
}

# Printed on any interrupted upload, so the operator is never left guessing how
# far it got. Bare `set -e` would abort with gcloud's message and nothing else.
upload_progress_summary() {
  [[ "${UPLOAD_INDEX:-0}" -gt 0 ]] || return 0
  printf '\n  --- upload stopped at object %d of %d ---\n' \
    "$UPLOAD_INDEX" "$PLANNED"
  printf '  Up to %d of %d objects may now exist under %s.\n' \
    "$UPLOAD_INDEX" "$PLANNED" "$OBJECT_PREFIX"
  printf '  Nothing is corrupt: every uploaded object is byte-identical to its\n'
  printf '  pinned record. Re-run the same command to resume, or\n'
  printf '  --verify-only to see what is live.\n'
}

# The only check that answers the question that matters. `curl -q` ignores
# ~/.curlrc, no auth header is sent, no gcloud is involved: this is exactly
# what a stranger's first run does.
verify_public() {
  echo
  echo "Verifying over plain HTTPS, unauthenticated — ${BASE_URL}/"
  local failures=0
  while IFS=$'\t' read -r slug bytes sha ctype; do
    [[ -n "$slug" ]] || continue
    local url="${BASE_URL}/${slug}"
    local body="${TMPDIR_RUN}/dl-${slug}"
    local hdrs="${TMPDIR_RUN}/hd-${slug}"
    if ! fetch_public "$url" "$body" "$hdrs"; then
      printf '    FAIL  %-24s could not be fetched\n' "$slug"
      failures=$((failures + 1))
      continue
    fi
    local got_sha got_size got_cc got_ct
    got_sha="$(sha256_of "$body")"
    got_size="$(size_of "$body")"
    # Header names are lower-cased first: BSD awk has no IGNORECASE, and HTTP/1
    # responses can spell these with capitals.
    got_cc="$(header_value "$hdrs" "cache-control")"
    got_ct="$(header_value "$hdrs" "content-type")"
    if [[ "$got_sha" != "$sha" || "$got_size" != "$bytes" ]]; then
      printf '    FAIL  %-24s hash/size mismatch (got %s, %s bytes)\n' \
        "$slug" "$got_sha" "$got_size"
      failures=$((failures + 1))
      continue
    fi
    if [[ "$got_cc" != *"max-age=31536000"* || "$got_cc" != *"immutable"* ]]; then
      printf '    FAIL  %-24s cache-control is "%s", expected "%s"\n' \
        "$slug" "$got_cc" "$CACHE_CONTROL"
      failures=$((failures + 1))
      continue
    fi
    if [[ "$got_ct" != "$ctype"* ]]; then
      printf '    FAIL  %-24s content-type is "%s", expected "%s"\n' \
        "$slug" "$got_ct" "$ctype"
      failures=$((failures + 1))
      continue
    fi
    printf '    ok    %-24s %10s bytes  sha256 matched  %s\n' \
      "$slug" "$got_size" "$got_ct"
  done < "$RECORDS"
  if [[ "$failures" -gt 0 ]]; then
    die "${failures} object(s) are not correctly readable by an anonymous
client. The onboarding demo will fail for new users until this is clean."
  fi
  echo "    all ${PLANNED} objects fetched anonymously and hash-matched"
}

if [[ "$VERIFY_ONLY" == "1" ]]; then
  verify_public
  echo
  printf 'VERIFIED: %d objects, %d bytes at %s/\n' \
    "$PLANNED" "$TOTAL_BYTES" "$BASE_URL"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "DRY RUN — nothing outside this machine was contacted."
  echo "The commands below are what --execute would run. Bucket and object"
  echo "state are unknown here on purpose: checking them is a live call, and a"
  echo "plan should not need credentials."
  ensure_bucket_dry() {
    printf '  bucket (created only if absent):\n'
    mutate gcloud storage buckets create "gs://${BUCKET}" \
      --project="${PROJECT}" --location="${LOCATION}" \
      --uniform-bucket-level-access --no-public-access-prevention
    printf '  public read:\n'
    mutate gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
      --member=allUsers --role=roles/storage.objectViewer
  }
  ensure_bucket_dry
  printf '  then it asks for typed confirmation, then checks all %d destinations\n' "$PLANNED"
  printf '  BEFORE uploading any: an occupied path is fetched over its public URL\n'
  printf '  and hashed. Byte-identical everywhere means an earlier run of this same\n'
  printf '  command was interrupted, and it resumes. Any difference aborts.\n'
  printf '  then, for each object still missing:\n'
  mutate gcloud storage cp --no-clobber \
    --cache-control="${CACHE_CONTROL}" --content-type='<per asset>' \
    "${ASSETS_DIR}/<slug>" "gs://${BUCKET}/${OBJECT_PREFIX}<slug>"
  printf '  then all %d are re-fetched with curl from %s/<slug>\n' "$PLANNED" "$BASE_URL"
  printf '  and hashed against the pinned sha256.\n'
  echo
  printf 'DRY RUN COMPLETE: %d objects, %d bytes would be published to %s/\n' \
    "$PLANNED" "$TOTAL_BYTES" "$BASE_URL"
  echo "Re-run with --execute to publish. That is a weekend action."
  exit 0
fi

ensure_gcloud
confirm_execute
ensure_bucket
check_destinations
upload_all
verify_public

echo
printf 'PUBLISHED: %d objects, %d bytes at %s/\n' \
  "$PLANNED" "$TOTAL_BYTES" "$BASE_URL"
echo "Every one was re-fetched anonymously over HTTPS and hash-matched against"
echo "lib/onboarding/piece/${VERSION}/assets.ts. A fresh install can build the demo."
