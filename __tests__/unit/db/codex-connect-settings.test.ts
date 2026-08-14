import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { settings } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

vi.mock("@/lib/logger", () => {
  const noop = { info: () => {}, warn: () => {}, error: () => {} };
  const logger = { ...noop, child: () => logger };
  return { serverLogger: logger, mcpLogger: logger };
});

import {
  getCodexConnectSetting,
  setCodexConnectSetting,
} from "@/lib/db/settings";

describe("codex connect setting", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("returns default {connected:false, lastSyncStatus:'idle'} when unset", () => {
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("round-trips connected + status", () => {
    setCodexConnectSetting({ connected: true, lastSyncStatus: "ok" });
    expect(getCodexConnectSetting()).toEqual({
      connected: true,
      lastSyncStatus: "ok",
    });
  });

  it("overwrites a previously persisted value", () => {
    setCodexConnectSetting({ connected: true, lastSyncStatus: "ok" });
    setCodexConnectSetting({ connected: false, lastSyncStatus: "error" });
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "error",
    });
  });

  it("returns default on malformed JSON", () => {
    testDb.insert(settings).values({ id: 1, codex: "{not-valid" }).run();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("returns default when the JSON is the wrong shape", () => {
    testDb
      .insert(settings)
      .values({ id: 1, codex: JSON.stringify({ otherKey: true }) })
      .run();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("returns default when connected is not a boolean", () => {
    testDb
      .insert(settings)
      .values({ id: 1, codex: JSON.stringify({ connected: "yes", lastSyncStatus: "ok" }) })
      .run();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("returns default when lastSyncStatus is not a known enum value", () => {
    testDb
      .insert(settings)
      .values({ id: 1, codex: JSON.stringify({ connected: true, lastSyncStatus: "weird" }) })
      .run();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("returns default when stored JSON is null", () => {
    testDb.insert(settings).values({ id: 1, codex: "null" }).run();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("returns default and does not throw when the DB read fails", () => {
    // Simulate a DB-level failure (e.g. missing settings.codex column during
    // a partial/pending migration) — the read must degrade to defaults.
    testDb = {
      select: () => {
        throw new Error("no such column: codex");
      },
    } as unknown as ReturnType<typeof createTestDb>;

    expect(() => getCodexConnectSetting()).not.toThrow();
    expect(getCodexConnectSetting()).toEqual({
      connected: false,
      lastSyncStatus: "idle",
    });
  });

  it("does not clobber other settings columns when updating", () => {
    testDb.insert(settings).values({ id: 1, panelChatSize: 50 }).run();
    setCodexConnectSetting({ connected: true, lastSyncStatus: "ok" });
    const [row] = testDb
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1)
      .all();
    expect(row.panelChatSize).toBe(50);
    expect(row.codex).toBe(
      JSON.stringify({ connected: true, lastSyncStatus: "ok" }),
    );
  });
});
