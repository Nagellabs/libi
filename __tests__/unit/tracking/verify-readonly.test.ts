import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const FILES = [
  "lib/tracking/verify-grid.ts",
  "lib/tracking/verify-render.ts",
  "app/api/tracking/verify-render/route.ts",
];
const FORBIDDEN = [
  "lib/jobs/manager",
  "lib/tracking/apply-segment-result",
  "lib/tracking/recompute-segment",
];

/** Strip line + block comments so a doc comment that NAMES a forbidden module
 *  (verify-render.ts intentionally documents the rule) is not a false match.
 *  Real references — static import, dynamic import(), require(), re-export —
 *  all survive comment-stripping, so the guard stays strict. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("verify path is strictly read-only (no re-track core imports)", () => {
  for (const rel of FILES) {
    it(`${rel} imports none of the re-track modules`, () => {
      const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
      for (const mod of FORBIDDEN) {
        expect(code.includes(mod), `${rel} must not reference ${mod}`).toBe(false);
      }
    });
  }
});
