import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * The failure this guard exists for is "a `files` entry was missing":
 * `electron-builder.yml`'s `files` allowlist once had ZERO entries for `mcp/`,
 * so a packaged Electron build silently shipped without
 * `mcp/templates/instructions.md`, the core libi MCP's own entry point
 * (`mcp/index.ts`, spawned by `buildLibiEntry()` — see lib/mcp-config.ts), the
 * tracking sidecar source, and the install-plan markdown — and boot died with
 * `boot_phase_failed phase=category-b`.
 *
 * ## What changed, and why this test now checks something different
 *
 * The original test asserted that electron-builder.yml's `mcp/` entries
 * matched `package.json#files` entry-for-entry, because BOTH artifacts copied
 * `mcp/` out of the working tree and could disagree about which subpaths ship.
 *
 * They no longer can, because there is only ONE decision left. The packaged
 * shell ships no product code at all: it carries an installed
 * `@nagellabs/libi` snapshot under `extraResources` (see
 * `scripts/build-runtime-bundle.js`), and that snapshot is built from the very
 * tarball `npm pack` produces. So `package.json#files` is now the single
 * source of truth for what `mcp/` means in BOTH artifacts, and drift between
 * them is structurally impossible rather than merely tested for.
 *
 * The original outage is therefore guarded differently now, and this file
 * asserts the two properties that replaced it:
 *
 *   1. `package.json#files` still ships `mcp/` (and `tsconfig.json`), because
 *      that is now what the packaged app gets too;
 *   2. the packaged app really does receive a runtime bundle, and cannot be
 *      built without a fresh one.
 */
describe("packaged-artifact allowlists", () => {
  const electronBuilderConfig = yaml.load(
    fs.readFileSync(path.join(process.cwd(), "electron-builder.yml"), "utf-8"),
  ) as Record<string, unknown>;
  const electronBuilderFiles = electronBuilderConfig.files as string[];
  const extraResources = electronBuilderConfig.extraResources as Array<{
    from: string;
    to: string;
  }>;

  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
  ) as Record<string, unknown>;
  const packageJsonFiles = pkg.files as string[];

  it("ships mcp/**/* in the npm tarball — which is now also what the packaged app boots", () => {
    expect(packageJsonFiles).toContain("mcp/**/*");
  });

  it("ships tsconfig.json (buildLibiEntry() passes it to tsx via --tsconfig to resolve mcp/index.ts's @/* path-alias imports)", () => {
    expect(packageJsonFiles).toContain("tsconfig.json");
  });

  it("ships a production .next in the tarball (the runtime bundle has no other build)", () => {
    expect(packageJsonFiles).toContain(".next/**/*");
  });

  it("keeps the mcp/ exclusions on the ONE allowlist that decides them", () => {
    const mcpEntries = packageJsonFiles.filter((e) =>
      e.replace(/^!/, "").startsWith("mcp/"),
    );
    // Fixture sanity: fail loudly rather than pass on an empty array.
    expect(mcpEntries.length).toBeGreaterThan(1);
    expect(mcpEntries).toContain("!mcp/dev/**");
  });

  /**
   * The shell must NOT re-admit product code. If someone adds `lib/**` or
   * `.next/**` back here, the app would carry two copies of libi — one stale
   * (the working tree at shell-build time) and one live (the runtime snapshot)
   * — and `process.cwd()`-relative lookups could resolve into the wrong one.
   */
  it("keeps the shell thin — no product source trees in electron-builder's files", () => {
    const forbidden = ["lib/**/*", "app/**/*", "components/**/*", "hooks/**/*", "drizzle/**/*", "mcp/**/*", ".next/**/*"];
    for (const entry of forbidden) {
      expect(electronBuilderFiles).not.toContain(entry);
    }
    expect(electronBuilderFiles).toContain("dist-electron/**/*");
  });

  it("copies the runtime bundle into the artifact, node_modules included", () => {
    const froms = extraResources.map((r) => r.from);
    expect(froms).toContain("build/libi-bundle");
    // NOT redundant: electron-builder hardcodes `relative === "node_modules"
    // → excluded` at every matcher root, so without this second entry the
    // bundle ships with zero dependencies. See the comment in
    // electron-builder.yml.
    expect(froms).toContain("build/libi-bundle/node_modules");
  });

  it("refuses to package around a missing or stale bundle", () => {
    expect(electronBuilderConfig.beforePack).toBe(
      "scripts/beforepack-runtime-bundle-guard.js",
    );
  });

  it("keeps the proprietary-code exclusions even though node_modules is now excluded wholesale", () => {
    expect(electronBuilderFiles).toContain("!node_modules/@anthropic-ai/**");
    expect(electronBuilderFiles).toContain(
      "!node_modules/@agentclientprotocol/claude-agent-acp/**",
    );
  });
});
