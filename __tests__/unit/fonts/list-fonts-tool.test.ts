import { describe, it, expect, afterEach } from "vitest";
import { listFonts } from "@/mcp/tools/font-tools";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

/** The shape `listFonts` puts on `ToolResult.data`, which is `unknown` there. */
interface ListFontsData {
  bundled: { family: string; weights: number[] }[];
  system: string[];
  systemTruncated: boolean;
  uploaded: { family: string; fileId: string }[];
  note: string;
}

/** Assert success and narrow `data` — keeps every assertion below type-checked
 *  rather than reaching through `unknown`. */
async function listFontsData(params: Parameters<typeof listFonts>[0]): Promise<ListFontsData> {
  const res = await listFonts(params);
  expect(res.success).toBe(true);
  expect(res.data).toBeDefined();
  return res.data as unknown as ListFontsData;
}

afterEach(() => {
  resetTestDb();
});

describe("libi.list_fonts", () => {
  it("reports every bundled family with its weights", async () => {
    createTestDb();
    const data = await listFontsData({});
    const families = data.bundled.map((b) => b.family);
    expect(families).toContain("Inter");
    expect(families).toContain("JetBrains Mono");
    const inter = data.bundled.find((b) => b.family === "Inter");
    expect(inter?.weights).toEqual([400, 600, 700, 800]);
  });

  it("caps the system list and flags it as non-portable", async () => {
    createTestDb();
    const data = await listFontsData({});
    expect(data.system.length).toBeLessThanOrEqual(40);
    expect(data.note).toMatch(/portab|platform/i);
    // The cap is only honest if the truncation is announced — an agent that
    // can't tell a capped list from a complete one will assume a font is
    // absent when it merely fell off the end.
    if (data.system.length === 40) {
      expect(data.systemTruncated).toBe(true);
    }
  });

  it("never lists a bundled family as a system font", async () => {
    createTestDb();
    const data = await listFontsData({});
    for (const family of data.bundled.map((b) => b.family)) {
      expect(data.system).not.toContain(family);
    }
  });

  it("returns uploaded fonts as an array even when there are none", async () => {
    createTestDb();
    const data = await listFontsData({});
    expect(Array.isArray(data.uploaded)).toBe(true);
  });
});
