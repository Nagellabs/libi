import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dup-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("pieceDupRunner", () => {
  it("clones a piece end-to-end through run()", async () => {
    const { pieceDupRunner } = await import("@/lib/jobs/runners/piece-dup");
    const { getStorage } = await import("@/lib/storage");
    const { saveManifest } = await import("@/lib/composition/persistence");
    const db = getDb();
    seedPiece(db as never, { id: "src" });
    const fileId = crypto.randomUUID();
    db.insert(files).values({
      id: fileId, pieceId: "src", filename: "a.mp4", name: "a", description: "",
      type: "video", storagePath: "src/a.mp4", size: 3,
    }).run();
    await (await getStorage()).save("src", "a.mp4", Buffer.from("vid"), "video/mp4");
    await saveManifest("src", { sceneOrder: [], width: 1920, height: 1080, fps: 30, scenes: [], audioClips: [], overlays: [] });
    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();

    const progress: number[] = [];
    await pieceDupRunner.run({
      jobId: "job1", params: { sourcePieceId: "src", newPieceId: "dst", source: "draft" },
      resumeState: null, reportProgress: (d) => progress.push(d),
      checkpoint: async () => {}, shouldCancel: () => false,
    });

    expect(db.select().from(files).where(eq(files.pieceId, "dst")).all()).toHaveLength(1);
  });

  it("paramsSchema rejects a missing newPieceId", async () => {
    const { pieceDupRunner } = await import("@/lib/jobs/runners/piece-dup");
    expect(pieceDupRunner.paramsSchema.safeParse({ sourcePieceId: "x", source: "draft" }).success).toBe(false);
  });
});
