import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";

vi.mock("@/mcp/notify", () => ({
  notify: {
    refreshMcpConfig: vi.fn(),
  },
}));

const loggerInfoSpy = vi.fn();
vi.mock("@/lib/logger", () => ({
  mcpLogger: {
    info: (...args: unknown[]) => loggerInfoSpy(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  serverLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { notify } from "@/mcp/notify";
import {
  updateMcpServer,
  setMcpServerEnabled,
  removeMcpServer,
} from "@/mcp/tools/mcp-server-tools";

let db: ReturnType<typeof createTestDb>;

const BUNDLED_ID = "elevenlabs";
const CUSTOM_ID = "custom-1";

beforeEach(() => {
  db = createTestDb();
  db.insert(mcpServers)
    .values([
      {
        id: BUNDLED_ID,
        name: "ElevenLabs",
        description: "stt + tts",
        type: "stdio",
        command: "uvx",
        args: JSON.stringify(["elevenlabs-mcp"]),
        enabled: true,
        requireApproval: true,
        bundled: true,
        installStatus: "needs_config",
        envVars: null,
      },
      {
        id: CUSTOM_ID,
        name: "Custom",
        description: "user-added",
        type: "stdio",
        command: "node",
        args: JSON.stringify(["x.js"]),
        enabled: true,
        requireApproval: true,
        bundled: false,
        installStatus: "installed",
        envVars: JSON.stringify({ FOO: "bar" }),
      },
    ])
    .run();
  vi.mocked(notify.refreshMcpConfig).mockReset();
  loggerInfoSpy.mockReset();
});

afterEach(() => {
  resetTestDb();
});

describe("updateMcpServer", () => {
  it("applies a PATCH on a custom row and returns the subset", async () => {
    const result = await updateMcpServer({
      id: CUSTOM_ID,
      name: "Custom Renamed",
      command: "node",
      args: ["y.js", "--verbose"],
      envVars: { FOO: "baz", NEW: "value" },
      requireApproval: false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      id: CUSTOM_ID,
      name: "Custom Renamed",
      type: "stdio",
      enabled: true,
      requireApproval: false,
    });

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, CUSTOM_ID)).all();
    expect(row.name).toBe("Custom Renamed");
    expect(row.command).toBe("node");
    expect(JSON.parse(row.args!)).toEqual(["y.js", "--verbose"]);
    expect(JSON.parse(row.envVars!)).toEqual({ FOO: "baz", NEW: "value" });
    expect(row.requireApproval).toBe(false);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects restricted-field edits on a bundled row", async () => {
    const result = await updateMcpServer({
      id: BUNDLED_ID,
      name: "Hacked Name",
      command: "rm",
      args: ["-rf", "/"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("bundled MCP fields are read-only");
    expect(result.data).toMatchObject({
      id: BUNDLED_ID,
      rejectedFields: expect.arrayContaining(["name", "command", "args"]),
      editableFields: ["envVars", "requireApproval"],
    });

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, BUNDLED_ID)).all();
    expect(row.name).toBe("ElevenLabs");
    expect(row.command).toBe("uvx");
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });

  it("honors envVars + requireApproval edits on a bundled row", async () => {
    const result = await updateMcpServer({
      id: BUNDLED_ID,
      envVars: { ELEVENLABS_API_KEY: "sk_secret_value_xxx" },
      requireApproval: false,
    });

    expect(result.success).toBe(true);

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, BUNDLED_ID)).all();
    expect(JSON.parse(row.envVars!)).toEqual({ ELEVENLABS_API_KEY: "sk_secret_value_xxx" });
    expect(row.requireApproval).toBe(false);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when id is missing", async () => {
    const result = await updateMcpServer({ id: "does-not-exist", name: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("mcp server not found");
    expect(result.data).toEqual({ id: "does-not-exist" });
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });

  it("never logs envVar VALUES — only keys", async () => {
    const SECRET = "sk_live_super_secret_value_do_not_log";
    await updateMcpServer({
      id: BUNDLED_ID,
      envVars: { ELEVENLABS_API_KEY: SECRET, OTHER: "another_secret_value" },
    });

    const allLoggedJson = JSON.stringify(loggerInfoSpy.mock.calls);
    expect(allLoggedJson).not.toContain(SECRET);
    expect(allLoggedJson).not.toContain("another_secret_value");
    expect(allLoggedJson).toContain("ELEVENLABS_API_KEY");
    expect(allLoggedJson).toContain("OTHER");
  });
});

describe("setMcpServerEnabled", () => {
  it("disables a bundled row and persists the value", async () => {
    const result = await setMcpServerEnabled({ id: BUNDLED_ID, enabled: false });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: BUNDLED_ID, name: "ElevenLabs", enabled: false });

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, BUNDLED_ID)).all();
    expect(row.enabled).toBe(false);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("toggles a custom row", async () => {
    const result = await setMcpServerEnabled({ id: CUSTOM_ID, enabled: false });
    expect(result.success).toBe(true);

    const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, CUSTOM_ID)).all();
    expect(row.enabled).toBe(false);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when id is missing", async () => {
    const result = await setMcpServerEnabled({ id: "nope", enabled: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe("mcp server not found");
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });
});

describe("removeMcpServer", () => {
  it("deletes a custom row", async () => {
    const result = await removeMcpServer({ id: CUSTOM_ID });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: CUSTOM_ID, name: "Custom" });

    const rows = db.select().from(mcpServers).where(eq(mcpServers.id, CUSTOM_ID)).all();
    expect(rows).toHaveLength(0);
    expect(notify.refreshMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete a bundled row and preserves it", async () => {
    const result = await removeMcpServer({ id: BUNDLED_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "cannot delete bundled MCP; use libi.set_mcp_server_enabled to disable",
    );
    expect(result.data).toEqual({ id: BUNDLED_ID, name: "ElevenLabs" });

    const rows = db.select().from(mcpServers).where(eq(mcpServers.id, BUNDLED_ID)).all();
    expect(rows).toHaveLength(1);
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });

  it("returns a structured error when id is missing", async () => {
    const result = await removeMcpServer({ id: "nope" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("mcp server not found");
    expect(notify.refreshMcpConfig).not.toHaveBeenCalled();
  });
});
