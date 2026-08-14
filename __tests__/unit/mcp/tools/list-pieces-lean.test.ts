import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";

let db: ReturnType<typeof createTestDb>;
let openedId: string | null = null;

vi.mock("@/lib/db/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
  return { ...actual, getDb: () => db };
});

vi.mock("@/lib/editor-state", () => ({
  getOpenedPieceId: () => openedId,
}));

import { listPieces } from "@/mcp/tools/piece-discovery-tools";

function seedPiece(id: string, overrides: Record<string, unknown> = {}): void {
  db.insert(pieces)
    .values({
      id,
      name: `piece ${id}`,
      description: "d".repeat(1000),
      snapshotSummary: "x".repeat(1000),
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .run();
}

describe("listPieces leanness (F5)", () => {
  beforeEach(() => {
    db = createTestDb();
    openedId = null;
  });
  afterEach(() => {
    resetTestDb();
    vi.clearAllMocks();
  });

  it("truncates long text on listed pieces", async () => {
    seedPiece("p1");
    seedPiece("p2");

    const res = await listPieces({});
    expect(res.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listed = (res.data as any).pieces as any[];
    expect(listed).toHaveLength(2);

    for (const p of listed) {
      expect(p.description.length).toBeLessThanOrEqual(280);
      expect(p.snapshotSummary.length).toBeLessThanOrEqual(280);
      // Identity fields survive.
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
    }

    // The whole payload stays bounded.
    expect(JSON.stringify(res.data).length).toBeLessThan(2000);
  });

  it("also leans the openedPiece", async () => {
    seedPiece("opened");
    openedId = "opened";

    const res = await listPieces({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opened = (res.data as any).openedPiece;
    expect(opened).toBeTruthy();
    expect(opened.description.length).toBeLessThanOrEqual(280);
  });

  it("preserves null text fields without inventing a string", async () => {
    seedPiece("p1", { description: null, snapshotSummary: null });
    const res = await listPieces({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (res.data as any).pieces[0];
    expect(p.description).toBeNull();
    expect(p.snapshotSummary).toBeNull();
  });
});
