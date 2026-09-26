import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import {
  getMcpServersForAcp,
  invalidateMcpConfig,
  notifyMcpHttpReload,
  setTestModeFakesEnabled,
  TEST_MODE_FAKE_NAMES,
} from "@/lib/mcp-config";
import { findProvider } from "@/lib/providers/catalog";
import { setMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-handle";
import { getLibiAgentDir } from "@/lib/libi-home";
import type { McpHttpChildHandle } from "@/lib/server/lifecycle/mcp-http-child";
import { vi } from "vitest";
import { SURFACE_HEADER } from "@/lib/mcp/agent-surface";
import { sqliteBuildDirForChildren } from "@/lib/db/native-binding";

describe("getMcpServersForAcp", () => {
  // Claude Code's config is read in test mode (the fakes' aliases): a scratch one, never the developer's.
  let claudeDir: string;
  beforeEach(() => {
    createTestDb();
    fs.writeFileSync(path.join(process.env.LIBI_HOME!, "mcp-port"), "3999");
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-acp-claude-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
    invalidateMcpConfig({ reason: "test" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(claudeDir, { recursive: true, force: true });
    delete process.env.LIBI_TEST_MODE;
    delete process.env.LIBI_FAKE_FAL_CONFIG;
    for (const k of ["FAL_AI", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"]) delete process.env[k];
    setTestModeFakesEnabled(true); // process-level flag — reset it or later files inherit it
    invalidateMcpConfig({ reason: "test-cleanup" });
  });

  it("hands every agent exactly one HTTP entry in production", () => {
    const entries = getMcpServersForAcp("claude-code");
    expect(entries).toEqual([
      {
        type: "http",
        name: "libi",
        url: "http://127.0.0.1:3999/mcp?agent=claude",
        headers: [{ name: SURFACE_HEADER, value: "in-app" }],
      },
    ]);
  });

  describe("with a supervisor in this process", () => {
    const supervisor = (status: ReturnType<McpHttpChildHandle["status"]>): McpHttpChildHandle => ({
      port: 3501,
      advertisedPort: 3501,
      publishedPort: 3501,
      ownsHealthAnswer: () => true,
      stop: async () => {},
      restart: async () => {},
      status: () => status,
    });
    afterEach(() => {
      setMcpHttpChild(null);
      vi.unstubAllGlobals();
    });

    it("names this instance's own port while its endpoint gave up, not the mcp-port file or the default another instance may hold", () => {
      // The file says 3999 (see beforeEach): a guess, as far as this instance knows.
      setMcpHttpChild(supervisor("gave-up"));
      invalidateMcpConfig({ reason: "test" });
      expect((getMcpServersForAcp("claude-code")[0] as { url: string }).url).toBe(
        "http://127.0.0.1:3501/mcp?agent=claude",
      );
    });

    it("sends no reload while its endpoint is not running, and sends it to its own port once it is", () => {
      const fetchMock = vi.fn(async () => new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      setMcpHttpChild(supervisor("gave-up"));
      notifyMcpHttpReload("test");
      expect(fetchMock).not.toHaveBeenCalled();
      setMcpHttpChild(supervisor("running"));
      notifyMcpHttpReload("test");
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3501/reload", expect.anything());
    });
  });

  it("selects the codex dialect for codex", () => {
    expect((getMcpServersForAcp("codex")[0] as { url: string }).url).toMatch(/\?agent=codex$/);
  });

  it("adds the two stdio fakes under their real names in test mode", () => {
    process.env.LIBI_TEST_MODE = "1";
    invalidateMcpConfig({ reason: "test-mode-on" });
    const entries = getMcpServersForAcp("claude-code");
    expect(entries.map((e) => (e as { name: string }).name)).toEqual(["libi", "fal-ai", "elevenlabs"]);
    const fal = entries[1] as { command: string; args: string[] };
    expect(fal.args.some((a) => a.includes(path.join("mcp", "dev", "fake-fal")))).toBe(true);
    const el = entries[2] as { command: string; args: string[] };
    expect(el.args.some((a) => a.includes(path.join("mcp", "dev", "fake-elevenlabs")))).toBe(true);
  });

  /**
   * Test mode is zero-cost only if a fake REPLACES the user's real entry for its provider. Both adapters resolve an
   * ACP entry and a config entry of the same name in favour of the ACP one (Claude: `--mcp-config` beats config;
   * Codex in test mode reads a scoped CODEX_HOME under LIBI_HOME, never the user's `~/.codex` —
   * lib/codex-config/canonical.ts), and names are case-sensitive. The fake ElevenLabs used to ride as `ElevenLabs`
   * while the Providers tab adds the real hosted server as `elevenlabs`, with the SAME `creative_*` tool names: a
   * signed-in owner got both, and the agent could spend real credits in a test run.
   */
  it("attaches every fake under exactly the entry name the catalog's add command gives the real server", () => {
    process.env.LIBI_TEST_MODE = "1";
    process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:54321/mcp";
    try {
      invalidateMcpConfig({ reason: "test-mode-on" });
      const names = getMcpServersForAcp("claude-code").map((e) => (e as { name: string }).name);
      expect([...TEST_MODE_FAKE_NAMES]).toEqual(names.slice(1));
      const catalogName = (id: "fal" | "elevenlabs" | "zernio") => {
        const cmd = findProvider(id).commands!.claude.split(" ");
        return cmd[cmd.findIndex((w, i) => i > 2 && !w.startsWith("-") && cmd[i - 1] !== "--scope" && cmd[i - 1] !== "--transport")];
      };
      expect(TEST_MODE_FAKE_NAMES).toEqual([catalogName("fal"), catalogName("elevenlabs"), catalogName("zernio")]);
      // Exactly one ElevenLabs entry, whatever the casing: the fake.
      const el = getMcpServersForAcp("claude-code").filter((e) => /eleven/i.test((e as { name: string }).name));
      expect(el).toHaveLength(1);
      expect((el[0] as { args: string[] }).args.some((a) => a.includes(path.join("mcp", "dev", "fake-elevenlabs")))).toBe(true);
    } finally {
      delete process.env.LIBI_SOCIAL_MCP_URL;
    }
  });

  /**
   * The fake Zernio is the odd one out: an HTTP entry pointing at a listener
   * running in THIS process, not a stdio child. That is what lets the agent
   * and libi's own dashboard client observe one state — a draft the agent
   * makes has to show up in the piece's Posting tab, which two processes with
   * separate memory could never do.
   */
  describe("the fake zernio HTTP entry", () => {
    afterEach(() => {
      delete process.env.LIBI_SOCIAL_MCP_URL;
      invalidateMcpConfig({ reason: "test-cleanup" });
    });

    it("rides along as an http entry once the fake has a URL", () => {
      process.env.LIBI_TEST_MODE = "1";
      process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:54321/mcp";
      invalidateMcpConfig({ reason: "test-mode-on" });
      const entries = getMcpServersForAcp("claude-code");
      expect(entries.map((e) => (e as { name: string }).name)).toEqual(["libi", "fal-ai", "elevenlabs", "zernio"]);
      expect(entries[3]).toEqual({ type: "http", name: "zernio", url: "http://127.0.0.1:54321/mcp", headers: [] });
    });

    it("is simply absent while the fake has not bound a port yet", () => {
      process.env.LIBI_TEST_MODE = "1";
      invalidateMcpConfig({ reason: "test-mode-on" });
      expect(getMcpServersForAcp("claude-code").map((e) => (e as { name: string }).name)).toEqual(["libi", "fal-ai", "elevenlabs"]);
    });

    it("goes away with the other fakes when a scenario opts out", () => {
      process.env.LIBI_TEST_MODE = "1";
      process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:54321/mcp";
      setTestModeFakesEnabled(false);
      expect(getMcpServersForAcp("claude-code").map((e) => (e as { name: string }).name)).toEqual(["libi"]);
    });

    it("never appears outside test mode, even with a URL set", () => {
      process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:54321/mcp";
      invalidateMcpConfig({ reason: "test" });
      expect(getMcpServersForAcp("claude-code").map((e) => (e as { name: string }).name)).toEqual(["libi"]);
    });
  });

  // The ACP `McpServerStdio.env` is `Array<{ name, value }>`, and
  // claude-agent-acp does `Object.fromEntries(server.env.map(...))` on it — a
  // `Record` here (the shape the builders return) throws inside the adapter
  // at newSession and the fakes never spawn. LIBI_HOME must be among them:
  // codex-acp sanitizes the child env, and without it the fake wrote to the
  // wrong home.
  //
  // And the set must be MINIMAL: claude-agent-acp turns this env back into the
  // `--mcp-config` JSON on the Claude child's argv, so every name here is
  // visible in `ps`. The builders used to hand over the whole process env,
  // which put the developer's FAL_AI / ANTHROPIC_API_KEY / ELEVENLABS_API_KEY
  // on a command line in test mode.
  it("ships each fake's env as ACP name/value pairs — exactly the whitelist, never the process env", () => {
    process.env.LIBI_TEST_MODE = "1";
    process.env.FAL_AI = "secret";
    process.env.ANTHROPIC_API_KEY = "secret";
    process.env.ELEVENLABS_API_KEY = "secret";
    delete process.env.LIBI_FAKE_FAL_CONFIG;
    invalidateMcpConfig({ reason: "test-mode-on" });
    const [, fal, el] = getMcpServersForAcp("claude-code") as Array<{
      env: Array<{ name: string; value: string }>;
    }>;
    // The DB the fakes write to (storeFile) resolves its native binding through
    // this name when the server can see a build dir — a checkout always can.
    const binding = sqliteBuildDirForChildren();
    const whitelist = ["LIBI_HOME", "LIBI_TEST_MODE", "PATH", "HOME", ...(binding ? ["LIBI_SQLITE_BINDING_DIR"] : [])];
    for (const entry of [fal, el]) {
      expect(Array.isArray(entry.env)).toBe(true);
      expect(entry.env.map((e) => e.name).sort()).toEqual([...whitelist].sort());
      expect(entry.env).toContainEqual({ name: "LIBI_HOME", value: process.env.LIBI_HOME });
      expect(entry.env).toContainEqual({ name: "LIBI_TEST_MODE", value: "1" });
      const values = entry.env.map((e) => e.value);
      expect(values).not.toContain("secret");
    }
  });

  it("forwards LIBI_FAKE_FAL_CONFIG to the fal fake only, and only when set", () => {
    process.env.LIBI_TEST_MODE = "1";
    process.env.LIBI_FAKE_FAL_CONFIG = "/tmp/scenario.json";
    invalidateMcpConfig({ reason: "test-mode-on" });
    const [, fal, el] = getMcpServersForAcp("claude-code") as Array<{
      env: Array<{ name: string; value: string }>;
    }>;
    expect(fal.env).toContainEqual({ name: "LIBI_FAKE_FAL_CONFIG", value: "/tmp/scenario.json" });
    expect(el.env.map((e) => e.name)).not.toContain("LIBI_FAKE_FAL_CONFIG");
  });

  it("omits the fakes in test mode when they are opted out", () => {
    process.env.LIBI_TEST_MODE = "1";
    invalidateMcpConfig({ reason: "test-mode-on" });
    expect(getMcpServersForAcp("claude-code")).toHaveLength(3);

    // This is what POST /api/skill-eval/configure does for a scenario whose
    // frontmatter is `mcps: []` — the no-provider condition the provider gate
    // exists for. A regression here silently un-tests the gate.
    setTestModeFakesEnabled(false);
    const entries = getMcpServersForAcp("claude-code");
    expect(entries.map((e) => (e as { name: string }).name)).toEqual(["libi"]);

    // And it comes back, without needing a manual cache invalidation.
    setTestModeFakesEnabled(true);
    expect(getMcpServersForAcp("claude-code")).toHaveLength(3);
  });

  /**
   * Claude Code replaces a config entry with an ACP entry only under exactly the same name. A user's older
   * `ElevenLabs` (the capitalised local server libi once added), a `fal` entry, or a hosted ElevenLabs under their
   * own name kept their real servers beside the fakes, and a test run could spend real credits.
   */
  describe("the fakes under the other names a user's Claude entries have", () => {
    const writeClaude = (servers: Record<string, unknown>, project: Record<string, unknown> = {}) =>
      fs.writeFileSync(
        path.join(claudeDir, ".claude.json"),
        JSON.stringify({ mcpServers: servers, projects: { [getLibiAgentDir()]: { mcpServers: project } } }),
      );
    const names = () => getMcpServersForAcp("claude-code").map((e) => (e as { name: string }).name);

    it("attaches each fake again under every catalog spelling, in any case, and every url of its provider", () => {
      process.env.LIBI_TEST_MODE = "1";
      writeClaude(
        {
          ElevenLabs: { command: "uvx", args: ["elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "k" } },
          "my-voice": { type: "http", url: "https://api.us.elevenlabs.io/v1/mcp" },
          elevenlabs: { type: "http", url: "https://api.us.elevenlabs.io/v1/mcp" },
          other: { command: "node", args: ["x.js"] },
        },
        { fal: { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer k" } } },
      );
      invalidateMcpConfig({ reason: "test-mode-on" });
      expect(names()).toEqual(["libi", "fal-ai", "elevenlabs", "ElevenLabs", "my-voice", "fal"]);
      const byName = new Map(getMcpServersForAcp("claude-code").map((e) => [(e as { name: string }).name, e as { args: string[] }]));
      for (const alias of ["ElevenLabs", "my-voice"]) {
        expect(byName.get(alias)!.args.some((a) => a.includes(path.join("mcp", "dev", "fake-elevenlabs")))).toBe(true);
      }
      expect(byName.get("fal")!.args.some((a) => a.includes(path.join("mcp", "dev", "fake-fal")))).toBe(true);
    });

    it("reads the config afresh for each session, so an entry added since is covered without an invalidation", () => {
      process.env.LIBI_TEST_MODE = "1";
      invalidateMcpConfig({ reason: "test-mode-on" });
      expect(names()).toEqual(["libi", "fal-ai", "elevenlabs"]);
      writeClaude({ "Fal.AI": { type: "http", url: "https://mcp.fal.ai/mcp" } });
      expect(names()).toEqual(["libi", "fal-ai", "elevenlabs", "Fal.AI"]);
    });

    it("the fake zernio stands in under another zernio name too, once it has a URL", () => {
      process.env.LIBI_TEST_MODE = "1";
      writeClaude({ Zernio: { type: "http", url: "https://mcp.zernio.com/mcp" } });
      invalidateMcpConfig({ reason: "test-mode-on" });
      expect(names()).toEqual(["libi", "fal-ai", "elevenlabs"]);
      process.env.LIBI_SOCIAL_MCP_URL = "http://127.0.0.1:54321/mcp";
      try {
        invalidateMcpConfig({ reason: "fake-zernio-started" });
        expect(getMcpServersForAcp("claude-code").slice(-1)).toEqual([{ type: "http", name: "Zernio", url: "http://127.0.0.1:54321/mcp", headers: [] }]);
      } finally {
        delete process.env.LIBI_SOCIAL_MCP_URL;
      }
    });

    it("gives Codex no aliases, and nobody any outside test mode or with the fakes opted out", () => {
      writeClaude({ ElevenLabs: { command: "uvx", args: ["elevenlabs-mcp"] } });
      expect(names()).toEqual(["libi"]);
      process.env.LIBI_TEST_MODE = "1";
      invalidateMcpConfig({ reason: "test-mode-on" });
      expect(getMcpServersForAcp("codex").map((e) => (e as { name: string }).name)).toEqual(["libi", "fal-ai", "elevenlabs"]);
      setTestModeFakesEnabled(false);
      expect(names()).toEqual(["libi"]);
    });
  });

  it("never passes a DB-configured server over ACP", () => {
    // A leftover row from an older install must not reach a session.
    getDb().insert(mcpServers).values({
      id: "leftover", name: "Leftover", type: "stdio", command: "echo",
      args: "[]", bundled: false, installStatus: "installed", serverStatus: "up",
    }).run();
    invalidateMcpConfig({ reason: "row-added" });
    expect(getMcpServersForAcp("claude-code")).toHaveLength(1);
  });
});
