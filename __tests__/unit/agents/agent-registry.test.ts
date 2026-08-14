import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// The claude-agent-acp resolution path no longer shells out — it goes
// through lib/agents/runtime-install.ts's filesystem probes. Mock those so
// this suite stays hermetic (doesn't depend on whether this dev checkout
// actually has node_modules/.bin/claude-agent-acp on disk) and so tests can
// drive "adapter present" / "adapter absent" deterministically.
const mockResolveRepoLocalAdapterBin = vi.fn<(repoRoot: string) => string | null>();
const mockResolveInstalledAdapterBin = vi.fn<() => string | null>();
const mockResolveBinIn = vi.fn<(dir: string, binName: string) => string | null>();
const AGENT_INSTALL_ROOT = "/home/.libi/agents";
vi.mock("@/lib/agents/runtime-install", () => ({
  resolveRepoLocalAdapterBin: (repoRoot: string) => mockResolveRepoLocalAdapterBin(repoRoot),
  resolveInstalledAdapterBin: () => mockResolveInstalledAdapterBin(),
  resolveClaudeAdapterBin: (bins: { repoLocal: string | null; installed: string | null }) =>
    bins.repoLocal ?? bins.installed ?? null,
  getAgentInstallRoot: () => AGENT_INSTALL_ROOT,
  // Codex's bin lookup moved off `execSync('test -x …')` — `test` is not a
  // cmd.exe builtin, so that probe failed on every Windows machine and codex
  // was reported not-installed regardless of what was on disk. Default: no
  // local bin, which is what "not installed" means for every test that does
  // not explicitly lay one down.
  resolveBinIn: (dir: string, binName: string) => mockResolveBinIn(dir, binName),
  claudeAdapterUnavailableReason: (binRoot: string | null) => ({
    code: binRoot ? "install_failed" : "not_installed",
    message: "stub reason",
    ...(binRoot ? { detail: "native binary missing" } : {}),
  }),
}));

// The Claude native binary (~212MB, an optionalDependency of the SDK) is the
// OTHER half of a working install. Mocked so this suite can drive the split
// state npm's `exit 0 on optional-dep failure` produces: adapter present,
// binary absent.
const mockClaudeNativeBinaryPresent = vi.fn<(root: string) => boolean>();
vi.mock("@/lib/agents/claude-native-binary", () => ({
  claudeNativeBinaryPresent: (root: string) => mockClaudeNativeBinaryPresent(root),
}));

// The Codex engine (~271MB Rust binary, `@openai/codex-<platform>-
// <arch>`) is the same optionalDependency trap in codex clothing: npm exits 0
// when it fails, leaving the launcher present and the engine absent. Mocked so
// tests can drive both halves independently of this checkout's node_modules.
const mockCodexNativeBinaryPresent = vi.fn<(root: string) => boolean>();
vi.mock("@/lib/agents/codex-native-binary", () => ({
  codexNativeBinaryPresent: (root: string) => mockCodexNativeBinaryPresent(root),
  codexNativeBinaryMissingError: (root: string) => `engine binary missing from ${root}`,
}));

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
import {
  codexCandidateTreeRoots,
  detectInstalledAgents,
  getAgentConfig,
  clearAgentCache,
} from "@/lib/agents/acp/agent-registry";

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const REPO_LOCAL_ADAPTER_BIN = "/repo/node_modules/.bin/claude-agent-acp";

describe("detectInstalledAgents", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    mockResolveInstalledAdapterBin.mockReset().mockReturnValue(null);
    mockResolveBinIn.mockReset().mockReturnValue(null);
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
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
    mockResolveRepoLocalAdapterBin.mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReturnValue(null);
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
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    mockResolveInstalledAdapterBin.mockReset().mockReturnValue(null);
    mockResolveBinIn.mockReset().mockReturnValue(null);
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
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
    // Should use the codex-acp binary (local path or npx fallback), not bare "codex"
    expect(config!.command).not.toBe("codex");
  });
});

describe("claude-agent-acp resolution — never falls back to npx", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset();
    mockResolveInstalledAdapterBin.mockReset();
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("uses the repo-local adapter bin verbatim as the spawn command", () => {
    mockResolveRepoLocalAdapterBin.mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    mockResolveInstalledAdapterBin.mockReturnValue(null);
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
    mockResolveRepoLocalAdapterBin.mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReturnValue(installedBin);
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    const config = getAgentConfig("claude-code");

    expect(config!.command).toBe(installedBin);
    expect(config!.command).not.toBe("npx");
  });

  it("REGRESSION: never resolves to npx when the adapter is unavailable anywhere — surfaces installed:false instead", () => {
    mockResolveRepoLocalAdapterBin.mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReturnValue(null);
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
    mockResolveRepoLocalAdapterBin.mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReturnValue(null);
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

    getAgentConfig("claude-code");

    const claudeWhichCalls = mockExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes("claude") && !String(cmd).includes("codex"),
    );
    expect(claudeWhichCalls).toEqual([]);
  });
});

/**
 * The partial-install trap: `@anthropic-ai/claude-agent-sdk`'s ~212MB CLI
 * binary is a PLATFORM-SPECIFIC optionalDependency, and npm exits 0 when an
 * optional dependency fails. A network blip / full disk / proxy timeout on
 * that tarball therefore leaves `.bin/claude-agent-acp` present and the
 * binary it must exec absent — a tree that reports "installed" and then
 * throws at the first `session/new`.
 */
describe("Claude Code availability — adapter bin AND native binary", () => {
  const INSTALLED_ADAPTER_BIN = "/home/.libi/agents/node_modules/.bin/claude-agent-acp";

  beforeEach(() => {
    mockExecSync.mockReset().mockImplementation(() => Buffer.from("/usr/local/bin/claude"));
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReset().mockReturnValue(INSTALLED_ADAPTER_BIN);
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("reports NOT installed when the adapter bin is present but the native binary is missing", () => {
    mockClaudeNativeBinaryPresent.mockReturnValue(false);

    const config = getAgentConfig("claude-code");

    expect(config!.command).toBe(INSTALLED_ADAPTER_BIN);
    expect(config!.installed).toBe(false);
  });

  it("reports installed when BOTH halves are present", () => {
    const config = getAgentConfig("claude-code");
    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("checks the native binary against the AGENT root when the bin came from the runtime install", () => {
    getAgentConfig("claude-code");
    expect(mockClaudeNativeBinaryPresent).toHaveBeenCalledWith(AGENT_INSTALL_ROOT);
  });

  it("checks the native binary against the REPO root when the bin came from a dev checkout", () => {
    // The adapter resolves the SDK relative to its OWN location, so a
    // repo-local bin execs the checkout's binary, not ~/.libi/agents'.
    mockResolveRepoLocalAdapterBin.mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    clearAgentCache();

    getAgentConfig("claude-code");

    expect(mockClaudeNativeBinaryPresent).toHaveBeenCalledWith(process.cwd());
    expect(mockClaudeNativeBinaryPresent).not.toHaveBeenCalledWith(AGENT_INSTALL_ROOT);
  });

  it("carries a reason so the selector can show the row disabled instead of dropping it", () => {
    mockClaudeNativeBinaryPresent.mockReturnValue(false);

    const config = getAgentConfig("claude-code");

    expect(config!.unavailableReason).toMatchObject({
      code: "install_failed",
      detail: "native binary missing",
    });
    expect(config!.unavailableReason!.message.length).toBeGreaterThan(0);
  });

  it("carries a reason when no adapter resolved anywhere", () => {
    mockResolveInstalledAdapterBin.mockReturnValue(null);
    clearAgentCache();

    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
  });

  it("explains a missing bundled codex adapter rather than leaving the disabled row blank", () => {
    // execSync throwing fails the `test -x` on the local codex-acp bin — the
    // one remaining shell probe. The reason names libi's bundled adapter (the
    // thing actually missing), NOT a `codex` CLI the user never needed.
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
    expect(config!.unavailableReason!.message).toContain("Codex adapter");
    expect(config!.unavailableReason!.message).not.toContain("PATH");
  });

  /**
   * REGRESSION: libi downloads the Claude CLI itself (~212MB, as
   * @anthropic-ai/claude-agent-sdk-<platform>-<arch>) and the adapter resolves
   * it by package — `claudeCliPath()` reads CLAUDE_CODE_EXECUTABLE or that
   * package, never PATH. Nothing libi installs puts a `claude` on PATH. So a
   * `which claude` gate reported a COMPLETE install as unavailable for every
   * user who hadn't separately installed Claude Code — invisible on developer
   * machines, which all have it. It also fails a signed-in user in a
   * Finder-launched packaged app, whose PATH is launchd's minimal one plus
   * path-bootstrap's Homebrew/system fallback (no ~/.local/bin, no
   * fnm/nvm/volta npm-global dir).
   */
  it("reports installed with BOTH halves present even when `claude` is nowhere on PATH", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
  });

  it("runs no PATH probe for claude-code at all when both halves are present", () => {
    getAgentConfig("claude-code");

    const claudeProbes = mockExecSync.mock.calls.filter(
      ([cmd]) => String(cmd).includes("claude") && !String(cmd).includes("codex"),
    );
    expect(claudeProbes).toEqual([]);
  });

  it("never probes the native binary for codex — that half is Claude-only", () => {
    getAgentConfig("codex");
    // claude-code is detected in the same pass, so exactly one probe (its own)
    // is expected — codex must not add a second.
    expect(mockClaudeNativeBinaryPresent).toHaveBeenCalledTimes(1);
  });
});

describe("codex-acp resolution — npx fallback is licence-safe for codex (Apache-2.0)", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    mockResolveInstalledAdapterBin.mockReset().mockReturnValue(null);
    mockResolveBinIn.mockReset().mockReturnValue(null);
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("still falls back to npx when no local codex-acp bin is present — fetching the SCOPED package", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("npx");
    // The unscoped `codex-acp` does not exist on the npm registry (404), so
    // the old `npx codex-acp` fallback could never have worked. The fallback
    // must name the real scoped package.
    expect(config!.args).toEqual(["-y", "@agentclientprotocol/codex-acp"]);
  });

  it("resolves to the local bin when present", () => {
    mockResolveBinIn.mockImplementation((dir, binName) =>
      binName === "codex-acp" ? path.join(dir, binName) : null,
    );

    const config = getAgentConfig("codex");

    // realpathSync is mocked to throw here, so the symlink is treated as
    // opaque and spawned unchanged (the node-wrapping case is covered below).
    expect(config!.command).toContain("node_modules/.bin/codex-acp");
    expect(config!.args).toEqual([]);
  });

  it("wraps the adapter script in the resolved node interpreter (Finder-launch PATH hole)", () => {
    // `.bin/codex-acp` is a symlink to a `#!/usr/bin/env node` script —
    // spawning it directly needs `node` on the spawning process's PATH, which
    // a Finder-launched packaged app does not have. Same fix as the Claude
    // adapter: resolve the link and run it through resolveNodeCommand().
    mockResolveBinIn.mockImplementation((dir, binName) =>
      binName === "codex-acp" ? path.join(dir, binName) : null,
    );
    mockRealpathSync.mockImplementation(
      () => "/repo/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
    );

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("/fake/node");
    expect(config!.args).toEqual([
      "/repo/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
    ]);
  });

  it("resolveBin for codex-acp never goes through the claude runtime-install probes, even when they'd report the adapter missing", () => {
    // codex-acp is bundled (Apache-2.0, freely redistributable) — its
    // resolution must be entirely independent of the Claude-adapter
    // runtime-install machinery, whatever that machinery reports.
    mockResolveRepoLocalAdapterBin.mockReturnValue(null);
    mockResolveInstalledAdapterBin.mockReturnValue(null);
    mockResolveBinIn.mockImplementation((dir, binName) =>
      binName === "codex-acp" ? path.join(dir, binName) : null,
    );

    const config = getAgentConfig("codex");

    // codex still resolves its own local bin, completely unaffected by the
    // claude adapter being "missing".
    expect(config!.command).toContain("node_modules/.bin/codex-acp");
    expect(config!.command).not.toBe("npx");
  });
});

/**
 * REGRESSION: Codex availability — bundled adapter + embedded engine, PATH is
 * never consulted.
 *
 * `@zed-industries/codex-acp` EMBEDS its engine: the launcher
 * (`bin/codex-acp.js`) resolves only the platform optionalDependency
 * `@zed-industries/codex-acp-<platform>-<arch>` (~188MB Rust binary with the
 * codex-rs `codex_core` crates compiled in) — it never spawns a `codex` CLI,
 * never reads PATH, and has no env override. Verified empirically against
 * codex-acp 0.16.0 (darwin-arm64): with NO `codex` on PATH, a
 * launchd-minimal PATH, and an empty isolated CODEX_HOME, the binary
 * completes the ACP `initialize` handshake; only auth is missing
 * (`session/new` → ACP -32000 Authentication required). So the old
 * `which codex` gate was the same false negative `detectClaudeCode` removed
 * for Claude: it told users without the standalone codex CLI that Codex is
 * unavailable when the bundled adapter runs fine, and it could fail even
 * users WITH codex in a Finder-launched packaged app (launchd's minimal
 * PATH). Availability deliberately does NOT mean "signed in" — same policy
 * as Claude.
 */
describe("Codex availability — bundled adapter + engine binary, no PATH probe", () => {
  beforeEach(() => {
    // Local codex-acp bin present; any `which`/`where` would FAIL — the exact
    // machine state this fix is for (no standalone codex CLI installed).
    mockExecSync.mockReset().mockImplementation(() => {
      throw new Error("not found");
    });
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(REPO_LOCAL_ADAPTER_BIN);
    mockResolveInstalledAdapterBin.mockReset().mockReturnValue(null);
    mockResolveBinIn.mockReset().mockImplementation((dir, binName) =>
      binName === "codex-acp" ? path.join(dir, binName) : null,
    );
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  it("reports installed with the adapter + engine on disk even when `codex` is nowhere on PATH", () => {
    const config = getAgentConfig("codex");

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

  it("reports NOT installed when the engine platform binary is missing (npm's silent optional-dep failure)", () => {
    mockCodexNativeBinaryPresent.mockReturnValue(false);

    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason).toMatchObject({ code: "install_failed" });
    expect(config!.unavailableReason!.detail).toContain("engine binary missing");
  });

  it("checks the engine binary against the tree the local bin came from (cwd root)", () => {
    getAgentConfig("codex");

    expect(mockCodexNativeBinaryPresent).toHaveBeenCalledWith(process.cwd());
  });

  it("reports NOT installed on the npx fallback even when `codex` IS on PATH", () => {
    // Inverse direction: a user-installed codex CLI must not bless a broken
    // libi tree — npx is an unpinned network fetch, not an install.
    mockResolveBinIn.mockReturnValue(null); // no bundled adapter anywhere
    mockExecSync.mockImplementation(() => Buffer.from("/usr/local/bin/codex"));
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("npx");
    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
  });

  // C4: the adapter reads `process.env["CODEX_PATH"]` FIRST — before it ever
  // looks for the bundled `@openai/codex` launcher — and libi forwards the
  // whole env to the child via buildSpawnEnv. So a user who points it at their
  // own engine has a working setup that the bundled-binary check would
  // hard-block for a file the adapter is never going to open. Mirrors the
  // CLAUDE_CODE_EXECUTABLE override on the Claude side.
  it("honours CODEX_PATH instead of probing the bundled engine binary", () => {
    mockCodexNativeBinaryPresent.mockReturnValue(false);
    const prev = process.env.CODEX_PATH;
    process.env.CODEX_PATH = "/opt/my/codex";
    clearAgentCache();
    try {
      const config = getAgentConfig("codex");
      expect(config!.installed).toBe(true);
      expect(config!.unavailableReason).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = prev;
    }
  });

  it("ignores an empty CODEX_PATH — an unset-looking value must not bless a broken tree", () => {
    mockCodexNativeBinaryPresent.mockReturnValue(false);
    const prev = process.env.CODEX_PATH;
    process.env.CODEX_PATH = "   ";
    clearAgentCache();
    try {
      expect(getAgentConfig("codex")!.installed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = prev;
    }
  });

  it("never touches the CLAUDE native-binary probe for codex", () => {
    // claude-code is detected in the same pass, so exactly one call (its own).
    getAgentConfig("codex");
    expect(mockClaudeNativeBinaryPresent).toHaveBeenCalledTimes(1);
  });
});

describe("codexCandidateTreeRoots — nested vs hoisted npm layouts", () => {
  it("a root NOT under node_modules yields only itself (dev checkout — deps nested as a child)", () => {
    expect(codexCandidateTreeRoots("/repo")).toEqual(["/repo"]);
  });

  it("a scoped package root under node_modules also yields the hoisted tree root (packaged runtime)", () => {
    // electron/main.ts chdirs to Resources/libi-bundle/node_modules/@nagellabs/libi;
    // npm hoisted every dependency to Resources/libi-bundle/node_modules/.
    expect(
      codexCandidateTreeRoots("/app/Resources/libi-bundle/node_modules/@nagellabs/libi"),
    ).toEqual([
      "/app/Resources/libi-bundle/node_modules/@nagellabs/libi",
      "/app/Resources/libi-bundle",
    ]);
  });

  it("walks EVERY enclosing tree, nearest first, for nested-under-nested layouts", () => {
    expect(codexCandidateTreeRoots("/x/node_modules/a/node_modules/b")).toEqual([
      "/x/node_modules/a/node_modules/b",
      "/x/node_modules/a",
      "/x",
    ]);
  });
});

/**
 * REGRESSION (packaged runtime): the packaged shell chdirs to the runtime root
 * `<app>/Contents/Resources/libi-bundle/node_modules/@nagellabs/libi`, but npm
 * HOISTS — `@zed-industries/codex-acp` and its `.bin/codex-acp` shim live at
 * `<app>/Contents/Resources/libi-bundle/node_modules/`, an ANCESTOR of cwd,
 * and the runtime root has NO nested `node_modules` at all (verified against a
 * real packed .app). Probing only `<cwd>/node_modules/.bin/codex-acp` made a
 * fully-present bundled adapter report `not_installed` with a false
 * "reinstall libi" message, while claude-code (which resolves absolute
 * `~/.libi/agents` paths, never cwd-relative ones) reported available on the
 * same app.
 */
describe("Codex resolution — hoisted npm tree (packaged runtime / npx install)", () => {
  const RUNTIME_ROOT = "/app/Resources/libi-bundle/node_modules/@nagellabs/libi";
  const HOISTED_TREE_ROOT = "/app/Resources/libi-bundle";
  const HOISTED_BIN = "/app/Resources/libi-bundle/node_modules/.bin/codex-acp";

  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(RUNTIME_ROOT);
    // Only the HOISTED bin exists — the runtime root has no nested
    // node_modules, exactly like the real packed app.
    mockExecSync.mockReset().mockImplementation(() => {
      throw new Error("not found");
    });
    mockResolveBinIn.mockReset().mockImplementation((dir, binName) =>
      path.join(dir, binName) === HOISTED_BIN ? HOISTED_BIN : null,
    );
    mockResolveRepoLocalAdapterBin.mockReset().mockReturnValue(null);
    mockResolveInstalledAdapterBin
      .mockReset()
      .mockReturnValue("/home/.libi/agents/node_modules/.bin/claude-agent-acp");
    mockClaudeNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockCodexNativeBinaryPresent.mockReset().mockReturnValue(true);
    mockRealpathSync.mockReset().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    clearAgentCache();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it("resolves the HOISTED .bin/codex-acp and reports installed", () => {
    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(true);
    expect(config!.unavailableReason).toBeUndefined();
    expect(config!.command).toBe(HOISTED_BIN);
  });

  it("checks the engine binary against the HOISTED tree root, not cwd", () => {
    getAgentConfig("codex");

    expect(mockCodexNativeBinaryPresent).toHaveBeenCalledWith(HOISTED_TREE_ROOT);
    expect(mockCodexNativeBinaryPresent).not.toHaveBeenCalledWith(RUNTIME_ROOT);
  });

  it("prefers a NESTED bin over the hoisted one when both exist (dev-checkout precedence)", () => {
    const nestedBin = `${RUNTIME_ROOT}/node_modules/.bin/codex-acp`;
    mockResolveBinIn.mockImplementation((dir, binName) => path.join(dir, binName));
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe(nestedBin);
    expect(mockCodexNativeBinaryPresent).toHaveBeenCalledWith(RUNTIME_ROOT);
  });

  it("hoisted adapter present but engine missing → install_failed naming the hoisted tree", () => {
    mockCodexNativeBinaryPresent.mockReturnValue(false);
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason).toMatchObject({ code: "install_failed" });
    expect(config!.unavailableReason!.detail).toContain(HOISTED_TREE_ROOT);
  });

  it("no bin anywhere in any tree → npx fallback, honestly not installed", () => {
    mockResolveBinIn.mockReturnValue(null);
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    clearAgentCache();

    const config = getAgentConfig("codex");

    expect(config!.command).toBe("npx");
    expect(config!.installed).toBe(false);
    expect(config!.unavailableReason!.code).toBe("not_installed");
  });

  it("claude-code detection is unaffected by the hoisted-cwd layout (absolute agent-root paths)", () => {
    const config = getAgentConfig("claude-code");

    expect(config!.installed).toBe(true);
  });
});
