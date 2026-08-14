import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { listSeenIds, markSeen, SEEN_RETENTION_MS } from "@/lib/announcements/seen-store";

describe("announcements seen-store", () => {
  beforeEach(() => {
    createTestDb();
  });
  afterEach(() => {
    resetTestDb();
  });

  it("starts empty and records marked ids", () => {
    expect(listSeenIds()).toEqual([]);
    markSeen(["a1", "a2"]);
    expect(listSeenIds().sort()).toEqual(["a1", "a2"]);
  });

  it("marking the same id twice is a no-op, not an error", () => {
    markSeen(["a1"]);
    markSeen(["a1", "a2"]);
    expect(listSeenIds().sort()).toEqual(["a1", "a2"]);
  });

  it("marking an empty list is a no-op", () => {
    markSeen([]);
    expect(listSeenIds()).toEqual([]);
  });

  it("prunes rows older than the retention window on write", () => {
    const past = new Date(Date.now() - SEEN_RETENTION_MS - 1000);
    markSeen(["old"], past);
    markSeen(["new"]);
    expect(listSeenIds()).toEqual(["new"]);
  });
});
