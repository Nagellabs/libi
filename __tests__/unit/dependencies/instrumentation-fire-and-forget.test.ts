import { describe, it, expect } from "vitest";

describe("bootstrap startup", () => {
  it("install phase lives in category-a and prewarm lives in category-b", async () => {
    // Regression guard: Category A handles install; Category B handles prewarm.
    // This test greps the actual source files so a future refactor can't
    // accidentally merge or reorder these responsibilities.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const srcA = await fs.readFile(
      path.join(process.cwd(), "lib/server/lifecycle/category-a.ts"),
      "utf-8",
    );
    const srcB = await fs.readFile(
      path.join(process.cwd(), "lib/server/lifecycle/category-b.ts"),
      "utf-8",
    );

    // Install (npm + binary deps) must live in Category A (runs before Next.js).
    expect(srcA.indexOf("installBinaryDeps")).toBeGreaterThan(0);

    // Pre-warm (DB-persist probe) must live in Category B (runs inside Next.js).
    expect(srcB.indexOf("dm.prewarmBundledMcps(")).toBeGreaterThan(0);

    // Install must NOT have moved into Category B — that would block server start.
    expect(srcB.indexOf("dm.installBundledDeps(")).toBe(-1);

    // Category B must catch errors via try/catch (failures are captured in the
    // BootPhaseError instead of crashing the server).
    const hasTryCatch = srcB.includes("} catch (err)") || srcB.includes(".catch(");
    expect(
      hasTryCatch,
      "Category B must wrap steps in try/catch",
    ).toBe(true);
  });
});
