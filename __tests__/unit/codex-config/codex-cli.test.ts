import os from "os";
import { describe, it, expect, afterEach, vi } from "vitest";

// Recording fake — inspected below to assert a leaked secret never reaches
// the logger, not just that mcpAdd's RETURN value is clean.
vi.mock("@/lib/logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  mcpLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  mcpAdd,
  mcpRemove,
  mcpList,
  isCodexValidServerName,
  toCodexServerName,
  probeInstalledServers,
} from "@/lib/codex-config/codex-cli";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import { serverLogger } from "@/lib/logger";

// probeInstalledServers short-circuits to [] when the codex home doesn't
// exist. The parse/spawn tests use os.tmpdir() (always present) so codex is
// actually invoked.
const EXISTING_HOME = os.tmpdir();
import type { McpServerEntry } from "@/lib/mcp-config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(serverLogger.warn).mockClear();
});

/**
 * A recording fake execFile-style spawner. Captures the exact argv + options
 * (including the child env) it was invoked with, then resolves with a scripted
 * result. NEVER spawns a real process.
 */
function makeFakeSpawner(
  result: { stdout?: string; stderr?: string; code?: number; throwErr?: Error } = {},
) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawner = async (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; timeout?: number },
  ) => {
    calls.push({ file, args, env: opts?.env });
    if (result.throwErr) throw result.throwErr;
    if (result.code && result.code !== 0) {
      const err = new Error(result.stderr ?? "nonzero") as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      err.code = result.code;
      err.stdout = result.stdout ?? "";
      err.stderr = result.stderr ?? "";
      throw err;
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { spawner, calls };
}

describe("mcpAdd — stdio entries", () => {
  it("spawns `codex mcp add <name> -- <command> <args…>`", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    const entry: McpServerEntry = { command: "node", args: ["server.js", "--flag"] };
    const res = await mcpAdd("libi", entry, { spawner });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual([
      "mcp",
      "add",
      "libi",
      "--",
      "node",
      "server.js",
      "--flag",
    ]);
  });

  it("emits one --env K=V pair per env var (before the -- separator)", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    const entry: McpServerEntry = {
      command: "node",
      args: ["s.js"],
      env: { FOO: "bar", BAZ: "qux" },
    };
    await mcpAdd("libi", entry, { spawner });
    expect(calls[0].args).toEqual([
      "mcp",
      "add",
      "libi",
      "--env",
      "FOO=bar",
      "--env",
      "BAZ=qux",
      "--",
      "node",
      "s.js",
    ]);
  });

  it("emits `add <name> -- <command>` with no args when args is absent", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    await mcpAdd("libi", { command: "node" }, { spawner });
    expect(calls[0].args).toEqual(["mcp", "add", "libi", "--", "node"]);
  });
});

describe("mcpAdd — HTTP entries", () => {
  it("spawns `codex mcp add <name> --url <url> --bearer-token-env-var <VAR>`", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    const entry: McpServerEntry = {
      type: "http",
      url: "https://mcp.fal.ai/",
      headers: { Authorization: "Bearer ${FAL_KEY}" },
    };
    const res = await mcpAdd("falc", entry, { spawner });
    expect(res.ok).toBe(true);
    expect(calls[0].args).toEqual([
      "mcp",
      "add",
      "falc",
      "--url",
      "https://mcp.fal.ai/",
      "--bearer-token-env-var",
      "FAL_KEY",
    ]);
  });

  it("emits url only when there is no bearer header", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    const entry: McpServerEntry = { type: "http", url: "https://mcp.fal.ai/" };
    await mcpAdd("falc", entry, { spawner });
    expect(calls[0].args).toEqual(["mcp", "add", "falc", "--url", "https://mcp.fal.ai/"]);
  });
});

describe("mcpAdd — CODEX_HOME injection", () => {
  it("sets CODEX_HOME in the child env from resolveCodexHome()", async () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex/home");
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    await mcpAdd("libi", { command: "node" }, { spawner });
    expect(calls[0].env?.CODEX_HOME).toBe("/custom/codex/home");
  });

  it("defaults CODEX_HOME to resolveCodexHome() when CODEX_HOME unset", async () => {
    vi.stubEnv("CODEX_HOME", "");
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    await mcpAdd("libi", { command: "node" }, { spawner });
    expect(calls[0].env?.CODEX_HOME).toBe(resolveCodexHome());
  });

  it("honors an explicit codexHome override over the env", async () => {
    vi.stubEnv("CODEX_HOME", "/env/codex/home");
    const { spawner, calls } = makeFakeSpawner({ stdout: "ok" });
    await mcpAdd("libi", { command: "node" }, { spawner, codexHome: "/override/codex" });
    expect(calls[0].env?.CODEX_HOME).toBe("/override/codex");
  });
});

describe("mcpAdd — error handling (never throws)", () => {
  it("returns { ok:false, stderr } on non-zero exit", async () => {
    const { spawner } = makeFakeSpawner({ code: 1, stderr: "boom" });
    const res = await mcpAdd("libi", { command: "node" }, { spawner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stderr).toContain("boom");
  });

  it("returns { ok:false } on a spawn error (binary missing), does not throw", async () => {
    const { spawner } = makeFakeSpawner({ throwErr: new Error("spawn codex ENOENT") });
    const res = await mcpAdd("libi", { command: "node" }, { spawner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stderr).toContain("ENOENT");
  });
});

describe("mcpAdd — does not write a provider key to the log when codex fails", () => {
  // `--env KEY=<value>` is inlined into argv (the codex stdio contract has no
  // env-var-reference flag), and Node puts the full argv into `err.message`
  // on an execFile rejection — so a naive catch handler would log the raw
  // key straight to ~/.libi/logs/libi.log, the file users paste into bug
  // reports. Sentinel style follows __tests__/unit/security/secret-scrub.test.ts.
  const SECRET = "sk-LEAKSENTINEL-1";

  it("scrubs the secret from both the returned stderr and every logger.warn call", async () => {
    const { spawner } = makeFakeSpawner({
      throwErr: new Error(
        `Command failed: codex mcp add fal-ai --env FAL_KEY=${SECRET} -- node server.js`,
      ),
    });
    const entry: McpServerEntry = {
      command: "node",
      args: ["server.js"],
      env: { FAL_KEY: SECRET },
    };

    const res = await mcpAdd("fal-ai", entry, { spawner });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stderr).not.toContain(SECRET);

    // The real assertion: nothing handed to the logger carries the secret,
    // stringified so it can't hide inside a nested field.
    const warnCalls = vi.mocked(serverLogger.warn).mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnCalls)).not.toContain(SECRET);
  });
});

describe("mcpRemove", () => {
  it("spawns `codex mcp remove <name>` and injects CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex/home");
    const { spawner, calls } = makeFakeSpawner({ stdout: "removed" });
    const res = await mcpRemove("libi", { spawner });
    expect(res.ok).toBe(true);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["mcp", "remove", "libi"]);
    expect(calls[0].env?.CODEX_HOME).toBe("/custom/codex/home");
  });

  it("returns { ok:false, stderr } on non-zero exit, never throws", async () => {
    const { spawner } = makeFakeSpawner({ code: 2, stderr: "no such server" });
    const res = await mcpRemove("ghost", { spawner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stderr).toContain("no such server");
  });
});

describe("mcpList", () => {
  it("spawns `codex mcp list` and returns stdout on success", async () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex/home");
    const { spawner, calls } = makeFakeSpawner({ stdout: "libi\nfalc\n" });
    const res = await mcpList({ spawner });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stdout).toBe("libi\nfalc\n");
    expect(calls[0].args).toEqual(["mcp", "list"]);
    expect(calls[0].env?.CODEX_HOME).toBe("/custom/codex/home");
  });

  it("returns { ok:false, stderr } on failure, never throws", async () => {
    const { spawner } = makeFakeSpawner({ throwErr: new Error("spawn codex ENOENT") });
    const res = await mcpList({ spawner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stderr).toContain("ENOENT");
  });
});

describe("isCodexValidServerName", () => {
  it("accepts letters, numbers, hyphens, underscores", () => {
    expect(isCodexValidServerName("libi")).toBe(true);
    expect(isCodexValidServerName("fal-ai")).toBe(true);
    expect(isCodexValidServerName("my_server_2")).toBe(true);
  });

  it("rejects names with spaces or other punctuation", () => {
    expect(isCodexValidServerName("YouTube Downloader")).toBe(false);
    expect(isCodexValidServerName("a.b")).toBe(false);
    expect(isCodexValidServerName("")).toBe(false);
  });
});

describe("toCodexServerName", () => {
  it("passes already-valid names through unchanged (preserving case)", () => {
    expect(toCodexServerName("libi")).toBe("libi");
    expect(toCodexServerName("fal-ai")).toBe("fal-ai");
    expect(toCodexServerName("my_server_2")).toBe("my_server_2");
  });

  it("replaces spaces with a single hyphen", () => {
    expect(toCodexServerName("YouTube Downloader")).toBe("YouTube-Downloader");
  });

  it("collapses runs of invalid chars and trims leading/trailing hyphens", () => {
    expect(toCodexServerName("a . b")).toBe("a-b");
    expect(toCodexServerName("  spaced  name  ")).toBe("spaced-name");
    expect(toCodexServerName("(weird!!name)")).toBe("weird-name");
  });

  it("always yields a codex-valid name", () => {
    for (const n of ["YouTube Downloader", "a.b.c", "!!!", "café münchen"]) {
      expect(isCodexValidServerName(toCodexServerName(n))).toBe(true);
    }
  });

  it("falls back to a placeholder when nothing valid remains", () => {
    expect(toCodexServerName("!!!")).toBe("server");
    expect(toCodexServerName("")).toBe("server");
  });
});

describe("probeInstalledServers", () => {
  it("runs `codex mcp list --json` and returns the server names", async () => {
    const json = JSON.stringify([
      { name: "libi", enabled: true },
      { name: "fal-ai", enabled: true },
    ]);
    const { spawner, calls } = makeFakeSpawner({ stdout: json });
    const names = await probeInstalledServers({ spawner, codexHome: EXISTING_HOME });
    expect(calls[0].args).toEqual(["mcp", "list", "--json"]);
    expect(names).toEqual(["libi", "fal-ai"]);
  });

  it("returns null when codex isn't runnable (spawn error)", async () => {
    const { spawner } = makeFakeSpawner({ throwErr: new Error("spawn codex ENOENT") });
    expect(await probeInstalledServers({ spawner, codexHome: EXISTING_HOME })).toBeNull();
  });

  it("returns null on unparseable / non-array output", async () => {
    const { spawner } = makeFakeSpawner({ stdout: "not json" });
    expect(await probeInstalledServers({ spawner, codexHome: EXISTING_HOME })).toBeNull();
    const { spawner: s2 } = makeFakeSpawner({ stdout: '{"name":"libi"}' });
    expect(
      await probeInstalledServers({ spawner: s2, codexHome: EXISTING_HOME }),
    ).toBeNull();
  });

  it("skips entries without a string name", async () => {
    const json = JSON.stringify([{ name: "libi" }, { enabled: true }, { name: 5 }]);
    const { spawner } = makeFakeSpawner({ stdout: json });
    expect(
      await probeInstalledServers({ spawner, codexHome: EXISTING_HOME }),
    ).toEqual(["libi"]);
  });

  it("returns [] WITHOUT spawning codex when the codex home doesn't exist", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "[]" });
    const names = await probeInstalledServers({
      spawner,
      codexHome: "/definitely/not/a/real/codex/home/xyz",
    });
    expect(names).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
