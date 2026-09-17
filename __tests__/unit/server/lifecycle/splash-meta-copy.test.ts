import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The Electron splash's own byte formatting, evaluated out of the shipped
 * `electron/splash.html`.
 *
 * The splash script is inline HTML with no module boundary, so there is
 * nothing to import — but the copy it renders is production behaviour and the
 * "0 B" defect lived entirely inside it. `splash-isolation.test.ts` already
 * establishes the precedent of asserting against this file; this goes one step
 * further and RUNS the function, so the assertion is about the output the user
 * sees rather than about the source text.
 *
 * `scripts/splash-preview.html` is the developer preview of the same UI and
 * carries a copy of the same helper — the two must not drift, or the preview
 * stops previewing.
 */
const root = process.cwd();

function extractFmtBytes(rel: string): (b: unknown) => string {
  const src = fs.readFileSync(path.join(root, rel), "utf-8");
  // `[\s\S]*?` rather than a `/s` flag: the `s` flag is TS1501 at this target.
  const m = /function fmtBytes\(b\) \{[\s\S]*?\n {4}\}/.exec(src);
  if (!m) throw new Error(`no fmtBytes() found in ${rel}`);
  return new Function(`${m[0]}\nreturn fmtBytes;`)() as (b: unknown) => string;
}

describe.each([["electron/splash.html"], ["scripts/splash-preview.html"]])(
  "%s fmtBytes",
  (rel) => {
    const fmtBytes = extractFmtBytes(rel);

    it("renders 0 as '0 B', not an empty string", () => {
      // The FIRST progress tick of every download carries 0 bytes. With `!b`
      // returning "", the meta column read " / 165.0 MB · 0%" — a leading
      // space where the byte count belongs.
      expect(fmtBytes(0)).toBe("0 B");
    });

    it("composes a first tick that starts with the count, not a space", () => {
      const meta = `${fmtBytes(0)} / ${fmtBytes(173_000_000)} · 0%`;
      expect(meta).toBe("0 B / 165.0 MB · 0%");
      expect(meta.startsWith(" ")).toBe(false);
    });

    it("still renders nothing for a missing or non-numeric byte count", () => {
      // A caller with no byte fields at all (an `npm` install, which reports a
      // `detail` string instead) must not sprout a "0 B".
      expect(fmtBytes(undefined)).toBe("");
      expect(fmtBytes(null)).toBe("");
      expect(fmtBytes(NaN)).toBe("");
    });

    it("keeps the existing B / KiB-scale / MiB-scale thresholds", () => {
      expect(fmtBytes(512)).toBe("512 B");
      expect(fmtBytes(1024 * 512)).toBe("512.0 KB");
      expect(fmtBytes(42_000_000)).toBe("40.1 MB");
    });
  },
);
