/**
 * The export routes (spec 2026-09-29 §A3, §A6): list/get/content/location,
 * and the user-only rename and delete — browser-only, refused while a social
 * upload of the file is in flight, rename suffixing on collision and carrying
 * social post links to the new path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";

const mgr = vi.hoisted(() => ({ cancel: vi.fn(async () => {}) }));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => mgr }));

import { resetStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { jobs, pieceExports, socialPostLinks } from "@/lib/db/schema/sqlite";
import { createExportRecord, markExportDone, markExportRunning, setExportFile, getExportRecord } from "@/lib/exports/store";
import { exportsDirFor } from "@/lib/exports/paths";
import { GET as listGET } from "@/app/api/pieces/[pieceId]/exports/route";
import { GET as oneGET, PATCH, DELETE } from "@/app/api/exports/[exportId]/route";
import { GET as contentGET } from "@/app/api/exports/[exportId]/content/route";
import { GET as locationGET } from "@/app/api/exports/[exportId]/location/route";

const PIECE = "p-routes";
const HOST = "127.0.0.1:3465";
const CURL = { host: HOST, "content-type": "application/json" };
const BROWSER = { ...CURL, origin: `http://${HOST}`, "sec-fetch-site": "same-origin" };
const idParams = (exportId: string) => ({ params: Promise.resolve({ exportId }) });

async function doneExport(name: string, bytes = "0123456789"): Promise<{ id: string; abs: string }> {
  const row = createExportRecord({ pieceId: PIECE, name, source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
  const dir = await exportsDirFor(PIECE);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${name}.mp4`);
  fs.writeFileSync(abs, bytes);
  setExportFile(row.id, { name, relPath: `exports/${name}.mp4` });
  markExportDone(row.id, { sizeBytes: bytes.length, durationSeconds: 2, width: 1080, height: 1920, backend: "ffmpeg-overlay", audioDecision: { purpose: null, excludedFileIds: [], carriesCopyrighted: false } });
  return { id: row.id, abs };
}
const patch = (id: string, name: string, headers: Record<string, string> = BROWSER) =>
  PATCH(new Request(`http://${HOST}/api/exports/${id}`, { method: "PATCH", headers, body: JSON.stringify({ name }) }), idParams(id));
const del = (id: string, headers: Record<string, string> = BROWSER) =>
  DELETE(new Request(`http://${HOST}/api/exports/${id}`, { method: "DELETE", headers }), idParams(id));

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: PIECE, name: "Piece" });
  mgr.cancel.mockClear();
});
afterEach(() => {
  cleanupTempDir();
  resetTestDb();
  resetStorage();
});

describe("reads", () => {
  it("lists a piece's exports with path and missing flags; 404 for an unknown piece", async () => {
    const a = await doneExport("A");
    const b = await doneExport("B");
    fs.rmSync(b.abs);
    const res = await listGET(new Request(`http://${HOST}/api/pieces/${PIECE}/exports`), { params: Promise.resolve({ pieceId: PIECE }) });
    const { exports } = await res.json();
    expect(exports.map((e: { id: string; path: string; missing: boolean }) => [e.id, e.path, e.missing])).toEqual([
      [a.id, a.abs, false],
      [b.id, b.abs, true],
    ]);
    const unknown = await listGET(new Request(`http://${HOST}/api/pieces/nope/exports`), { params: Promise.resolve({ pieceId: "nope" }) });
    expect(unknown.status).toBe(404);
  });

  it("gets one export, 404 when gone", async () => {
    const a = await doneExport("A");
    expect((await (await oneGET(new Request(`http://${HOST}/api/exports/${a.id}`), idParams(a.id))).json()).export.name).toBe("A");
    expect((await oneGET(new Request(`http://${HOST}/api/exports/x`), idParams("x"))).status).toBe(404);
  });

  it("streams the file inline with Range support; 404 when the file is missing", async () => {
    const a = await doneExport("Summer promo");
    const full = await contentGET(new Request(`http://${HOST}/api/exports/${a.id}/content`), idParams(a.id));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("content-disposition")).toMatch(/^inline; filename="Summer promo\.mp4"/);
    const part = await contentGET(new Request(`http://${HOST}/api/exports/${a.id}/content`, { headers: { range: "bytes=0-3" } }), idParams(a.id));
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("0123");
    fs.rmSync(a.abs);
    expect((await contentGET(new Request(`http://${HOST}/api/exports/${a.id}/content`), idParams(a.id))).status).toBe(404);
  });

  it("answers the file's location like the asset location route", async () => {
    const a = await doneExport("A");
    expect(await (await locationGET(new Request(`http://${HOST}/api/exports/${a.id}/location`), idParams(a.id))).json()).toEqual({ path: a.abs, exists: true });
  });
});

describe("PATCH — rename", () => {
  it("is refused to a caller that is not libi's own page", async () => {
    const a = await doneExport("A");
    const res = await patch(a.id, "B", CURL);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "browser_only", code: "browser_only", message: expect.any(String) });
    expect(fs.existsSync(a.abs)).toBe(true);
  });

  it("renames the file and the row, suffixing on collision, and moves social links to the new path", async () => {
    const a = await doneExport("A");
    await doneExport("Promo");
    getDb().insert(socialPostLinks).values({ providerId: "zernio", providerPostId: "post-1", pieceId: PIECE, exportPath: a.abs, createdBy: "ui" }).run();
    const res = await patch(a.id, "Promo");
    expect(res.status).toBe(200);
    const view = (await res.json()).export;
    expect(view).toMatchObject({ name: "Promo-1", fileName: "Promo-1.mp4" });
    expect(fs.existsSync(a.abs)).toBe(false);
    expect(fs.existsSync(view.path)).toBe(true);
    expect(getDb().select().from(socialPostLinks).all()[0].exportPath).toBe(view.path);
  });

  it("refuses an unsafe name (400) and an export that is not done (409)", async () => {
    const a = await doneExport("A");
    expect((await patch(a.id, "a/b")).status).toBe(400);
    expect((await patch(a.id, "clip.")).status).toBe(400);
    const running = createExportRecord({ pieceId: PIECE, name: "R", source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
    markExportRunning(running.id, "job-r");
    expect((await patch(running.id, "S")).status).toBe(409);
  });

  it("is refused while a social upload of the file is in flight", async () => {
    const a = await doneExport("A");
    getDb().insert(jobs).values({ id: "up-1", kind: "social-upload", status: "running", paramsHash: "h", paramsJson: JSON.stringify({ providerId: "zernio", exportPath: a.abs, pieceId: PIECE, fileFingerprint: "1-1" }) }).run();
    const res = await patch(a.id, "B");
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/uploading to social/);
    expect(fs.existsSync(a.abs)).toBe(true);
  });
});

describe("DELETE", () => {
  it("is refused to a caller that is not libi's own page", async () => {
    const a = await doneExport("A");
    expect((await del(a.id, CURL)).status).toBe(403);
    expect(getExportRecord(a.id)).not.toBeNull();
  });

  it("removes the file and the row", async () => {
    const a = await doneExport("A");
    expect((await del(a.id)).status).toBe(200);
    expect(fs.existsSync(a.abs)).toBe(false);
    expect(getExportRecord(a.id)).toBeNull();
  });

  it("answers 200 when the file cannot be removed after the row is gone (EBUSY on Windows)", async () => {
    const a = await doneExport("A");
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });
    try {
      expect((await del(a.id)).status).toBe(200);
      expect(getExportRecord(a.id)).toBeNull();
    } finally {
      rm.mockRestore();
    }
  });

  it("cancels a running export's job first, then removes it", async () => {
    const r = createExportRecord({ pieceId: PIECE, name: "R", source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
    markExportRunning(r.id, "job-r");
    expect((await del(r.id)).status).toBe(200);
    expect(mgr.cancel).toHaveBeenCalledWith("job-r");
    expect(getDb().select().from(pieceExports).where(eq(pieceExports.id, r.id)).all()).toEqual([]);
  });

  it("is refused while a social upload of the file is in flight", async () => {
    const a = await doneExport("A");
    getDb().insert(jobs).values({ id: "up-1", kind: "social-upload", status: "queued", paramsHash: "h", paramsJson: JSON.stringify({ exportPath: a.abs }) }).run();
    expect((await del(a.id)).status).toBe(409);
    expect(fs.existsSync(a.abs)).toBe(true);
  });

  // A cancelled or failed row used to keep its relPath after the runner removed the partial,
  // and its name is free for reuse — so a later export can own that very path.
  it.each(["cancelled", "failed"] as const)("deleting a hidden %s row that still names a live export's path never deletes that file", async (status) => {
    const live = await doneExport("Promo", "the live one");
    const ghost = createExportRecord({ pieceId: PIECE, name: "Promo", source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
    getDb().update(pieceExports).set({ status, relPath: "exports/Promo.mp4" }).where(eq(pieceExports.id, ghost.id)).run();
    expect((await del(ghost.id)).status).toBe(200);
    expect(getExportRecord(ghost.id)).toBeNull();
    expect(fs.readFileSync(live.abs, "utf-8")).toBe("the live one");
    expect(getExportRecord(live.id)?.status).toBe("done");
  });

  it("a row that looks live but shares its path with another live row leaves the file for that row", async () => {
    const live = await doneExport("Promo", "the live one");
    const twin = createExportRecord({ pieceId: PIECE, name: "Promo", source: "user", settings: { format: "mp4", codec: "avc", fps: 30, width: 1080, height: 1920 } });
    getDb().update(pieceExports).set({ status: "done", relPath: "exports/Promo.mp4" }).where(eq(pieceExports.id, twin.id)).run();
    expect((await del(twin.id)).status).toBe(200);
    expect(fs.existsSync(live.abs)).toBe(true);
    // …and once the last row naming it goes, the file goes.
    expect((await del(live.id)).status).toBe(200);
    expect(fs.existsSync(live.abs)).toBe(false);
  });
});
