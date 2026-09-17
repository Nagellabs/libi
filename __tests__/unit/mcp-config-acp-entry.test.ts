import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import {
  getMcpServersForAcp,
  invalidateMcpConfig,
  notifyMcpHttpReload,
  setTestModeFakesEnabled,
} from "@/lib/mcp-config";
import { setMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-handle";
import type { McpHttpChildHandle } from "@/lib/server/lifecycle/mcp-http-child";
import { vi } from "vitest";
import { SURFACE_HEADER } from "@/lib/mcp/agent-surface";
import { sqliteBuildDirForChildren } from "@/lib/db/native-binding";

describe("getMcpServersForAcp", () => {
  beforeEach(() => {
    createTestDb();
    fs.writeFileSync(path.join(process.env.LIBI_HOME!, "mcp-port"), "3999");
    invalidateMcpConfig({ reason: "test" });
  });
  afterEach(() => {
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
    expect(entries.map((e) => (e as { name: string }).name)).toEqual(["libi", "fal-ai", "ElevenLabs"]);
    const fal = entries[1] as { command: string; args: string[] };
    expect(fal.args.some((a) => a.includes(path.join("mcp", "dev", "fake-fal")))).toBe(true);
    const el = entries[2] as { command: string; args: string[] };
    expect(el.args.some((a) => a.includes(path.join("mcp", "dev", "fake-elevenlabs")))).toBe(true);
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
