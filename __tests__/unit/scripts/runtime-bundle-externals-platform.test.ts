// The two externals-farm checks in build-runtime-bundle.js must agree.
//
// `materializeNextExternals` builds the farm and asserts its shape; check (9)
// in `verifyRuntimeBundle` re-asserts it on the finished artifact. Both encode
// "are these link targets the right kind?", and the right answer is
// platform-dependent: relative on macOS/Linux, where the farm ships inside the
// signed .app and an absolute target would dangle on every user's disk;
// absolute on Windows, where junctions are the only unprivileged directory link
// and are absolute by construction (lib/install/next-externals.ts).
//
// Relaxing one and not the other is not hypothetical — it failed the 0.1.9
// Windows shell build, one second after that same build had materialised a
// perfectly good junction farm. This file exists so the next person changing
// one is told about the other.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.resolve(__dirname, "../../../scripts/build-runtime-bundle.js"),
  "utf8",
);

describe("externals farm link-kind checks", () => {
  it("both checks derive the expectation from the same platform predicate", () => {
    const decls = SRC.match(/const wantAbsolute = process\.platform === "win32";/g) ?? [];
    expect(
      decls.length,
      "expected exactly two — materializeNextExternals and verifyRuntimeBundle check (9)",
    ).toBe(2);
  });

  it("neither check is simply skipped on Windows", () => {
    // The first fix for this was `if (absolute.length > 0 && process.platform !== "win32")`,
    // which turns the guard OFF rather than asserting the Windows invariant —
    // a bundle whose farm had been rebuilt by something that bypassed the
    // junction branch would then ship unnoticed.
    expect(SRC).not.toMatch(/process\.platform !== "win32"/);
  });

  it("both checks still refuse a link that does not resolve, on every platform", () => {
    // Dangling is wrong everywhere, and is the failure the whole mechanism
    // exists to prevent: the server binds its port and then 500s every route.
    expect(SRC).toContain("does not resolve");
    expect(SRC.match(/realpathSync\(link\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(SRC).toContain("dangling");
  });
});
