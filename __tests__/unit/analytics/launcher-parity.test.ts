// Both launchers must turn analytics on — the desktop shell used to forget.
//
// `resolveAnalyticsEnabled` gates on NEXT_PUBLIC_LIBI_ANALYTICS, and
// `startAnalyticsDrain()` returns immediately when it is off. Enqueue is NOT
// gated the same way, so a launcher that misses the flag looks completely
// healthy from the inside: the funnel fires, rows land in `analytics_queue`,
// and nothing is ever sent. That shipped in every desktop build up to and
// including v0.1.8 — caught only by opening the dmg's SQLite by hand and
// finding nine rows still at `attempts = 0` half an hour after boot, beside an
// npx instance on the same machine whose identical funnel had drained clean.
//
// So this file compares the two launchers directly rather than testing either
// alone. A test of one would have passed throughout the entire outage.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAnalyticsEnabled } from "@/lib/analytics/config";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const FLAG = "NEXT_PUBLIC_LIBI_ANALYTICS";

describe("analytics opt-in parity across launchers", () => {
  it("the npx launcher sets the flag", () => {
    expect(read("bin/libi.js")).toContain(`env.${FLAG} =`);
  });

  it("the Electron shell sets the flag too", () => {
    expect(read("electron/main.ts")).toContain(`process.env.${FLAG} ??= "1"`);
  });

  it("the shell sets it where the packaged Next server will see it", () => {
    const src = read("electron/main.ts");
    // The dev path returns before the runtime block, so the assignment has to
    // sit after `resolveRuntime` and before `startNextServer` — landing it
    // above the dev early-return would switch analytics on in dev checkouts,
    // which is the policy bin/libi.js exists to enforce.
    const resolveAt = src.indexOf("const resolved = resolveRuntime(");
    const flagAt = src.indexOf(`process.env.${FLAG} ??=`);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(flagAt).toBeGreaterThan(resolveAt);
  });

  it("the flag the launchers set is the one the gate reads", () => {
    // Pins the string itself: renaming the env var in config.ts without
    // touching the launchers would otherwise leave both greps above passing.
    expect(resolveAnalyticsEnabled({ [FLAG]: "1" })).toBe(true);
    expect(resolveAnalyticsEnabled({})).toBe(false);
  });
});
