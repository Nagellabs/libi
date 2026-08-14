import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig, writeSettingsFile } from "@/lib/mcp-config";

/**
 * RC-F Task 8: the EXTERNAL `--connect-agent` target dir must never receive a
 * plaintext secret. HTTP header secrets are written as `${VAR}` references and
 * stdio secret env values as `${KEY}` references; a `.gitignore` keeps the
 * agent-config files out of the user's git history.
 */
describe("writeSettingsFile — connect-agent target is secret-free", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetTestDb();
    invalidateMcpConfig();
    process.env = { ...originalEnv };
  });

  it("references env vars for HTTP headers and stdio env, writes no literal secret, and gitignores config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-connect-secret-"));
    process.env.LIBI_CONNECT_AGENT_DIR = tmp;
    process.env.FAL_KEY = "SENTINEL_SECRET_HTTP";
    createTestDb();

    // An HTTP MCP whose header references ${FAL_KEY} (fal.ai-style BYO).
    getDb()
      .insert(mcpServers)
      .values({
        id: "fal-ai",
        name: "fal-ai",
        description: "",
        type: "http",
        url: "https://mcp.fal.ai/mcp",
        headers: JSON.stringify({ Authorization: "Bearer ${FAL_KEY}" }),
        envVars: JSON.stringify({ FAL_KEY: "SENTINEL_SECRET_HTTP" }),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        serverStatus: "up",
        dependencyStatus: "[]",
      })
      .run();

    // A stdio MCP carrying a custom (not-in-process-env) secret.
    getDb()
      .insert(mcpServers)
      .values({
        id: "custom-secret",
        name: "custom-secret",
        description: "",
        type: "stdio",
        command: "my-bin",
        args: "[]",
        envVars: JSON.stringify({ MY_SECRET: "SENTINEL_SECRET_STDIO" }),
        bundled: false,
        enabled: true,
        installStatus: "installed",
        serverStatus: "up",
        dependencyStatus: "[]",
      })
      .run();

    invalidateMcpConfig();
    writeSettingsFile(tmp);

    const mcpJsonPath = path.join(tmp, ".mcp.json");
    const raw = fs.readFileSync(mcpJsonPath, "utf-8");

    // No plaintext secret value anywhere in the file bytes.
    expect(raw).not.toContain("SENTINEL_SECRET_HTTP");
    expect(raw).not.toContain("SENTINEL_SECRET_STDIO");

    const parsed = JSON.parse(raw);
    // HTTP header is the ${FAL_KEY} reference, not the substituted literal.
    expect(parsed.mcpServers["fal-ai"].headers.Authorization).toBe("Bearer ${FAL_KEY}");
    // stdio secret env is the ${MY_SECRET} reference.
    expect(parsed.mcpServers["custom-secret"].env.MY_SECRET).toBe("${MY_SECRET}");

    // .gitignore excludes the agent-config files.
    const gitignore = fs.readFileSync(path.join(tmp, ".gitignore"), "utf-8");
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain(".mcp.json");
    expect(lines).toContain(".claude/settings.local.json");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT reference-transform the internal ~/.libi/agent dir (keeps literal safe-env)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-internal-"));
    // No LIBI_CONNECT_AGENT_DIR set → tmp is treated as an internal target.
    delete process.env.LIBI_CONNECT_AGENT_DIR;
    process.env.ELEVENLABS_API_KEY = "SENTINEL_INTERNAL";
    createTestDb();

    getDb()
      .insert(mcpServers)
      .values({
        id: "elevenlabs",
        name: "ElevenLabs",
        description: "",
        type: "stdio",
        command: "el-bin",
        args: "[]",
        envVars: JSON.stringify({}),
        bundled: true,
        enabled: true,
        installStatus: "installed",
        serverStatus: "up",
        dependencyStatus: "[]",
      })
      .run();

    invalidateMcpConfig();
    writeSettingsFile(tmp);

    // Internal dir gets NO .gitignore (nothing user-committable lives there).
    expect(fs.existsSync(path.join(tmp, ".gitignore"))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
