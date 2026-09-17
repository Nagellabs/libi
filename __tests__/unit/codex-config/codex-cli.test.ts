import os from "os";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  mcpLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { mcpListJson, libiCodexEntryShape } from "@/lib/codex-config/codex-cli";
import { serverLogger } from "@/lib/logger";

// mcpListJson short-circuits to [] when the codex home doesn't exist. The
// parse/spawn tests use os.tmpdir() (always present) so codex is actually
// invoked.
const EXISTING_HOME = os.tmpdir();

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
  const calls: Array<{
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    timeout: number | undefined;
  }> = [];
  const spawner = async (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; timeout?: number },
  ) => {
    calls.push({ file, args, env: opts?.env, timeout: opts?.timeout });
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

describe("codex-cli is read-only", () => {
  it("exports no writer — mcp add / remove are commands the user submits in a setup terminal", async () => {
    const mod = await import("@/lib/codex-config/codex-cli");
    for (const name of ["mcpAdd", "mcpRemove", "probeInstalledServers", "mcpList", "userCodexCli"]) {
      expect((mod as Record<string, unknown>)[name], name).toBeUndefined();
    }
    expect(typeof mod.mcpListJson).toBe("function");
  });
});

describe("mcpListJson", () => {
  it("runs `codex mcp list --json` with CODEX_HOME injected and returns the parsed entries", async () => {
    const json = JSON.stringify([
      { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://x" } },
      { name: "fal-ai", enabled: true, transport: { type: "stdio", command: "npx" } },
    ]);
    const { spawner, calls } = makeFakeSpawner({ stdout: json });
    const entries = await mcpListJson({ spawner, codexHome: EXISTING_HOME });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("codex");
    expect(calls[0].args).toEqual(["mcp", "list", "--json"]);
    expect(calls[0].env?.CODEX_HOME).toBe(EXISTING_HOME);
    expect(entries?.map((e) => e.name)).toEqual(["libi", "fal-ai"]);
  });

  it("invokes the resolved binary through its interpreter when given one", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "[]" });
    await mcpListJson({ spawner, codexHome: EXISTING_HOME, bin: "/usr/bin/node", binArgs: ["/x/codex.js"] });
    expect(calls[0].file).toBe("/usr/bin/node");
    expect(calls[0].args).toEqual(["/x/codex.js", "mcp", "list", "--json"]);
  });

  it("passes its timeout through to the spawn, and defaults to 2 s", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "[]" });
    await mcpListJson({ spawner, codexHome: EXISTING_HOME, timeoutMs: 5000 });
    await mcpListJson({ spawner, codexHome: EXISTING_HOME });
    expect(calls.map((c) => c.timeout)).toEqual([5000, 2000]);
  });

  it("logs a failure as the list op it is, and still never throws", async () => {
    const { spawner } = makeFakeSpawner({ throwErr: new Error("spawn codex ENOENT") });
    expect(await mcpListJson({ spawner, codexHome: EXISTING_HOME })).toBeNull();
    expect(serverLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "codex-config", op: "list", err: "spawn codex ENOENT" }),
      expect.any(String),
    );
  });

  it("returns null when codex isn't runnable (spawn error)", async () => {
    const { spawner } = makeFakeSpawner({ throwErr: new Error("spawn codex ENOENT") });
    expect(await mcpListJson({ spawner, codexHome: EXISTING_HOME })).toBeNull();
  });

  it("returns null on unparseable / non-array output", async () => {
    const { spawner } = makeFakeSpawner({ stdout: "not json" });
    expect(await mcpListJson({ spawner, codexHome: EXISTING_HOME })).toBeNull();
    const { spawner: s2 } = makeFakeSpawner({ stdout: '{"name":"libi"}' });
    expect(await mcpListJson({ spawner: s2, codexHome: EXISTING_HOME })).toBeNull();
  });

  it("returns [] WITHOUT spawning codex when the codex home doesn't exist", async () => {
    const { spawner, calls } = makeFakeSpawner({ stdout: "[]" });
    const entries = await mcpListJson({
      spawner,
      codexHome: "/definitely/not/a/real/codex/home/xyz",
    });
    expect(entries).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The named cause for the SILENT half of the Codex entry-collision edge.
 *
 * `enabled = false` on the user's own `[mcp_servers.libi]` survives codex's
 * field-by-field merge of libi's session override, so the in-app chat starts
 * cleanly with no libi tools and nothing fails. There is no rejection to react
 * to, so all libi can do is name the cause in the log — and it asks CODEX for
 * the answer (`codex mcp list --json`) rather than parsing the user's TOML,
 * which is the heuristic `lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`
 * argues against.
 */
describe("libiCodexEntryShape", () => {
  it("reports `disabled` — the shape that silently costs every libi tool", async () => {
    const json = JSON.stringify([
      { name: "libi", enabled: false, transport: { type: "streamable_http", url: "http://x" } },
    ]);
    const { spawner } = makeFakeSpawner({ stdout: json });
    expect(libiCodexEntryShape(await mcpListJson({ spawner, codexHome: EXISTING_HOME }))).toBe("disabled");
  });

  it("reports `stdio` — the shape that kills the session outright", async () => {
    const json = JSON.stringify([
      { name: "libi", enabled: true, transport: { type: "stdio", command: "libi" } },
    ]);
    const { spawner } = makeFakeSpawner({ stdout: json });
    expect(libiCodexEntryShape(await mcpListJson({ spawner, codexHome: EXISTING_HOME }))).toBe("stdio");
  });

  it("reports `http` for the shape libi itself registers", async () => {
    const json = JSON.stringify([
      { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://x" } },
    ]);
    const { spawner } = makeFakeSpawner({ stdout: json });
    expect(libiCodexEntryShape(await mcpListJson({ spawner, codexHome: EXISTING_HOME }))).toBe("http");
  });

  it("reports `absent` when the user has no entry of that name", async () => {
    const json = JSON.stringify([{ name: "fal-ai", enabled: true, transport: { type: "stdio" } }]);
    const { spawner } = makeFakeSpawner({ stdout: json });
    expect(libiCodexEntryShape(await mcpListJson({ spawner, codexHome: EXISTING_HOME }))).toBe("absent");
  });

  /** `unknown` is "no information" — never to be read as "fine". */
  it("reports `unknown` when codex isn't runnable or prints junk", async () => {
    const dead = makeFakeSpawner({ throwErr: new Error("spawn ENOENT") });
    expect(libiCodexEntryShape(await mcpListJson({ spawner: dead.spawner, codexHome: EXISTING_HOME }))).toBe(
      "unknown",
    );
    const junk = makeFakeSpawner({ stdout: "not json" });
    expect(libiCodexEntryShape(await mcpListJson({ spawner: junk.spawner, codexHome: EXISTING_HOME }))).toBe(
      "unknown",
    );
  });
});
