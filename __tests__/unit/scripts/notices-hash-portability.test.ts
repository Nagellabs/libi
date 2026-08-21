/**
 * The notices staleness gate must produce the SAME digest on every platform.
 *
 * `prebuild:electron` runs `generate-third-party-notices.js --check`, which
 * compares two recorded sha256 markers against freshly computed ones. Both
 * inputs turned out to be platform-dependent, and each one blocked libi's first
 * Windows build in turn:
 *
 *   1. package-lock.json is hashed BY ITS RAW BYTES, and git's default
 *      `text=auto` rewrites LF to CRLF on a Windows checkout. Fixed by
 *      `.gitattributes` (`* -text`), which is asserted here — a repo-wide rule
 *      is easy to "tidy up" later without realising a release gate depends on
 *      it.
 *   2. `computeVendoredHash` mixed the JOINED PATH into the digest using
 *      `path.join`, so Windows contributed `public\fonts\2d\Inter-Regular.ttf`
 *      where mac and Linux contributed `public/fonts/2d/Inter-Regular.ttf` —
 *      a different digest for byte-identical fonts.
 *
 * Neither is reachable from macOS CI, so this pins the invariant directly
 * rather than waiting for a Windows runner to rediscover it.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/generate-third-party-notices.js");
const NOTICES = path.join(ROOT, "THIRD-PARTY-NOTICES.md");

describe("third-party-notices hashing is platform-independent", () => {
  it("joins vendored font paths with path.posix, never bare path.join", () => {
    // The one-line difference between "passes everywhere" and "can never pass
    // on Windows". Asserted on the source because the function is not exported.
    const src = readFileSync(SCRIPT, "utf8");
    const fn = src.slice(
      src.indexOf("function computeVendoredHash"),
      src.indexOf("function assertVendoredFontsIntact"),
    );
    expect(fn).toContain("path.posix.join(f.dir, n)");
    expect(fn).not.toMatch(/[^.]\bpath\.join\(f\.dir, n\)/);
  });

  it("reproduces the recorded vendored digest with POSIX separators, and not with Windows ones", () => {
    // Rebuilt from the script's own font table so the test fails if the table
    // and the recorded marker ever drift apart.
    const src = readFileSync(SCRIPT, "utf8");
    const table = src.slice(
      src.indexOf("const VENDORED_FONTS"),
      src.indexOf("/** First non-empty line"),
    );
    const fonts = [...table.matchAll(
      /\{\s*family:\s*"([^"]+)",\s*files:\s*\[([^\]]+)\],\s*dir:\s*"([^"]+)",\s*licenseFile:\s*"([^"]+)"/g,
    )].map((m) => ({
      family: m[1],
      files: [...m[2].matchAll(/"([^"]+)"/g)].map((f) => f[1]),
      dir: m[3],
      licenseFile: m[4],
    }));
    expect(fonts.length).toBeGreaterThan(0); // the regex must not silently match nothing

    const sha = (f: string) =>
      createHash("sha256").update(readFileSync(f)).digest("hex");
    const digest = (join: (a: string, b: string) => string) => {
      const h = createHash("sha256");
      for (const f of fonts) {
        h.update(f.family);
        for (const file of [...f.files.map((n) => join(f.dir, n)), f.licenseFile]) {
          const abs = path.join(ROOT, file.split("\\").join("/"));
          h.update(file);
          h.update(existsSync(abs) ? sha(abs) : "MISSING");
        }
      }
      return h.digest("hex");
    };

    const recorded = readFileSync(NOTICES, "utf8")
      .match(/vendored-assets-sha256:\s*([0-9a-f]{64})/)?.[1];
    expect(recorded).toBeDefined();
    expect(digest(path.posix.join)).toBe(recorded);
    // The bug, pinned: a Windows join must NOT be what the marker records.
    expect(digest(path.win32.join)).not.toBe(recorded);
  });

  it("keeps .gitattributes disabling EOL conversion repo-wide", () => {
    // package-lock.json is hashed by raw bytes; a CRLF checkout changes them.
    const attrs = readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
    const active = attrs
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(active).toContain("* -text");
  });

  it("proves CRLF really would change the lockfile digest", () => {
    // Guards the reasoning behind the rule above: if this ever stopped being
    // true, `* -text` would look like cargo cult and get deleted.
    const lock = readFileSync(path.join(ROOT, "package-lock.json"));
    const lf = createHash("sha256").update(lock).digest("hex");
    const crlf = createHash("sha256")
      .update(Buffer.from(lock.toString("utf8").replace(/\n/g, "\r\n"), "utf8"))
      .digest("hex");
    expect(crlf).not.toBe(lf);
    const recorded = readFileSync(NOTICES, "utf8")
      .match(/source-lockfile-sha256:\s*([0-9a-f]{64})/)?.[1];
    expect(lf).toBe(recorded);
  });
});
