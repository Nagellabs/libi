import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import {
  invalidateMcpConfig,
  getMcpServersForSettings,
  getMcpServersForAcp,
  onMcpConfigInvalidated,
} from "@/lib/mcp-config";

/**
 * Regression guard for the cross-module-instance staleness bug.
 *
 * Next.js builds lib/mcp-config's module graph more than once per process
 * (API route handlers vs the long-lived server runtime + SessionManager). When
 * the module's caches + invalidate callback lived in plain module-level
 * variables, an `invalidateMcpConfig()` from a route (Settings "add API key"
 * PATCH, agent retry/notify callback) cleared the WRONG instance's cache — the
 * SessionManager kept serving its frozen-at-startup MCP list, so a
 * newly-configured bundled MCP (ElevenLabs once its key was added) never
 * reached a new chat until a full server restart.
 *
 * The fix pins all three pieces of state to a single `globalThis` slot so every
 * module instance shares one cache + one callback (same pattern as
 * `globalForSM` / `globalForDrizzle`). These tests encode that contract.
 */

const GLOBAL_KEY = "__libiMcpConfig_v1";
const g = globalThis as unknown as Record<string, unknown>;

interface SharedState {
  cachedSettings: Record<string, unknown> | null;
  cachedAcpByAgent: Map<string, unknown[]>;
  onInvalidateCallback: ((opts: { reason: string }) => void) | null;
}

describe("mcp-config — globalThis-backed cache singleton", () => {
  beforeEach(() => {
    createTestDb();
    invalidateMcpConfig();
  });
  afterEach(() => {
    // Neutralize any callback this file registered so it can't fire during
    // another test file's invalidations sharing the same worker globalThis.
    onMcpConfigInvalidated(() => {});
    resetTestDb();
    invalidateMcpConfig();
  });

  it("stores cache state on globalThis under the stable singleton key", () => {
    getMcpServersForSettings();
    const state = g[GLOBAL_KEY] as SharedState | undefined;
    expect(state).toBeDefined();
    expect(state!.cachedSettings).not.toBeNull();
  });

  it("invalidateMcpConfig busts the globalThis-stored settings + ACP caches", () => {
    getMcpServersForSettings();
    getMcpServersForAcp("claude-code");
    const state = g[GLOBAL_KEY] as SharedState;
    const settingsBefore = state.cachedSettings;
    expect(settingsBefore).not.toBeNull();
    expect(state.cachedAcpByAgent.size).toBeGreaterThan(0);

    invalidateMcpConfig({ reason: "test" });

    // The ACP cache is cleared outright (nothing repopulates it during
    // invalidate — only a fresh getMcpServersForAcp() call would).
    expect(state.cachedAcpByAgent.size).toBe(0);
    // The settings cache is eagerly rebuilt by writeSettingsFile() during
    // invalidate — so it's non-null but a BRAND-NEW object (busted, not stale).
    expect(state.cachedSettings).not.toBeNull();
    expect(state.cachedSettings).not.toBe(settingsBefore);
  });

  it("a newly-configured MCP becomes visible to a fresh ACP build after invalidation (no stale cache)", () => {
    // Seed a bundled MCP that needs its API key — excluded from the build.
    getDb()
      .insert(mcpServers)
      .values({
        id: "elevenlabs",
        name: "ElevenLabs",
        description: "test",
        type: "stdio",
        command: "uvx",
        args: JSON.stringify(["elevenlabs-mcp"]),
        envVars: "{}",
        bundled: true,
        enabled: true,
        installStatus: "needs_config",
        serverStatus: "unknown",
        dependencyStatus: "[]",
      })
      .run();
    invalidateMcpConfig();

    const before = getMcpServersForAcp("claude-code");
    expect(before.find((s) => s.name === "ElevenLabs")).toBeUndefined();

    // User adds the key → row flips to installed + up (the Settings PATCH flow).
    getDb()
      .update(mcpServers)
      .set({
        installStatus: "installed",
        serverStatus: "up",
        envVars: JSON.stringify({ ELEVENLABS_API_KEY: "sk_test" }),
      })
      .where(eq(mcpServers.id, "elevenlabs"))
      .run();
    invalidateMcpConfig({ reason: "mcp-server-updated" });

    const after = getMcpServersForAcp("claude-code");
    expect(after.find((s) => s.name === "ElevenLabs")).toBeDefined();
  });

  it("the invalidate callback is stored on the shared global and fires on any invalidate", () => {
    let fired = 0;
    onMcpConfigInvalidated(() => {
      fired += 1;
    });
    invalidateMcpConfig({ reason: "test-cb" });
    expect(fired).toBe(1);
  });
});
