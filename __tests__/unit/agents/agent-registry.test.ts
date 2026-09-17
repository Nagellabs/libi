import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("child_process", async (importOriginal) => ({
  // The rest stays real for modules this suite loads through `importActual`;
  // `execSync` is the PATH probe every test below asserts never runs.
  ...(await importOriginal<typeof import("child_process")>()),
  execSync: vi.fn(),
}));

// Neither adapter's resolution path shells out — both go through
// lib/agents/runtime-install.ts's filesystem probes, parameterised by the
// package (`RuntimeAgentPackage`) being resolved. Mock those so this suite
// stays hermetic (doesn't depend on what this dev checkout actually has under
// node_modules/.bin) and so tests can drive "adapter present" / "adapter
// absent" deterministically PER ADAPTER: the mocks take the package and the
// tests key their answers on `pkg.binName`. Calling them without a package
// means Claude (the production default), so the existing Claude-only mocks
// keep working unchanged.
type Pkg = { binName: string; npmPackage: string; agentId: string };
const CLAUDE_PKG: Pkg = {
  binName: "claude-agent-acp",
  npmPackage: "@agentclientprotocol/claude-agent-acp",
  agentId: "claude-code",
};
const mockResolveRepoLocalAdapterBin = vi.fn<(repoRoot: string, pkg: Pkg) => string | null>();
const mockResolveInstalledAdapterBin = vi.fn<(pkg: Pkg) => string | null>();
const AGENT_INSTALL_ROOT = "/home/.libi/agents";
vi.mock("@/lib/agents/runtime-install", () => ({
  resolveRepoLocalAdapterBin: (repoRoot: string, pkg: Pkg = CLAUDE_PKG) =>
    mockResolveRepoLocalAdapterBin(repoRoot, pkg),
  resolveInstalledAdapterBin: (pkg: Pkg = CLAUDE_PKG) => mockResolveInstalledAdapterBin(pkg),
  resolveClaudeAdapterBin: (bins: { repoLocal: string | null; installed: string | null }) =>
    bins.repoLocal ?? bins.installed ?? null,
  getAgentInstallRoot: () => AGENT_INSTALL_ROOT,
  // Detection only ever asks for the reason when no adapter bin resolved.
  adapterUnavailableReason: (binRoot: string | null, pkg: Pkg) => mockAdapterUnavailableReason(binRoot, pkg),
}));
const stubUnavailableReason = (_binRoot: string | null, pkg: Pkg) => ({
  code: "not_installed",
  message: `stub reason for ${pkg.agentId}`,
});
const mockAdapterUnavailableReason = vi.fn(stubUnavailableReason);

/**
 * Point the per-package resolvers at a repo-local Claude bin and NO codex bin
 * anywhere — the default every suite starts from. `resolveInstalledAdapterBin`
 * is keyed by the package it is asked for so Claude and Codex answers are
 * independent, exactly as they are on disk.
 */
function resolveClaudeOnly(repoLocal: string | null, installed: string | null): void {
  mockResolveRepoLocalAdapterBin.mockImplementation((_root, pkg) =>
    pkg.binName === "claude-agent-acp" ? repoLocal : null,
  );
  mockResolveInstalledAdapterBin.mockImplementation((pkg) =>
    pkg.binName === "claude-agent-acp" ? installed : null,
  );
}

type BinPair = { repoLocal?: string | null; installed?: string | null };

/** Independent answers for each adapter's two candidates; anything omitted is absent. */
function resolveBins(bins: { claude?: BinPair; codex?: BinPair }): void {
  const pick = (pkg: Pkg): BinPair => (pkg.binName === "codex-acp" ? bins.codex : bins.claude) ?? {};
  mockResolveRepoLocalAdapterBin.mockImplementation((_root, pkg) => pick(pkg).repoLocal ?? null);
  mockResolveInstalledAdapterBin.mockImplementation((pkg) => pick(pkg).installed ?? null);
}

// spawnViaNodeIfScript resolves the interpreter via node-runtime — pin it so
// assertions on the wrapped command are deterministic on every machine.
vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => "/fake/node",
}));

// spawnViaNodeIfScript realpaths the bin symlink. The codex local-bin path is
// derived from the REAL process.cwd(), so without this override the test
// outcome would depend on whether this checkout's node_modules happens to
// contain codex-acp. Default: throw (path treated as opaque, command spawned
// unchanged) — individual tests override to simulate the symlink resolving.
const mockRealpathSync = vi.fn<(p: string) => string>(() => {
  throw new Error("ENOENT");
});
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    realpathSync: (p: string) => mockRealpathSync(p),
    default: { ...actual, realpathSync: (p: string) => mockRealpathSync(p) },
  };
});

import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverLogger } from "@/lib/logger";
import {
  detectInstalledAgents,
  getAgentConfig,
  clearAgentCache,
} from "@/lib/agents/acp/agent-registry";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const REPO_LOCAL_ADAPTER_BIN = "/repo/node_modules/.bin/claude-agent-acp";

describe("detectInstalledAgents", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    resolveClaudeOnly(REPO_LOCAL_ADAPTER_BIN, null);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("marks one agent installed and others not", () => {
    // Only the first call (claude) succeeds; subsequent calls throw
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("claude")) {
        return Buffer.from("/usr/local/bin/claude");
      }
      throw new Error("not found");
    });

    const agents = detectInstalledAgents();

    const claude = agents.find((a) => a.id === "claude-code");
    const codex = agents.find((a) => a.id === "codex");

    expect(claude).toBeDefined();
    expect(claude!.installed).toBe(true);
    expect(codex!.installed).toBe(false);
  });

  it("marks all agents as not installed when none are found", () => {
    // Nothing on PATH AND no Claude adapter anywhere — the only state in
    // which every agent is genuinely unavailable. Claude Code's availability
    // does not depend on PATH at all (see the no-PATH suite below), so it has
    // to be made unavailable through the adapter, not through `which`.
    resolveClaudeOnly(null, null);
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const agents = detectInstalledAgents();

    expect(agents.every((a) => a.installed === false)).toBe(true);
  });

  it("returns all known agents regardless of installation", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const agents = detectInstalledAgents();

    expect(agents.map((a) => a.id)).toEqual(["claude-code", "codex"]);
  });
});

describe("getAgentConfig", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    resolveClaudeOnly(REPO_LOCAL_ADAPTER_BIN, null);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("returns config for a known installed agent", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("claude")) {
        return Buffer.from("/usr/local/bin/claude");
      }
      throw new Error("not found");
    });

    const config = getAgentConfig("claude-code");

    expect(config).toBeDefined();
    expect(config!.id).toBe("claude-code");
    expect(config!.name).toBe("Claude Code");
    expect(config!.detectCommand).toBe("claude");
    expect(config!.installed).toBe(true);
  });

  it("returns config for a known agent even when not installed", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("codex");

    expect(config).toBeDefined();
    expect(config!.id).toBe("codex");
    expect(config!.installed).toBe(false);
  });

  it("returns undefined for an unknown agent id", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("totally-unknown-agent");

    expect(config).toBeUndefined();
  });

  it("codex entry does not use bare 'codex' as the command", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("codex");

    expect(config).toBeDefined();
    // A resolved codex-acp bin, or empty when none is installed — never bare "codex"
    expect(config!.command).not.toBe("codex");
  });
});

describe("claude-agent-acp resolution — never falls back to npx", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("uses the repo-local adapter bin verbatim as the spawn command", () => {
    resolveClaudeOnly(REPO_LOCAL_ADAPTER_BIN, null);
    // Even if `which claude` would succeed, the resolved command must be the
    // real adapter bin path, not "npx" and not bare "claude".
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    const config = getAgentConfig("claude-code");

    expect(config!.command).toBe(REPO_LOCAL_ADAPTER_BIN);
    expect(config!.command).not.toBe("npx");
    expect(config!.args).toEqual([]);
  });

  it("falls back to the runtime-installed adapter bin when there is no repo-local one", () => {
    const installedBin = "/home/.libi/agents/node_modules/.bin/claude-agent-acp";
    resolveClaudeOnly(null, installedBin);
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    const config = getAgentConfig("claude-code");

    expect(config!.command).toBe(installedBin);
    expect(config!.command).not.toBe("npx");
  });

  it("REGRESSION: never resolves to npx when the adapter is unavailable anywhere — surfaces installed:false instead", () => {
    resolveClaudeOnly(null, null);
    // Even if `which claude` succeeds (the CLI is on PATH), the agent must
    // NOT be reported installed, and it must NEVER spawn via npx — that
    // would be an unpinned network fetch of an arbitrary version in a
    // packaged app. This is the exact defect this task removes.
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    const config = getAgentConfig("claude-code");

    expect(config).toBeDefined();
    expect(config!.command).not.toBe("npx");
    expect(config!.args).not.toContain("claude-agent-acp");
    expect(config!.installed).toBe(false);
  });

  it("does not run the `which claude` probe at all when the adapter is unresolved", () => {
    resolveClaudeOnly(null, null);
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    getAgentConfig("claude-code");

    const claudeWhichCalls = mockExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes("claude") && !String(cmd).includes("codex"),
    );
    expect(claudeWhichCalls).toEqual([]);
  });
});

/**
 * "Installed" means the ACP adapter is on disk. The chat runs the user's own
 * `claude` (resolved separately by `resolveAgentCli` and handed to the adapter
 * as CLAUDE_CODE_EXECUTABLE), so libi installs no engine and detection checks
 * for none — and never reads PATH.
 */
describe("Claude Code availability — adapter bin present ⇒ installed, no engine, no PATH", () => {
  const INSTALLED_ADAPTER_BIN = `${AGENT_INSTALL_ROOT}/node_modules/.bin/claude-agent-acp`;

  beforeEach(() => {
    mockExecSync.mockReset().mockImplementation(() => Buffer.from("/usr/local/bin/claude"));
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    resolveClaudeOnly(null, INSTALLED_ADAPTER_BIN);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("reports installed when the adapter bin resolves from the agent root, with no engine package on disk", () => {
    // AGENT_INSTALL_ROOT does not exist on this machine, so no platform package
    // can be there: an engine gate would report this tree broken.
    const config = getAgentConfig("claude-code");
    expect(config!.command).toBe(INSTALLED_ADAPTER_BIN);
    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("reports installed when the adapter bin resolves repo-local", () => {
    resolveClaudeOnly(REPO_LOCAL_ADAPTER_BIN, INSTALLED_ADAPTER_BIN);
    clearAgentCache();

    const config = getAgentConfig("claude-code");

    expect(config!.command).toBe(REPO_LOCAL_ADAPTER_BIN);
    expect(config!.installed).toBe(true);
  });

  it("carries the adapter's reason when no adapter resolved anywhere", () => {
    resolveClaudeOnly(null, null);
    clearAgentCache();

    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason).toMatchObject({ code: "not_installed", message: "stub reason for claude-code" });
  });

  it("explains a not-yet-installed codex adapter through adapterUnavailableReason rather than leaving the disabled row blank", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason).toMatchObject({
      code: "not_installed",
      message: "stub reason for codex",
    });
  });

  it("reports installed even when `claude` is nowhere on PATH — the CLI is resolved elsewhere", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("runs no PATH probe for claude-code at all", () => {
    getAgentConfig("claude-code");

    const claudeProbes = mockExecSync.mock.calls.filter(
      ([cmd]) => String(cmd).includes("claude") && !String(cmd).includes("codex"),
    );
    expect(claudeProbes).toEqual([]);
  });
});

/**
 * Codex's adapter left `dependencies` on 2026-09-08: it is a
 * devDependency now, resolved EXACTLY like Claude's — the checkout's own
 * `node_modules/.bin` in dev, else the runtime install under `~/.libi/agents`,
 * else not installed. The `npx -y @agentclientprotocol/codex-acp` fallback
 * went with the production dependency it backed: an unpinned network fetch
 * that was never reported as installed anyway.
 */
describe("codex-acp resolution — repo-local, then ~/.libi/agents, never npx", () => {
  const REPO_LOCAL_CODEX_BIN = "/repo/node_modules/.bin/codex-acp";
  const INSTALLED_CODEX_BIN = `${AGENT_INSTALL_ROOT}/node_modules/.bin/codex-acp`;

  beforeEach(() => {
    mockExecSync.mockReset().mockImplementation(() => {
      throw new Error("not found");
    });
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    resolveBins({ claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN } });
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("resolves the repo-local bin first", () => {
    resolveBins({
      claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN },
      codex: { repoLocal: REPO_LOCAL_CODEX_BIN, installed: INSTALLED_CODEX_BIN },
    });

    const config = getAgentConfig("codex");

    // realpathSync is mocked to throw here, so the symlink is treated as
    // opaque and spawned unchanged (the node-wrapping case is covered below).
    expect(config!.command).toBe(REPO_LOCAL_CODEX_BIN);
    expect(config!.args).toEqual([]);
    expect(config!.installed).toBe(true);
  });

  it("falls back to the runtime-installed bin under ~/.libi/agents", () => {
    resolveBins({
      claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN },
      codex: { installed: INSTALLED_CODEX_BIN },
    });

    const config = getAgentConfig("codex");

    expect(config!.command).toBe(INSTALLED_CODEX_BIN);
    expect(config!.installed).toBe(true);
  });

  it("REGRESSION: with no bin anywhere it is not installed — never npx, and nothing to spawn", () => {
    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(false);
    expect(config!.command).toBe("");
    expect(config!.args).toEqual([]);
    expect(config!.unavailableReason).toMatchObject({
      code: "not_installed",
      message: "stub reason for codex",
    });
  });

  it("asks the resolvers for the CODEX package, in the same two places Claude is asked for", () => {
    resolveBins({ codex: { installed: INSTALLED_CODEX_BIN } });

    getAgentConfig("codex");

    expect(mockResolveRepoLocalAdapterBin).toHaveBeenCalledWith(
      process.cwd(),
      expect.objectContaining({ binName: "codex-acp", npmPackage: "@agentclientprotocol/codex-acp" }),
    );
    expect(mockResolveInstalledAdapterBin).toHaveBeenCalledWith(
      expect.objectContaining({ binName: "codex-acp" }),
    );
  });

  it("wraps the adapter script in the resolved node interpreter (Finder-launch PATH hole)", () => {
    // `.bin/codex-acp` is a symlink to a `#!/usr/bin/env node` script —
    // spawning it directly needs `node` on the spawning process's PATH, which
    // a Finder-launched packaged app does not have. Same fix as the Claude
    // adapter: resolve the link and run it through resolveNodeCommand().
    const script = `${AGENT_INSTALL_ROOT}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;
    resolveBins({ codex: { installed: INSTALLED_CODEX_BIN } });
    mockRealpathSync.mockImplementation(() => script);

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("/fake/node");
    expect(config!.args).toEqual([script]);
  });

  it("resolves independently of Claude — one adapter missing says nothing about the other", () => {
    resolveBins({ codex: { installed: INSTALLED_CODEX_BIN } }); // no Claude anywhere

    expect(getAgentConfig("codex")!.installed).toBe(true);
    expect(getAgentConfig("claude-code")!.installed).toBe(false);
  });
});

/**
 * "Installed" means the codex-acp adapter is on disk. The adapter execs the
 * user's own `codex` (resolved separately by `resolveAgentCli` and handed over
 * as CODEX_PATH), so libi installs no `@openai/codex` engine and detection
 * checks for none — and never reads PATH.
 */
describe("Codex availability — adapter bin present ⇒ installed, no engine, no PATH", () => {
  const REPO_LOCAL_CODEX_BIN = "/repo/node_modules/.bin/codex-acp";
  const INSTALLED_CODEX_BIN = `${AGENT_INSTALL_ROOT}/node_modules/.bin/codex-acp`;

  beforeEach(() => {
    // Any `which`/`where` would FAIL — no codex CLI on this process's PATH.
    mockExecSync.mockReset().mockImplementation(() => {
      throw new Error("not found");
    });
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    resolveBins({
      claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN },
      codex: { repoLocal: REPO_LOCAL_CODEX_BIN },
    });
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("reports installed with the adapter on disk even when `codex` is nowhere on PATH", () => {
    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("reports installed from the agent root with no engine package on disk", () => {
    resolveBins({ claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN }, codex: { installed: INSTALLED_CODEX_BIN } });
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe(INSTALLED_CODEX_BIN);
    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("runs no `which codex` / `where codex` PATH probe at all", () => {
    getAgentConfig("codex");

    const pathProbes = mockExecSync.mock.calls.filter(([cmd]) =>
      /\b(which|where)\b/.test(String(cmd)),
    );
    expect(pathProbes).toEqual([]);
  });

  it("reports NOT installed with no adapter anywhere even when `codex` IS on PATH", () => {
    // A user-installed codex CLI must not bless a libi that has not installed
    // its adapter yet — there is nothing to spawn.
    resolveBins({ claude: { repoLocal: REPO_LOCAL_ADAPTER_BIN } });
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/codex"));
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("");
    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
  });
});

/**
 * Detection no longer consults an engine binary or an engine override for
 * either agent: the CLI half is `resolveAgentCli`'s alone.
 */
describe("agent-registry source — no engine gate and no engine override remain", () => {
  it("imports neither engine-binary module and reads no CODEX_PATH / CLAUDE_CODE_EXECUTABLE", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/agents/acp/agent-registry.ts"), "utf-8");
    expect(src).not.toMatch(/(claude|codex)-native/);
    expect(src).not.toMatch(/NativeBinaryPresent/);
    expect(src).not.toMatch(/codex_path_override/);
    expect(src).not.toMatch(/CODEX_PATH/);
    expect(src).not.toMatch(/CLAUDE_CODE_EXECUTABLE/);
    expect(src).not.toMatch(/restart libi/);
  });
});

/**
 * The packaged runtime and `npx @nagellabs/libi` carry NO codex-acp in their
 * npm tree any more: it is a devDependency, excluded from the runtime snapshot
 * (`npm install --omit=dev`) and never in the tarball. So in production the
 * packaged shell's cwd — the runtime root under
 * `libi-bundle/node_modules/@nagellabs/libi` — holds nothing, and the ONLY
 * place the adapter can be is the absolute agent root, where the Claude
 * adapter has always lived. Until 2026-09-08 this suite proved a walk up the
 * `node_modules` ancestors of cwd found the HOISTED bundled copy; that walk is
 * gone with the bundled copy, and this suite now proves the layout that
 * replaced it.
 */
describe("Codex resolution — runtime-installed adapter (packaged runtime / npx install)", () => {
  const RUNTIME_ROOT = "/app/Resources/libi-bundle/node_modules/@nagellabs/libi";
  const HOISTED_TREE_ROOT = "/app/Resources/libi-bundle";
  const INSTALLED_CODEX_BIN = `${AGENT_INSTALL_ROOT}/node_modules/.bin/codex-acp`;
  const INSTALLED_CLAUDE_BIN = `${AGENT_INSTALL_ROOT}/node_modules/.bin/claude-agent-acp`;

  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(RUNTIME_ROOT);
    mockExecSync.mockReset().mockImplementation(() => {
      throw new Error("not found");
    });
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    // Nothing repo-local for either adapter — exactly like a real packed app.
    resolveBins({
      claude: { installed: INSTALLED_CLAUDE_BIN },
      codex: { installed: INSTALLED_CODEX_BIN },
    });
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it("resolves ~/.libi/agents' .bin/codex-acp and reports installed", () => {
    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
    expect(config!.command).toBe(INSTALLED_CODEX_BIN);
  });

  it("no longer walks node_modules ancestors of cwd — only the checkout root is probed for a repo-local bin", () => {
    getAgentConfig("codex");

    expect(mockResolveRepoLocalAdapterBin).toHaveBeenCalledWith(
      RUNTIME_ROOT,
      expect.objectContaining({ binName: "codex-acp" }),
    );
    expect(mockResolveRepoLocalAdapterBin).not.toHaveBeenCalledWith(
      HOISTED_TREE_ROOT,
      expect.anything(),
    );
  });

  it("prefers a repo-local bin over the installed one when both exist (dev-checkout precedence)", () => {
    const nestedBin = `${RUNTIME_ROOT}/node_modules/.bin/codex-acp`;
    resolveBins({
      claude: { installed: INSTALLED_CLAUDE_BIN },
      codex: { repoLocal: nestedBin, installed: INSTALLED_CODEX_BIN },
    });
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe(nestedBin);
  });

  it("installed adapter present with no engine anywhere → installed (the adapter execs the user's codex)", () => {
    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("no bin anywhere → honestly not installed, with nothing to spawn", () => {
    resolveBins({ claude: { installed: INSTALLED_CLAUDE_BIN } });
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("");
    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
  });

  it("claude-code detection is unaffected by the packaged cwd (same absolute agent-root paths)", () => {
    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(true);
  });
});

describe("the unresolved-adapter warning says what is actually happening", () => {
  // The REAL reason helper against a scratch LIBI_HOME, so the copy asserted
  // here is the copy a user's log gets.
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/adapter-tree")>("@/lib/agents/adapter-tree");
    previousHome = process.env.LIBI_HOME;
    home = mkdtempSync(path.join(os.tmpdir(), "libi-registry-"));
    process.env.LIBI_HOME = home;
    mockAdapterUnavailableReason.mockImplementation((binRoot, pkg) =>
      actual.adapterUnavailableReason(binRoot, pkg as unknown as Parameters<typeof actual.adapterUnavailableReason>[1]),
    );
    resolveBins({});
    clearAgentCache();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = previousHome;
    mockAdapterUnavailableReason.mockImplementation(stubUnavailableReason);
    rmSync(home, { recursive: true, force: true });
    clearAgentCache();
  });

  function unresolvedWarning(op: string): [Record<string, unknown>, string] {
    const warn = vi.spyOn(serverLogger, "warn");
    try {
      detectInstalledAgents();
      const call = warn.mock.calls.find(([o]) => (o as { op?: string }).op === op);
      expect(call).toBeDefined();
      return call as unknown as [Record<string, unknown>, string];
    } finally {
      warn.mockRestore();
    }
  }

  it("a fresh home with no install running points at Agents, never at an install that is not happening", () => {
    const [fields, message] = unresolvedWarning("claude_adapter_unresolved");
    expect(fields).toMatchObject({ tag: "agent-registry", code: "not_installed" });
    expect(message).toMatch(/Claude Code support isn't downloaded yet — set it up in Agents/);
    expect(message).not.toMatch(/installing/i);
  });

  it("says installing only while an install actually holds the agent-root lock", () => {
    mkdirSync(path.join(home, "agents"), { recursive: true });
    writeFileSync(
      path.join(home, "agents", ".agent-install.lock"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    const [fields, message] = unresolvedWarning("claude_adapter_unresolved");
    expect(fields).toMatchObject({ code: "installing" });
    expect(message).toMatch(/Downloading Claude Code support/);
  });

  it("codex's warning follows the same rule", () => {
    const [fields, message] = unresolvedWarning("codex_adapter_unresolved");
    expect(fields).toMatchObject({ code: "not_installed" });
    expect(message).toMatch(/Codex support isn't downloaded yet — set it up in Agents/);
  });
});
