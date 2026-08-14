import { describe, it, expect, beforeEach, vi } from "vitest";
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
  parseCrashReportSettings,
  getCrashReportSettings,
  setCrashReportSettings,
  crashReportsAllowed,
  type CrashReportSettings,
} from "@/lib/db/settings";

const DEFAULT: CrashReportSettings = { choice: "unset", decidedAt: null };

describe("crash report settings", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  describe("parseCrashReportSettings", () => {
    it("returns the default for null", () => {
      expect(parseCrashReportSettings(null)).toEqual(DEFAULT);
    });

    it("returns the default for malformed JSON", () => {
      expect(parseCrashReportSettings("{not-valid")).toEqual(DEFAULT);
    });

    it("returns the default for an unknown choice value", () => {
      expect(
        parseCrashReportSettings(JSON.stringify({ choice: "maybe", decidedAt: 123 })),
      ).toEqual(DEFAULT);
    });

    it("returns the default when the JSON is the wrong shape", () => {
      expect(parseCrashReportSettings(JSON.stringify({ otherKey: true }))).toEqual(DEFAULT);
    });

    it("returns the default when stored JSON is null", () => {
      expect(parseCrashReportSettings("null")).toEqual(DEFAULT);
    });

    it.each<CrashReportChoiceCase>([
      ["unset", null],
      ["on", 1000],
      ["off", 2000],
    ])("round-trips choice=%s", (choice, decidedAt) => {
      const raw = JSON.stringify({ choice, decidedAt });
      expect(parseCrashReportSettings(raw)).toEqual({ choice, decidedAt });
    });
  });

  describe("getCrashReportSettings / setCrashReportSettings", () => {
    it("returns the default when the column is null", () => {
      expect(getCrashReportSettings()).toEqual(DEFAULT);
    });

    it("round-trips each choice value with decidedAt", () => {
      setCrashReportSettings({ choice: "on", decidedAt: 1690000000000 });
      expect(getCrashReportSettings()).toEqual({ choice: "on", decidedAt: 1690000000000 });

      setCrashReportSettings({ choice: "off", decidedAt: 1690000001000 });
      expect(getCrashReportSettings()).toEqual({ choice: "off", decidedAt: 1690000001000 });

      setCrashReportSettings({ choice: "unset", decidedAt: null });
      expect(getCrashReportSettings()).toEqual({ choice: "unset", decidedAt: null });
    });

    it("setCrashReportSettings returns the persisted value", () => {
      const result = setCrashReportSettings({ choice: "on", decidedAt: 42 });
      expect(result).toEqual({ choice: "on", decidedAt: 42 });
    });

    it("returns the default on malformed JSON in the column", () => {
      testDb.insert(settings).values({ id: 1, crashReports: "{not-valid" }).run();
      expect(getCrashReportSettings()).toEqual(DEFAULT);
    });

    it("returns the default when the stored choice is unknown", () => {
      testDb
        .insert(settings)
        .values({ id: 1, crashReports: JSON.stringify({ choice: "weird", decidedAt: 1 }) })
        .run();
      expect(getCrashReportSettings()).toEqual(DEFAULT);
    });

    it("does not clobber other settings columns when updating", () => {
      testDb.insert(settings).values({ id: 1, panelChatSize: 55 }).run();
      setCrashReportSettings({ choice: "on", decidedAt: 5 });
      const [row] = testDb.select().from(settings).where(eq(settings.id, 1)).limit(1).all();
      expect(row.panelChatSize).toBe(55);
      expect(row.crashReports).toBe(JSON.stringify({ choice: "on", decidedAt: 5 }));
    });
  });

  describe("crashReportsAllowed", () => {
    it("is true for 'unset' (report by default until asked)", () => {
      expect(crashReportsAllowed({ choice: "unset", decidedAt: null })).toBe(true);
    });

    it("is true for 'on'", () => {
      expect(crashReportsAllowed({ choice: "on", decidedAt: 100 })).toBe(true);
    });

    it("is false for 'off'", () => {
      expect(crashReportsAllowed({ choice: "off", decidedAt: 100 })).toBe(false);
    });
  });
});

type CrashReportChoiceCase = [CrashReportSettings["choice"], number | null];
