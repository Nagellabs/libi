import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEffectsTool } from "@/mcp/tools/effect-tools";
import { clearCustomEffects } from "@/lib/effects/registry";

/**
 * Regression: the Category-B boot registers custom effects, but Next bundles
 * instrumentation, route handlers, and the MCP child as separate module
 * instances — so a boot-time registration is NOT guaranteed visible where the
 * effect tools' `findEffect`/`listEffects` actually run (the live QA caught this
 * as `unknown_effect` when applying a disk-only custom effect). The tools now
 * lazily ensure-load custom packages from disk at call time. This test proves a
 * custom effect that exists ONLY on disk (never pre-registered in this process)
 * is surfaced by the tool.
 */
describe("effect tools ensure-load custom packages from disk", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.LIBI_HOME;
    home = mkdtempSync(join(tmpdir(), "fx-home-"));
    process.env.LIBI_HOME = home;
    const dir = join(home, "effects", "drift");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        id: "drift",
        name: "Drift",
        family: "animation",
        phases: ["in"],
        supports: ["text"],
        params: [],
      }),
    );
    writeFileSync(join(dir, "animate.js"), "return { dx: progress * 10 };");
    // Simulate a fresh bundle where boot-time registration never reached us.
    clearCustomEffects();
  });

  afterEach(() => {
    clearCustomEffects();
    if (prev === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("listEffectsTool surfaces a disk-only custom effect without prior registration", async () => {
    const res = await listEffectsTool({});
    expect(res.success).toBe(true);
    const ids = (res.data as { effects: { id: string }[] }).effects.map((e) => e.id);
    expect(ids).toContain("drift");
  });
});
