import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { settings } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

import { getSettings, updateSettings } from "@/lib/db/settings";

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
