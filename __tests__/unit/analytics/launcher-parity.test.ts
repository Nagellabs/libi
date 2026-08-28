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

  it("the Electron shell sets the flag too, and only for a real install", () => {
    expect(read("electron/main.ts")).toContain(`if (!isDev) process.env.${FLAG} ??= "1"`);
  });

  it("the shell sets it BEFORE it requires any runtime module", () => {
    // `ANALYTICS_ENABLED` is a module-level const, evaluated the first time
    // `lib/analytics/config` is loaded. Assigning after something has already
    // pulled that module in is a no-op that still reads as a fix — so the
    // assignment must precede `resolveRuntime`, which is what first requires
    // runtime code (`shell-api`, and everything it reaches).
    const src = read("electron/main.ts");
    const resolveAt = src.indexOf("const resolved = resolveRuntime(");
    const flagAt = src.indexOf(`process.env.${FLAG} ??=`);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(resolveAt);
  });

  it("the flag the launchers set is the one the gate reads", () => {
    // Pins the string itself: renaming the env var in config.ts without
    // touching the launchers would otherwise leave both greps above passing.
    expect(resolveAnalyticsEnabled({ [FLAG]: "1" })).toBe(true);
    expect(resolveAnalyticsEnabled({})).toBe(false);
  });
});
