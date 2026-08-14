/**
 * Guard: every `direct-download` model URL in models.json must be IMMUTABLY
 * PINNED — a commit SHA, a revision, or a release tag — never a moving branch
 * like `raw/main/` or `resolve/main/`.
 *
 * Why this exists: a mutable URL is a silent supply-chain hole. The sha256 +
 * sizeBytes fields DO catch drifted bytes, but only as a hard install failure
 * on a user's machine after upstream moved — the failure lands on whoever
 * happens to boot next, with no signal at review time. Two entries shipped
 * this way (matanyone_* on HF `main`, sot_vittrack on opencv_zoo `main`) and
 * both were fixed one-at-a-time by hand, months apart, each time rediscovering
 * the same reasoning. This test is the thing neither fix included: the check
 * that stops the third one from landing.
 *
 * Adding a model? Pin the URL. If upstream genuinely offers no immutable path,
 * add the id to ALLOWED_MUTABLE with the reason — an explicit, reviewed
 * exception, not an accident.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ModelEntry {
  id: string;
  url: string;
  acquisition: string;
  sha256?: string;
  sizeBytes?: number;
}

const MODELS: ModelEntry[] = JSON.parse(
  readFileSync(join(process.cwd(), "mcp/tracking/py/models.json"), "utf8"),
);

/**
 * Ids exempt from the pinning rule, each with a standing reason.
 *
 * `transnetv2` — served from a third-party host (download.shotai.io) whose
 * path carries no version, revision, or tag component at all. There is no
 * immutable form of this URL to pin TO; the only real fix is re-hosting the
 * byte stream as a libi release asset, which is a deliberate deferred call.
 * Its sha256 still hard-fails the install if upstream ever changes the bytes,
 * so the exposure is a broken install, never silent model substitution.
 */
const ALLOWED_MUTABLE = new Set(["transnetv2"]);

/** Path segments that mean "whatever this branch points at right now". */
const MUTABLE_REF_PATTERNS = [
  /\/raw\/(main|master|HEAD)\//i,
  /\/resolve\/(main|master|HEAD)\//i,
  /\/blob\/(main|master|HEAD)\//i,
  /\/(refs\/heads)\//i,
  /\/archive\/(main|master|HEAD)\./i,
  /\/latest\/download\//i,
];

/** A 7+ hex-char path segment (git SHA) or a vN.N.N-style release tag. */
const IMMUTABLE_REF_PATTERNS = [/\/[0-9a-f]{7,40}\//i, /\/(v?\d+\.\d+(\.\d+)?)\//];

const directDownloads = MODELS.filter((m) => m.acquisition === "direct-download");

describe("models.json URL pinning", () => {
  it("has direct-download entries to check (guards against a silent empty sweep)", () => {
    // If a refactor renames `acquisition` or restructures the file, every
    // assertion below would vacuously pass over an empty array. Fail loudly.
    expect(directDownloads.length).toBeGreaterThanOrEqual(4);
  });

  it.each(directDownloads.map((m) => [m.id, m] as const))(
    "%s: URL carries no mutable branch ref",
    (id, model) => {
      if (ALLOWED_MUTABLE.has(id)) return;
      const hit = MUTABLE_REF_PATTERNS.find((re) => re.test(model.url));
      expect(
        hit,
        `${id} points at a moving ref (${hit?.source}): ${model.url}\n` +
          `Pin it to a commit SHA / revision / release tag, or add "${id}" to ` +
          `ALLOWED_MUTABLE with the reason it cannot be pinned.`,
      ).toBeUndefined();
    },
  );

  it.each(directDownloads.map((m) => [m.id, m] as const))(
    "%s: URL carries an immutable ref",
    (id, model) => {
      if (ALLOWED_MUTABLE.has(id)) return;
      const pinned = IMMUTABLE_REF_PATTERNS.some((re) => re.test(model.url));
      expect(
        pinned,
        `${id} has no SHA/tag path segment: ${model.url}\n` +
          `An unpinned URL can silently serve different bytes than the ones ` +
          `whose sha256 is recorded here.`,
      ).toBe(true);
    },
  );

  it.each(directDownloads.map((m) => [m.id, m] as const))(
    "%s: records sha256 + sizeBytes (the byte-drift backstop)",
    (_id, model) => {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.sizeBytes).toBeGreaterThan(0);
    },
  );

  it("every ALLOWED_MUTABLE id still exists and is still direct-download", () => {
    // A stale exemption is worse than none: it would silently excuse a
    // future model that happens to reuse the id.
    for (const id of ALLOWED_MUTABLE) {
      const entry = MODELS.find((m) => m.id === id);
      expect(entry, `ALLOWED_MUTABLE lists "${id}" but models.json has no such entry`).toBeDefined();
      expect(entry?.acquisition).toBe("direct-download");
    }
  });
});
