/**
 * The in-app ACP entry and the `libi connect` registration must share ONE name.
 *
 * That collision is the entire mechanism by which an in-app session mounts libi
 * ONCE on a machine where the user has run `libi connect`: libi never edits the
 * user's agent config, so the only way to remove the duplicate is for libi's own
 * session-scoped entry to REPLACE the config one, which both adapters do by
 * name. Let the two names drift apart and every in-app context on a connected
 * machine carries libi's whole tool surface twice — measured live on
 * 2026-09-09 as two aggregator sessions per chat (195 in-app + 194 headerless).
 *
 * These are cheap invariants over things that are easy to "clean up" later:
 * the shared constant, the argv `libi connect` actually runs, and the ACP entry
 * the SessionManager hands `newSession`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LIBI_MCP_ENTRY_NAME,
  CODEX_ACP_DISABLE_MCP_FILTER_ENV,
  SURFACE_HEADER,
  IN_APP_SURFACE,
} from "@/lib/mcp/agent-surface";
import {
  MCP_SERVER_NAME,
  claudeMcpAddArgs,
  codexMcpAddArgs,
  addedServerName,
} from "@/lib/cli/connect";

vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
  return { ...actual, getCurrentMcpPort: () => 3999 };
});

describe("libi's MCP entry name is shared by both surfaces", () => {
  it("`libi connect` registers exactly the name the in-app entry uses", () => {
    expect(MCP_SERVER_NAME).toBe(LIBI_MCP_ENTRY_NAME);
    expect(addedServerName(claudeMcpAddArgs("http://127.0.0.1:3457/mcp"))).toBe(
      LIBI_MCP_ENTRY_NAME,
    );
    expect(addedServerName(codexMcpAddArgs("http://127.0.0.1:3457/mcp"))).toBe(
      LIBI_MCP_ENTRY_NAME,
    );
  });

  it("the ACP entry carries that name plus the in-app surface header", async () => {
    const { getMcpServersForAcp, invalidateMcpConfig } = await import("@/lib/mcp-config");
    invalidateMcpConfig({ reason: "collision-test" });
    for (const agentId of ["claude-code", "codex"]) {
      const entry = getMcpServersForAcp(agentId)[0] as {
        name: string;
        headers: { name: string; value: string }[];
      };
      expect(entry.name).toBe(LIBI_MCP_ENTRY_NAME);
      expect(entry.headers).toEqual([{ name: SURFACE_HEADER, value: IN_APP_SURFACE }]);
    }
    invalidateMcpConfig({ reason: "collision-test-cleanup" });
  });

  /**
   * The name is only half the mechanism on Codex. codex-acp DROPS an ACP
   * `mcpServers` entry whose name is already in the user's config unless this
   * env var turns the filter off — so the ACP child gets it
   * (`lib/agents/process-manager.ts`), and the entry survives to become a
   * `thread/start` config override that codex deep-merges per server name.
   *
   * A canary, not a behaviour test: if a future codex-acp stops reading the
   * flag, libi's in-app Codex sessions silently lose their ACP entry — the very
   * bug the old `libi-app` name worked around. Skipped rather than failed when
   * the adapter isn't installed, since it is a devDependency libi also fetches
   * at runtime.
   */
  it("codex-acp still honours the config-filter escape hatch", () => {
    const bundle = path.join(
      process.cwd(),
      "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    );
    if (!fs.existsSync(bundle)) return;
    const src = fs.readFileSync(bundle, "utf-8");
    // The filter itself still exists…
    expect(src).toContain("shouldDeduplicateMcpConflicts");
    // …and this is still what disables it.
    expect(src).toContain(CODEX_ACP_DISABLE_MCP_FILTER_ENV);
  });
});

describe("the ACP child is spawned with the codex config filter disabled", () => {
  const spawnMock = vi.fn(() => ({
    on: vi.fn(),
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 4242,
  }));

  beforeEach(() => {
    spawnMock.mockClear();
    vi.doMock("child_process", () => ({ spawn: spawnMock }));
    vi.doMock("@/lib/agents/acp/agent-registry", () => ({
      getAgentConfig: () => ({ installed: true, command: "/fake/codex-acp", args: [] }),
    }));
    // Without a resolved CLI the process manager refuses to spawn (and a real
    // resolver would run a login shell), so pin a usable one.
    vi.doMock("@/lib/agents/cli/resolve", () => ({
      resolveAgentCli: async () => ({ path: "/u/bin/codex", realPath: "/u/bin/codex", execPath: "/u/bin/codex", version: "9.0.0", meetsMinimum: true }),
      isUsableCli: (r: { meetsMinimum?: boolean } | null) => !!r && r.meetsMinimum === true,
    }));
  });
  afterEach(() => {
    vi.doUnmock("child_process");
    vi.doUnmock("@/lib/agents/acp/agent-registry");
    vi.doUnmock("@/lib/agents/cli/resolve");
    vi.resetModules();
  });

  it("sets DISABLE_MCP_CONFIG_FILTERING=true", async () => {
    vi.resetModules();
    const { AgentProcessManager } = await import("@/lib/agents/process-manager");
    const pm = new AgentProcessManager();
    try {
      await pm.warmProcess("codex");
    } catch {
      // Post-spawn ACP wiring is irrelevant here — only the spawn env is.
    }
    expect(spawnMock).toHaveBeenCalled();
    const call = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(call[2].env[CODEX_ACP_DISABLE_MCP_FILTER_ENV]).toBe("true");
  });
});
