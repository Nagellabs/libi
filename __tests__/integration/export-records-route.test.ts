/**
 * POST /api/export creates the export's `piece_exports` record at enqueue and
 * hands its id to the job (spec 2026-09-29 §A1). The job itself is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

const enq = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; params: Record<string, unknown>; opts: Record<string, unknown> }>,
  next: 0,
}));
vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    enqueue: async (kind: string, params: Record<string, unknown>, opts: Record<string, unknown>) => {
      enq.calls.push({ kind, params, opts });
      enq.next += 1;
      return { status: "new", jobId: `job-${enq.next}` };
    },
    runToCompletion: async () => undefined,
  }),
}));
const tracked = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: (n: string, p: unknown) => tracked.push([n, p]) }));

import { getDb } from "@/lib/db/client";
import { pieceExports } from "@/lib/db/schema/sqlite";
import { resetStorage } from "@/lib/storage";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { POST } from "@/app/api/export/route";
import { DEST_FOLDER_REFUSAL } from "@/lib/exports/types";

const PIECE = "p-records-route";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://127.0.0.1:3000/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: PIECE, name: "Summer promo" });
  await saveManifest(PIECE, await loadManifest(PIECE));
  enq.calls.length = 0;
  enq.next = 0;
  tracked.length = 0;
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir();
  resetStorage();
});

describe("POST /api/export — the export record", () => {
  it("creates a queued record named after the piece and hands its id to the job", async () => {
    const res = await post({ pieceId: PIECE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exportId).toMatch(/^exp_/);
    expect(body.name).toBe("Summer promo");
    expect(body.destFolder).toBeUndefined();
    const rows = getDb().select().from(pieceExports).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.exportId, pieceId: PIECE, name: "Summer promo", status: "queued", jobId: "job-1", source: "agent", container: "mp4" });
    expect(enq.calls[0]).toMatchObject({
      kind: "export",
      params: { exportId: body.exportId, filename: "Summer promo" },
      opts: { forceNew: true, pieceId: PIECE },
    });
  });

  it("an export started from libi's own page is the user's", async () => {
    await post({ pieceId: PIECE }, { "sec-fetch-site": "same-origin" });
    expect(getDb().select().from(pieceExports).all()[0].source).toBe("user");
    expect(tracked).toContainEqual(["export_queued", { source: "user", variants: "1" }]);
  });

  it("a same-settings second export is a second record with its own name and its own job params", async () => {
    const a = await (await post({ pieceId: PIECE, filename: "Cut" })).json();
    const b = await (await post({ pieceId: PIECE, filename: "Cut" })).json();
    expect([a.name, b.name]).toEqual(["Cut", "Cut-1"]);
    expect(getDb().select().from(pieceExports).all()).toHaveLength(2);
    expect(enq.calls[0].params.exportId).not.toBe(enq.calls[1].params.exportId);
  });

  it("refuses destFolder with the hint, and records and queues nothing", async () => {
    const res = await post({ pieceId: PIECE, destFolder: "/tmp/elsewhere" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "dest_folder_removed", message: DEST_FOLDER_REFUSAL });
    expect(getDb().select().from(pieceExports).all()).toEqual([]);
    expect(enq.calls).toEqual([]);
  });

  it("buckets a batch for analytics", async () => {
    await post({ pieceId: PIECE, batchSize: 3 });
    await post({ pieceId: PIECE, batchSize: 7 });
    const buckets = tracked.filter(([n]) => n === "export_queued").map(([, p]) => (p as { variants: string }).variants);
    expect(buckets).toEqual(["2-3", "4+"]);
  });
});
