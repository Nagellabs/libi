import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { settings } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

import {
  getNotificationsSetting,
  setNotificationsSetting,
} from "@/lib/db/settings";

describe("notifications setting", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("returns default {backgroundJobComplete:true} when unset", () => {
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("persists and re-reads the value", () => {
    setNotificationsSetting({ backgroundJobComplete: false });
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: false });
  });

  it("overwrites a previously persisted value", () => {
    setNotificationsSetting({ backgroundJobComplete: false });
    setNotificationsSetting({ backgroundJobComplete: true });
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("returns default on malformed JSON", () => {
    // Seed a row with garbage in the notifications column.
    testDb
      .insert(settings)
      .values({ id: 1, notifications: "{not-valid" })
      .run();
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("returns default when the JSON is the wrong shape", () => {
    testDb
      .insert(settings)
      .values({ id: 1, notifications: JSON.stringify({ otherKey: true }) })
      .run();
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("returns default when backgroundJobComplete is not a boolean", () => {
    testDb
      .insert(settings)
      .values({
        id: 1,
        notifications: JSON.stringify({ backgroundJobComplete: "yes" }),
      })
      .run();
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("returns default when stored JSON is null", () => {
    testDb
      .insert(settings)
      .values({ id: 1, notifications: "null" })
      .run();
    expect(getNotificationsSetting()).toEqual({ backgroundJobComplete: true });
  });

  it("upserts the settings row when none exists", () => {
    setNotificationsSetting({ backgroundJobComplete: false });
    const rows = testDb
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].notifications).toBe(
      JSON.stringify({ backgroundJobComplete: false }),
    );
  });

  it("does not clobber other settings columns when updating", () => {
    // Seed a row with a custom panelChatSize.
    testDb
      .insert(settings)
      .values({ id: 1, panelChatSize: 50 })
      .run();
    setNotificationsSetting({ backgroundJobComplete: false });
    const [row] = testDb
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1)
      .all();
    expect(row.panelChatSize).toBe(50);
    expect(row.notifications).toBe(
      JSON.stringify({ backgroundJobComplete: false }),
    );
  });
});
