import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: { pieceDefaults: string | null }[] = [];
const insertRun = vi.fn();

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ all: () => rows }) }),
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => ({ run: insertRun }) }),
    }),
  }),
}));

import { getPieceDefaults, setPieceDefaults } from "@/lib/db/settings";

beforeEach(() => {
  rows.length = 0;
  insertRun.mockClear();
});

describe("getPieceDefaults", () => {
  it("returns the stored ratio", () => {
    rows.push({ pieceDefaults: JSON.stringify({ aspectRatioId: "16:9" }) });
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "16:9" });
  });

  it("falls back to 9:16 when the row is missing", () => {
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "9:16" });
  });

  it("falls back when the column is empty", () => {
    rows.push({ pieceDefaults: null });
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "9:16" });
  });

  it("falls back on malformed JSON rather than throwing", () => {
    // A corrupt settings value must never take the editor down.
    rows.push({ pieceDefaults: "{not json" });
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "9:16" });
  });

  it("falls back when the stored id is not in the catalog", () => {
    // A ratio removed from the catalog in a later version would otherwise
    // yield dimensionsFor() === null and a piece created at 0x0.
    rows.push({ pieceDefaults: JSON.stringify({ aspectRatioId: "7:3" }) });
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "9:16" });
  });

  it("falls back when the JSON is valid but not an object", () => {
    rows.push({ pieceDefaults: '"16:9"' });
    expect(getPieceDefaults()).toEqual({ aspectRatioId: "9:16" });
  });
});

describe("setPieceDefaults", () => {
  it("upserts the singleton settings row", () => {
    setPieceDefaults({ aspectRatioId: "1:1" });
    expect(insertRun).toHaveBeenCalledTimes(1);
  });
});
