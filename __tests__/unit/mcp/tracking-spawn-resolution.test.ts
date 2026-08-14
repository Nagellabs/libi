import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBundledSpawn } from "@/mcp/registry/local-bin-resolver";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import type { BundledMcpDef } from "@/mcp/registry/types";

/**
 * Regression: a real agent run reported `npx libi serve-mcp-tracking`
 * failing to spawn because `libi` isn't on PATH in the spawned env.
 *
 * The session/settings path (`buildMcpServers`) substituted the tsx-direct
 * `buildTrackingEntry()`, but the prober + diagnose path resolves the spawn
 * command via `resolveBundledSpawn(def)` — which returned the def's raw
 * `command`/`args` fallback (`npx libi serve-mcp-tracking`).
 *
 * Core `libi` never hits this because it's `core: true` and skipped by the
 * prober entirely. `libi-tracking` is `core: false` and IS probed — reachable
 * via `libi.diagnose_mcp` (mcp/bundled-mcps/diagnose.ts) and the install/probe
 * path (mcp/registry/server-prober.ts), not just the session path — so the
 * shared resolver must hand back the in-repo tsx entry — exactly the same
 * thing `buildTrackingEntry()` produces — in every path that spawns it, and
 * must NEVER fall back to the unowned `npx libi ...` name (this repo is
 * unpublished; `libi` on the public npm registry belongs to an unrelated
 * package, and `buildSpawnEnv()` hands an MCP child the ENTIRE process
 * env — see `resolveBundledSpawn`'s doc comment for the full rationale).
 */
describe("libi-tracking spawn resolution (prober/session shared resolver)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking")!;

  const root = process.cwd();
  const entryPoint = path.join(root, "mcp", "tracking-mcp", "index.ts");
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const inRepo = fs.existsSync(entryPoint) && fs.existsSync(tsxCli);

  it("def exists and is a non-core in-repo MCP whose raw fallback is npx libi", () => {
    expect(def).toBeTruthy();
    expect(def.core).toBe(false);
    // The DB-row fallback is intentionally the broken-in-dev npx form — kept
    // only as documentation/metadata for Settings UI; resolveBundledSpawn
    // never returns it (see below).
    expect(def.command).toBe("npx");
    expect(def.args).toEqual(["libi", "serve-mcp-tracking"]);
  });

  it("resolveBundledSpawn returns the tsx-direct in-repo entry (node + tsx/dist/cli.mjs), NOT npx libi", () => {
    // This is the function the prober (server-prober.ts), diagnose.ts, and
    // the session path all funnel through to decide the actual spawn command.
    expect(inRepo).toBe(true); // this repo checkout always has both.
    const resolved = resolveBundledSpawn(def);

    expect(resolved.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    expect(resolved.args[0]).toBe(tsxCli);
    expect(resolved.args).toContain(entryPoint);
    // Must NOT be the .bin/tsx shim electron-builder never copies.
    expect(resolved.args.join(" ")).not.toContain(path.join("node_modules", ".bin", "tsx"));
    // Must NOT be the broken/unsafe npx fallback.
    expect(resolved.command).not.toBe("npx");
    expect(resolved.args).not.toEqual(["libi", "serve-mcp-tracking"]);
  });

  it("throws a loud diagnostic instead of falling back to npx libi when the entry point/tsx CLI can't be found", () => {
    // Packaged-build-with-a-broken-mcp/-allowlist scenario: mcp/** and
    // node_modules/tsx are both guaranteed to exist in every legitimate
    // build (dev tree, npm install, or packaged Electron artifact), so a
    // miss here means a broken build, not a genuinely absent source tree —
    // fail loudly rather than silently reach for the stranger-owned name.
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() => resolveBundledSpawn(def)).toThrow(/libi-tracking/);
    expect(() => resolveBundledSpawn(def)).toThrow(/tsx.*cli\.mjs|mcp.tracking-mcp/i);
  });

  it("a non-in-repo bundled def is unaffected (still falls back to its command)", () => {
    const plain: BundledMcpDef = {
      id: "plain-test",
      name: "Plain",
      description: "",
      npmUrl: null,
      type: "stdio",
      command: "npx",
      args: ["-y", "@scope/pkg@1.0.0"],
      requireApproval: false,
      dependencies: [],
    };
    const resolved = resolveBundledSpawn(plain);
    expect(resolved.source).toBe("fallback");
    expect(resolved.command).toBe("npx");
    expect(resolved.args).toEqual(["-y", "@scope/pkg@1.0.0"]);
  });
});

/**
 * Regression: `resolveBundledSpawn` anchored the in-repo entry on
 * `process.cwd()`, which is only libi's package root in the Next.js SERVER
 * process (a dev checkout, `lib/cli/studio.ts`'s production chdir, or
 * `electron/main.ts`'s chdir to the runtime root).
 *
 * Two of this resolver's three call sites run in the libi MCP CHILD, not the
 * server: `libi.diagnose_mcp` (`mcp/bundled-mcps/diagnose.ts`) and the
 * install/probe path (`mcp/registry/server-prober.ts`, reached from
 * `mcp/bundled-mcps/install-tools.ts`'s `libi.update_dep_status`). The ACP
 * adapter spawns that child with cwd = the AGENT WORKSPACE (`~/.libi/agent/`)
 * — verified on a live packaged app: the `dist-cli/mcp/index.js` child's
 * `lsof -d cwd` is `<LIBI_HOME>/agent`. `mcp/bundled-mcps/install-tools.ts`
 * and `mcp/registry/spawn-env.ts` both already document this and resolve
 * package files from `__dirname` for exactly that reason.
 *
 * So `libi.diagnose_mcp({ mcpId: "libi-tracking" })` threw the
 * "could not resolve the in-repo MCP entry point" diagnostic instead of
 * returning a diagnosis — the tool an agent reaches for precisely WHEN
 * libi-tracking is misbehaving.
 */
describe("in-repo spawn resolution is independent of process.cwd()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking")!;
  const pkgRoot = process.cwd(); // vitest runs from the repo root

  it("resolves the in-repo entry when cwd is the agent workspace (the MCP child's cwd)", () => {
    // Simulate the libi MCP child: cwd is the agent workspace, which holds
    // CLAUDE.md/.claude/ — never `mcp/` or `node_modules/tsx`.
    const agentDir = path.join(os.tmpdir(), "libi-agent-workspace-sim");
    fs.mkdirSync(agentDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(agentDir);

    const resolved = resolveBundledSpawn(def);

    expect(resolved.source).toBe("in-repo");
    // Anchored on libi's package root, NOT the (bogus) cwd.
    expect(resolved.args.some((a) => a.startsWith(pkgRoot))).toBe(true);
    expect(resolved.args.join(" ")).not.toContain(agentDir);
    expect(resolved.args).toContain(
      path.join(pkgRoot, "mcp", "tracking-mcp", "index.ts"),
    );
  });
});
