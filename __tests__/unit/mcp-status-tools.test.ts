import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { mcpServers } from "@/lib/db/schema";
import { listBundledMcps, showMcpSettings } from "@/mcp/tools/mcp-status-tools";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

vi.mock("@/mcp/notify", () => ({
  notify: {
    navigateSettings: vi.fn(),
  },
}));

import { notify } from "@/mcp/notify";

/** The per-row shape listBundledMcps returns (mirrors its module-private
 *  `BundledMcpStatus`), narrowed from the loose `ToolResult.data` record. */
type BundledMcpEntry = {
  id: string;
  requiredEnvVars: string[];
  configuredEnvVars: string[];
  installStatus: string;
  serverStatus: string;
  serverError: string | null;
  serverLastChecked: number | null;
};

let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
  // Seed two bundled rows + one custom
  db.insert(mcpServers).values([
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      description: "stt + tts",
      npmUrl: null,
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
      id: "youtube-downloader",
      name: "YouTube Downloader",
      description: "yt-dlp",
      npmUrl: "https://www.npmjs.com/package/@kevinwatt/yt-dlp-mcp",
      type: "stdio",
      command: "npx",
      args: JSON.stringify(["@kevinwatt/yt-dlp-mcp"]),
      enabled: true,
      requireApproval: true,
      bundled: true,
      installStatus: "installed",
      envVars: null,
    },
    {
      id: "custom-1",
      name: "Custom",
      description: "user-added",
      npmUrl: null,
      type: "stdio",
      command: "node",
      args: JSON.stringify(["x.js"]),
      enabled: true,
      requireApproval: true,
      bundled: false,  // EXCLUDED from list_bundled_mcps
      installStatus: "installed",
      envVars: JSON.stringify({ FOO: "bar" }),
    },
  ]).run();
  vi.mocked(notify.navigateSettings).mockReset();
});

afterEach(() => resetTestDb());

describe("listBundledMcps", () => {
  it("returns only bundled rows", async () => {
    const result = await listBundledMcps({});
    expect(result.success).toBe(true);
    const data = result.data as { mcps: { id: string }[] };
    const ids = data.mcps.map((m) => m.id).sort();
    expect(ids).toEqual(["elevenlabs", "youtube-downloader"]);
  });

  it("merges def.requiredEnvVars with row.envVars and redacts values", async () => {
    const result = await listBundledMcps({});
    const elevenlabs = (result.data as { mcps: BundledMcpEntry[] }).mcps.find((m) => m.id === "elevenlabs")!;
    expect(elevenlabs.requiredEnvVars).toEqual(["ELEVENLABS_API_KEY"]);
    expect(elevenlabs.configuredEnvVars).toEqual([]);
    expect(elevenlabs.installStatus).toBe("needs_config");
    // Values must NEVER be in the output
    expect(JSON.stringify(elevenlabs)).not.toContain("secret");
  });

  it("lists configured env var NAMES (not values)", async () => {
    db.update(mcpServers)
      .set({ envVars: JSON.stringify({ ELEVENLABS_API_KEY: "sk_secret_value", EXTRA: "v" }) })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();
    const result = await listBundledMcps({});
    const elevenlabs = (result.data as { mcps: BundledMcpEntry[] }).mcps.find((m) => m.id === "elevenlabs")!;
    expect(elevenlabs.configuredEnvVars.sort()).toEqual(["ELEVENLABS_API_KEY", "EXTRA"]);
    // Values must NEVER be in the output
    expect(JSON.stringify(elevenlabs)).not.toContain("sk_secret_value");
  });

  it("includes serverStatus, serverError, and serverLastChecked fields", async () => {
    const testDate = new Date(1234567890000); // Unix ms timestamp
    db.update(mcpServers)
      .set({
        serverStatus: "down",
        serverError: "boom",
        serverLastChecked: testDate,
      })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();
    const result = await listBundledMcps({});
    expect(result.success).toBe(true);
    const elevenlabs = (result.data as { mcps: BundledMcpEntry[] }).mcps.find((m) => m.id === "elevenlabs")!;
    expect(elevenlabs.serverStatus).toBe("down");
    expect(elevenlabs.serverError).toBe("boom");
    expect(elevenlabs.serverLastChecked).toBe(1234567890); // unix seconds
  });

  it("returns null for serverLastChecked when not set", async () => {
    const result = await listBundledMcps({});
    const elevenlabs = (result.data as { mcps: BundledMcpEntry[] }).mcps.find((m) => m.id === "elevenlabs")!;
    expect(elevenlabs.serverLastChecked).toBeNull();
  });
});

describe("showMcpSettings", () => {
  it("notifies with the given mcpId", async () => {
    const result = await showMcpSettings({ mcpId: "elevenlabs" });
    expect(result.success).toBe(true);
    expect(notify.navigateSettings).toHaveBeenCalledWith({ mcpId: "elevenlabs" });
  });

  it("notifies with no mcpId when not provided", async () => {
    const result = await showMcpSettings({});
    expect(result.success).toBe(true);
    expect(notify.navigateSettings).toHaveBeenCalledWith({ mcpId: undefined });
  });
});
