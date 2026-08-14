import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { buildLibiEntry } from "@/lib/mcp-config";

/**
 * Packaged Electron builds ship NO `node_modules/.bin/*` shims at all —
 * electron-builder copies no `.bin` directories, verified against the built
 * bundle (`Contents/Resources/app/node_modules/.bin` does not exist). The old
 * `buildLibiEntry()` resolved tsx via `node_modules/.bin/tsx`, which is
 * therefore ALWAYS absent in a packaged app even though `node_modules/tsx`
 * itself (the actual package) is present — so the primary path silently
 * failed and fell through to a broken, unsafe `npx libi serve-mcp` fallback.
 *
 * libi publishes under the scoped name `@nagellabs/libi`; the bare `libi` name
 * on the public npm registry belongs to an unrelated package (`libi@0.1.0`)
 * with no `bin` field today, so `npx libi` never resolves to us.
 * `buildSpawnEnv()` hands an MCP child the
 * ENTIRE process env (mcp/registry/spawn-env.ts), so silently shelling out to
 * a name libi doesn't own is a latent security exposure independent of
 * whether the primary path happens to work — this suite pins both halves of
 * the fix: tsx resolves from the actual package, and the npx fallback is
 * gone (a missing entry point/tsx CLI throws a loud diagnostic instead).
 */
describe("buildLibiEntry — packaged-build spawn resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves tsx's CLI script directly from node_modules/tsx, not the absent .bin/tsx shim", () => {
    const entry = buildLibiEntry() as { command: string; args?: string[] };
    const projectRoot = process.cwd();
    const expectedTsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const expectedEntryPoint = path.join(projectRoot, "mcp", "index.ts");

    expect(entry.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    expect(entry.args?.[0]).toBe(expectedTsxCli);
    expect(entry.args).toContain(expectedEntryPoint);
    // Must never point at the removed `.bin/tsx` shim.
    expect(entry.args?.join(" ")).not.toContain(path.join("node_modules", ".bin", "tsx"));
  });

  it("never falls back to `npx libi serve-mcp` — libi is unpublished and the public `libi` package belongs to an unrelated third party", () => {
    const entry = buildLibiEntry() as { command: string; args?: string[] };
    expect(entry.command).not.toBe("npx");
    expect(entry.args ?? []).not.toEqual(["libi", "serve-mcp"]);
  });

  it("throws a loud diagnostic instead of silently falling back to npx when the entry point or tsx CLI can't be found", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() => buildLibiEntry()).toThrow(/mcp.index\.ts|tsx.*cli\.mjs/i);
  });

  it("does not use process.execPath as the spawn command", () => {
    // Under Electron, `electronFuses.runAsNode: false` makes the packaged
    // binary ignore ELECTRON_RUN_AS_NODE — spawning process.execPath here
    // would launch a second full Libi GUI instead of running as Node (see
    // lib/install/npm-root.ts for the identical trap in the npm-install path).
    const entry = buildLibiEntry() as { command: string };
    expect(entry.command).not.toBe(process.execPath);
  });
});
