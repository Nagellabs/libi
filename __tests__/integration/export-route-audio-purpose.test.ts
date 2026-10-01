import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

const enq = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    enqueue: async (_kind: string, p: Record<string, unknown>) => {
      enq.calls.push(p);
      return { status: "new", jobId: "job-1" };
    },
    runToCompletion: async () => undefined,
  }),
}));
const tracked = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: (n: string, p: unknown) => tracked.push([n, p]) }));

import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { POST } from "@/app/api/export/route";

const PIECE = "p-purpose";
const post = (body: unknown) => POST(new Request("http://test/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/export — purpose", () => {
  let dest: string;
  beforeEach(async () => {
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE, name: "Piece" });
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-purpose-"));
    enq.calls.length = 0;
    tracked.length = 0;
    getDb().insert(files).values({ id: "song", pieceId: PIECE, filename: "song.mp3", name: "song.mp3", description: "", type: "audio", storagePath: `${PIECE}/song.mp3`, hasAudio: true, audioRights: JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" }) }).run();
    const m = await loadManifest(PIECE);
    m.audioClips = [{ id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest(PIECE, m);
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("refuses a piece with copyrighted music and no purpose, enqueuing nothing", async () => {
    const res = await post({ pieceId: PIECE });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("purpose_required");
    expect(body.message).toContain("This piece has copyrighted music (song.mp3)");
    expect(enq.calls).toEqual([]);
  });

  it("passes the purpose and switches to the runner and reports the decision", async () => {
    const res = await post({ pieceId: PIECE, purpose: "social", copyrightedAudio: "exclude", includeFileIds: [] });
    expect(res.status).toBe(200);
    expect((enq.calls[0].settings as Record<string, unknown>)).toMatchObject({ purpose: "social", copyrightedAudio: "exclude", includeFileIds: [] });
    expect(tracked).toContainEqual(["export_audio_decision", { purpose: "social", copyrighted: "exclude" }]);
  });

  it("needs no purpose when the piece has no copyrighted audio", async () => {
    const m = await loadManifest(PIECE);
    m.audioClips = [];
    await saveManifest(PIECE, m);
    expect((await post({ pieceId: PIECE })).status).toBe(200);
  });

  it("passes excludeFileIds to the runner, and refuses a malformed one", async () => {
    const ok = await post({ pieceId: PIECE, purpose: "social", excludeFileIds: ["song"] });
    expect(ok.status).toBe(200);
    expect(enq.calls[0].settings as Record<string, unknown>).toMatchObject({ excludeFileIds: ["song"] });
    const bad = await post({ pieceId: PIECE, purpose: "social", excludeFileIds: "song" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("excludeFileIds must be an array of strings");
  });
});
