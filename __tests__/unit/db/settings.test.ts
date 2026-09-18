import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { settings } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

import { getSettings, updateSettings, getExportDefaults, setExportDefaults } from "@/lib/db/settings";

describe("getSettings", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("returns defaults when no row exists", () => {
    const s = getSettings();
    expect(s.preferredAgent).toBeNull();
    expect(s.panelChatSize).toBe(40);
    expect(s.panelEditorSize).toBe(40);
    expect(s.panelResourcesSize).toBe(20);
    expect(s.panelChatVisible).toBe(true);
    expect(s.panelResourcesVisible).toBe(false);
  });

  it("auto-creates the row on first read", () => {
    getSettings();
    const rows = testDb.select().from(settings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("updates a single field", () => {
    updateSettings({ preferredAgent: "claude-code" });
    const s = getSettings();
    expect(s.preferredAgent).toBe("claude-code");
    // Other fields stay at defaults
    expect(s.panelChatSize).toBe(40);
  });

  it("updates multiple fields at once", () => {
    updateSettings({
      panelChatSize: 35,
      panelEditorSize: 45,
      panelResourcesSize: 20,
      panelChatVisible: false,
    });
    const s = getSettings();
    expect(s.panelChatSize).toBe(35);
    expect(s.panelEditorSize).toBe(45);
    expect(s.panelResourcesSize).toBe(20);
    expect(s.panelChatVisible).toBe(false);
    expect(s.panelResourcesVisible).toBe(false); // unchanged
  });

  it("overwrites previous values", () => {
    updateSettings({ preferredAgent: "claude-code" });
    updateSettings({ preferredAgent: "codex" });
    expect(getSettings().preferredAgent).toBe("codex");
  });

  it("can set preferredAgent to null", () => {
    updateSettings({ preferredAgent: "claude-code" });
    updateSettings({ preferredAgent: null });
    expect(getSettings().preferredAgent).toBeNull();
  });

  it("creates the row if it doesn't exist yet", () => {
    // Don't call getSettings first
    updateSettings({ panelChatSize: 50 });
    const rows = testDb.select().from(settings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].panelChatSize).toBe(50);
  });

  it("round-trips the onboarding fields", () => {
    const s0 = getSettings();
    expect(s0.agentEverConnected).toBe(false);
    expect(s0.onboardingPersona).toBeNull();

    // SQLite integer timestamps store seconds, not milliseconds — truncate to avoid sub-second mismatch
    const when = new Date(Math.floor(Date.now() / 1000) * 1000);
    updateSettings({
      onboardingPersona: "agency",
      personaSelectedAt: when,
      agentEverConnected: true,
    });

    const s1 = getSettings();
    expect(s1.onboardingPersona).toBe("agency");
    expect(s1.agentEverConnected).toBe(true);
    expect(s1.personaSelectedAt?.getTime()).toBe(when.getTime());
  });
});

describe("getExportDefaults / setExportDefaults", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it("falls back to source/4k when no row exists", () => {
    const d = getExportDefaults();
    expect(d.quality).toBe("source");
    expect(d.graphicsQuality).toBe("4k");
  });

  it("reads graphicsQuality:'4k' for legacy stored JSON that predates the field", () => {
    // Simulate a settings row written before graphicsQuality existed.
    setExportDefaults({
      folder: null,
      format: "mp4",
      quality: "1080p",
    } as unknown as Parameters<typeof setExportDefaults>[0]);
    const d = getExportDefaults();
    expect(d.quality).toBe("1080p");
    expect(d.graphicsQuality).toBe("4k");
  });

  it("round-trips an explicit graphicsQuality", () => {
    setExportDefaults({ folder: null, format: "webm", quality: "4k", graphicsQuality: "1440p" });
    const d = getExportDefaults();
    expect(d.graphicsQuality).toBe("1440p");
  });

  it("rejects a garbage stored graphicsQuality back to the '4k' fallback", () => {
    setExportDefaults({
      folder: null,
      format: "mp4",
      quality: "source",
      graphicsQuality: "8k",
    } as unknown as Parameters<typeof setExportDefaults>[0]);
    expect(getExportDefaults().graphicsQuality).toBe("4k");
  });
});
