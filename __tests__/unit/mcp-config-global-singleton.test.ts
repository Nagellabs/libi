import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import {
  invalidateMcpConfig,
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
    getMcpServersForAcp("claude-code");
    const state = g[GLOBAL_KEY] as SharedState | undefined;
    expect(state).toBeDefined();
    expect(state!.cachedAcpByAgent.size).toBeGreaterThan(0);
  });

  // `getMcpServersForSettings` (and with it `cachedSettings`) was deleted,
  // so the ACP cache is the whole of what invalidate has to bust.
  it("invalidateMcpConfig busts the globalThis-stored ACP cache", () => {
    const before = getMcpServersForAcp("claude-code");
    const state = g[GLOBAL_KEY] as SharedState;
    expect(state.cachedAcpByAgent.size).toBeGreaterThan(0);

    invalidateMcpConfig({ reason: "test" });

    // Cleared outright — nothing repopulates it during invalidate; only a
    // fresh getMcpServersForAcp() call does.
    expect(state.cachedAcpByAgent.size).toBe(0);

    // …and that call rebuilds it as a BRAND-NEW array (busted, not stale).
    const after = getMcpServersForAcp("claude-code");
    expect(state.cachedAcpByAgent.size).toBe(1);
    expect(after).not.toBe(before);
  });

  it("the invalidate callback is stored on the shared global and fires on any invalidate", () => {
    let fired = 0;
    onMcpConfigInvalidated(() => {
      fired += 1;
    });
    invalidateMcpConfig({ reason: "test-cb" });
    expect(fired).toBe(1);
  });

  it("lib/mcp-config.ts no longer reaches the Codex config writer", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/mcp-config.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/codex-config\//);
    expect(src).not.toMatch(/syncCodexGlobalMcpsIfConnected/);
  });
});
