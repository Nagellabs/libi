import path from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import exportedConfig from "../../../next.config";

// next.config.ts exports a config FUNCTION of Next's phase (withSentryConfig keeps it one).
const nextConfig =
  typeof exportedConfig === "function"
    ? (exportedConfig as (phase: string, ctx: { defaultConfig: object }) => object)(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
    : exportedConfig;

/**
 * Turbopack resolves modules only inside its root, and with no `turbopack.root`
 * Next picks the directory of the OUTERMOST lockfile it finds above the app.
 * In a worktree under `.claude/worktrees/<name>/` that is the canonical
 * checkout, not the worktree — hence the "inferred your workspace root"
 * warning on every worktree boot. Pinned to the directory holding
 * next.config.ts, every checkout is its own root; the npm tarball and the
 * Electron bundle build from the package root, so they are unchanged.
 */
describe("next.config.ts turbopack.root", () => {
  it("is the directory holding next.config.ts", () => {
    const root = (nextConfig as { turbopack?: { root?: string } }).turbopack?.root;
    expect(root).toBe(path.resolve(__dirname, "..", "..", ".."));
  });

  it("is absolute, as Next requires", () => {
    const root = (nextConfig as { turbopack?: { root?: string } }).turbopack?.root ?? "";
    expect(path.isAbsolute(root)).toBe(true);
  });

  it("leaves outputFileTracingRoot unset, so Next sets it to the same root", () => {
    expect((nextConfig as { outputFileTracingRoot?: string }).outputFileTracingRoot).toBeUndefined();
  });
});
