/**
 * A publish script is run once, under time pressure, on a Friday. The
 * safeguards have to be in the file, because nobody is going to re-read it
 * carefully at that moment.
 *
 * So this test is deliberately static: it greps the script's source rather
 * than executing it. Executing it for real would create a bucket and move
 * 14.8 MB of bytes to a public URL, which is exactly the thing that may only
 * happen once, by hand, in the release window.
 *
 * ── EVERY ASSERTION READS `CODE`, NEVER THE RAW FILE ──────────────────────
 *
 * The first version of this suite grepped the raw source, and review found
 * what that is worth: DELETING THE ENTIRE `verify_public` FUNCTION AND EVERY
 * CALL TO IT LEFT ALL 15 TESTS GREEN. The script's header comment mentions
 * `curl` and `sha256`, so the two assertions guarding the single most
 * important behaviour in the file were satisfied by prose. Worse,
 * "asserts the cache-control header on the object it fetched back" was
 * satisfied by the `--cache-control=` flag on the UPLOAD.
 *
 * `CODE` is the file with comments stripped. Beyond that, assertions anchor
 * to a NAMED FUNCTION'S BODY (`bashFunction`) or to a call site, so a test
 * named after a function fails when that function is deleted. The rule this
 * suite is now written to: a test that survives deleting the function it
 * names is not a test.
 *
 * What is being protected:
 *   - dry-run default        — a stray invocation must not publish.
 *   - byte-based resume      — objects ship `immutable, max-age=31536000`, so
 *                              a client that fetched one may cache it for a
 *                              year. Republishing DIFFERENT bytes at a live
 *                              URL must abort; re-running after our own
 *                              interrupted upload must resume, because the
 *                              alternative at 11pm is hand-running nine cp
 *                              commands.
 *   - credential-free verify — `gcloud` succeeding proves only that WE can
 *                              read the bucket. The only question that matters
 *                              is whether a brand-new user on a fresh machine
 *                              can, which is a plain HTTPS GET with no auth.
 *   - URL agreement          — the script and the runtime must name the same
 *                              bucket prefix, or we publish to a URL nothing
 *                              downloads from.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ONBOARDING_ASSET_BASE } from "@/lib/onboarding/piece/asset-base";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts/publish-onboarding-assets.sh");
const RAW = fs.readFileSync(SCRIPT, "utf8");

/** Comment stripped, so no assertion below can be satisfied by prose. */
const CODE_LINES = RAW.split("\n")
  .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
  .filter((l) => l.trim().length > 0);
const CODE = CODE_LINES.join("\n");

/**
 * The body of a top-level bash function, comments stripped. Throws if the
 * function is gone — which is the point: an assertion about `verify_public`
 * must FAIL when `verify_public` is deleted, not silently match elsewhere.
 */
function bashFunction(name: string): string {
  const open = CODE_LINES.findIndex((l) => l.trim() === `${name}() {`);
  if (open === -1) {
    throw new Error(
      `scripts/publish-onboarding-assets.sh no longer defines ${name}(). ` +
        "If it was renamed, update this test; if it was deleted, the " +
        "behaviour it implemented is gone.",
    );
  }
  const close = CODE_LINES.findIndex((l, i) => i > open && l === "}");
  if (close === -1) throw new Error(`${name}() has no closing brace at column 0`);
  return CODE_LINES.slice(open + 1, close).join("\n");
}

/** Top-level (unindented) statements, i.e. the script's actual control flow. */
const TOP_LEVEL = CODE_LINES.filter((l) => /^\S/.test(l));

/**
 * Lines where `gcloud`/`gsutil` sits in COMMAND position — so a mention
 * inside an error string does not count, and a real invocation cannot hide
 * behind one.
 */
const STARTERS = new Set(["mutate", "if", "!", "then", "else", "&&", "||", ";", "("]);
function gcloudInvocation(line: string): { gated: boolean } | null {
  const tokens = line.trim().split(/\s+/);
  const at = tokens.findIndex((t) => t === "gcloud" || t === "gsutil");
  if (at === -1) return null;
  const prev = at === 0 ? undefined : tokens[at - 1];
  if (prev !== undefined && !STARTERS.has(prev)) return null;
  return { gated: tokens.slice(0, at).includes("mutate") };
}

describe("publish-onboarding-assets.sh safeguards", () => {
  it("is dry-run unless explicitly told to execute", () => {
    expect(CODE).toMatch(/DRY_RUN=1/);
    // Anchored to the argument parser, not to the usage text, which also
    // contains the string `--execute`.
    expect(CODE).toMatch(/--execute\)\s*\n\s*DRY_RUN=0/);
  });

  it("fails fast", () => {
    expect(CODE).toMatch(/set -euo pipefail/);
  });

  it("targets the right bucket and project", () => {
    expect(CODE).toContain("libi-public-assets");
    expect(CODE).toContain("libi-prod");
  });

  it("sets the immutable cache header on upload", () => {
    expect(CODE).toContain("max-age=31536000");
    expect(CODE).toContain("immutable");
    expect(bashFunction("upload_all")).toMatch(/--cache-control="\$\{CACHE_CONTROL\}"/);
  });

  it("publishes to the same base URL the runtime downloads from", () => {
    // If these drift the upload lands somewhere nothing reads.
    expect(
      CODE,
      `the script must publish under ${DEFAULT_ONBOARDING_ASSET_BASE} — the ` +
        "constant lib/onboarding/piece/asset-base.ts hands to every install",
    ).toContain(DEFAULT_ONBOARDING_ASSET_BASE);
  });

  // ── The verification is the point of the script ──────────────────────────

  it("fetches published objects as a stranger would: curl, no credentials", () => {
    const fn = bashFunction("fetch_public");
    // -q ignores ~/.curlrc, so a credential on the release machine cannot
    // make this check lie about what an anonymous client sees.
    expect(fn).toMatch(/\bcurl\b[^\n]*\s-q\b/);
    expect(fn, "no header dump means the response headers cannot be checked")
      .toMatch(/-D\s+"\$3"/);
    expect(fn).not.toMatch(/\bgcloud\b/);
    expect(fn).not.toMatch(/-u\b|--user\b|Authorization/i);
  });

  it("verify_public re-fetches EVERY object and compares to the pinned sha256", () => {
    const fn = bashFunction("verify_public");
    expect(fn, "must go over plain HTTPS, not through gcloud").toMatch(
      /fetch_public\s+"\$url"/,
    );
    expect(fn).toMatch(/got_sha="\$\(sha256_of\s+"\$body"\)"/);
    expect(
      fn,
      "the fetched hash must actually be compared against the pinned $sha",
    ).toMatch(/"\$got_sha"\s*!=\s*"\$sha"/);
    expect(fn, "a mismatch must abort, not just print").toMatch(/\bdie\b/);
    expect(fn).toMatch(/\$\{BASE_URL\}/);
  });

  it("asserts cache-control on the RESPONSE, not on the upload flag", () => {
    const fn = bashFunction("verify_public");
    // The value has to come out of the header dump for this object…
    expect(fn).toMatch(/got_cc="\$\(header_value\s+"\$hdrs"\s+"cache-control"\)"/);
    // …and be compared. Matching the bare string `cache-control` anywhere was
    // the original bug: `--cache-control=` on the upload satisfied it.
    expect(fn).toMatch(/"\$got_cc"\s*!=\s*\*"max-age=31536000"\*/);
    expect(fn).toMatch(/"\$got_cc"\s*!=\s*\*"immutable"\*/);
  });

  it("runs the verification on the publish path, in order, last", () => {
    // Guards the mutation review actually performed: deleting verify_public
    // and its call sites must turn this suite red.
    const calls = TOP_LEVEL.filter((l) =>
      /^(ensure_gcloud|confirm_execute|ensure_bucket|check_destinations|upload_all|verify_public)$/.test(
        l,
      ),
    );
    expect(calls).toEqual([
      "ensure_gcloud",
      "confirm_execute",
      "ensure_bucket",
      "check_destinations",
      "upload_all",
      "verify_public",
    ]);
    // …and --verify-only re-runs it on its own.
    expect(CODE).toMatch(/VERIFY_ONLY"\s*==\s*"1"\s*\]\];\s*then\s*\n\s*verify_public/);
  });

  // ── Never change what a published URL serves ─────────────────────────────

  it("decides on BYTES, not existence, before uploading anything", () => {
    const fn = bashFunction("check_destinations");
    // Existence alone is not the question: our own interrupted run leaves
    // objects behind, and those are safe to skip past.
    expect(fn).toMatch(/gcloud_read\s+storage\s+objects\s+describe/);
    expect(fn, "an occupied path must be FETCHED and hashed").toMatch(
      /fetch_public\s+"\$\{BASE_URL\}\/\$\{slug\}"/,
    );
    expect(fn).toMatch(/got_sha="\$\(sha256_of\s+"\$body"\)"/);
    expect(fn).toMatch(/"\$got_sha"\s*==\s*"\$sha"/);
    // Identical everywhere -> resume.
    expect(fn).toMatch(/RESUMING=/);
    // Anything else -> abort.
    expect(fn).toMatch(/conflicting"\s*-gt\s*0\s*\]\];\s*then\s*\n\s*die/);
  });

  it("cannot be fetched-but-unreadable and still proceed", () => {
    const fn = bashFunction("check_destinations");
    // An object that exists but cannot be read anonymously has unknown bytes,
    // so it can never be treated as "ours".
    expect(fn).toMatch(/if !\s*fetch_public[\s\S]*?conflicting=\$\(\(conflicting \+ 1\)\)/);
  });

  it("the abort tells the operator to publish a new version, not to force", () => {
    const fn = bashFunction("check_destinations");
    expect(fn).toMatch(/--version v2/);
    expect(fn).toMatch(/max-age=31536000|CACHE_CONTROL/);
  });

  it("a failed upload reports where it stopped and that resuming is safe", () => {
    const fn = bashFunction("upload_all");
    expect(fn).toMatch(/upload_progress_summary/);
    expect(fn).toMatch(/Re-run the SAME command/);
    expect(fn).toMatch(/--no-clobber/);
    // …and an interrupt gets the same summary, not a bare shell abort.
    expect(bashFunction("on_interrupt")).toMatch(/upload_progress_summary/);
    expect(CODE).toMatch(/trap on_interrupt INT TERM/);
  });

  it("puts the version in the object path so v2 can never overwrite v1", () => {
    expect(CODE).toMatch(/onboarding\/\$\{?VERSION\}?\//);
    // …and the version itself is validated, not interpolated raw.
    expect(CODE).toMatch(/\^v\[0-9\]\+\$/);
  });

  // ── The dry-run gate, and reads vs writes ────────────────────────────────

  it("routes every mutating gcloud call through the dry-run gate", () => {
    // Inverted allowlist: any gcloud/gsutil in command position must either
    // go through `mutate` or be the single line inside `gcloud_read`. A verb
    // list would go stale — `objects update`, `objects delete`,
    // `buckets set-iam-policy` and every gsutil equivalent are all covered
    // by this shape without being enumerated.
    const readerBody = bashFunction("gcloud_read");
    const unguarded = CODE_LINES.filter((l) => {
      const inv = gcloudInvocation(l);
      if (!inv || inv.gated) return false;
      return !readerBody.split("\n").includes(l);
    });
    expect(
      unguarded,
      `these gcloud/gsutil invocations are neither behind \`mutate\` nor ` +
        `inside gcloud_read():\n${unguarded.join("\n")}`,
    ).toEqual([]);
    expect(CODE).toMatch(/^\s*mutate\(\) \{/m);
    expect(bashFunction("mutate")).toMatch(/DRY_RUN"\s*==\s*"1"/);
  });

  it("only ever calls gcloud_read with a read-only verb", () => {
    const READ_ONLY = [
      "storage buckets describe",
      "storage objects describe",
      "storage ls",
    ];
    const bad = CODE_LINES.map((l) => l.trim())
      .filter((l) => /(^|\s)gcloud_read\s/.test(l))
      .map((l) => l.replace(/^.*?\bgcloud_read\s+/, "").replace(/\s*\\$/, ""))
      .filter((args) => !READ_ONLY.some((verb) => args.startsWith(verb)));
    expect(
      bad,
      `gcloud_read is the READ door; these call sites pass a verb that is not ` +
        `read-only:\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("asks for typed confirmation before touching the project", () => {
    const fn = bashFunction("confirm_execute");
    expect(fn, "no TTY means no human, so no publish").toMatch(/-t 0 \]\]/);
    expect(fn).toMatch(/PUBLISH/);
    expect(fn).toMatch(/\bdie\b/);
  });

  // ── The records themselves ───────────────────────────────────────────────

  it("cross-checks the staged bytes against the pinned records before moving any", () => {
    expect(CODE).toContain("lib/onboarding/piece");
    expect(CODE).toContain("manifest.json");
    expect(CODE).toMatch(/ONBOARDING_ASSETS_/);
    expect(CODE).toMatch(/shasum|sha256sum/);
  });

  it("knows independently how big v1 is", () => {
    // assets.ts and manifest.json are generated from the same records, so they
    // agree with each other even when both are wrong the same way — truncate
    // both to 3 and the script would publish 3 and report success. These two
    // literals are the third source, and this test is what keeps them true.
    const expectedBytes = ONBOARDING_ASSETS_V1.reduce((n, a) => n + a.bytes, 0);
    const m = CODE.match(/v1\)\s*EXPECTED_OBJECTS=(\d+);\s*EXPECTED_BYTES=(\d+)/);
    expect(m, "the script no longer records an expected size for v1").toBeTruthy();
    expect(Number(m![1])).toBe(ONBOARDING_ASSETS_V1.length);
    expect(Number(m![2])).toBe(expectedBytes);
    expect(CODE).toMatch(/PLANNED"\s*!=\s*"\$EXPECTED_OBJECTS"/);
  });

  it("reports the object count and total bytes at the end", () => {
    expect(CODE).toMatch(/objects/);
    expect(CODE).toMatch(/bytes/);
  });

  it("is a bash script with a portable shebang", () => {
    expect(RAW.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  it("is executable", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).toBeTruthy();
  });
});
