/**
 * The `export` job writes into the piece's exports folder and keeps its
 * `piece_exports` record current (spec 2026-09-29 §A1–A2). The chromium
 * backend is stubbed; a code overlay forces that branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import { pieceExports } from "@/lib/db/schema/sqlite";
import type { JobContext } from "@/lib/jobs/types";

const stub = vi.hoisted(() => ({ fail: null as Error | null, onRun: null as null | (() => void | Promise<void>) }));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  ensureChromium: vi.fn(async () => {}),
}));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    async run() {
      await stub.onRun?.();
      if (stub.fail) throw stub.fail;
      return { blob: new Blob([new Uint8Array([0, 1, 2])]), duration: 2 };
    }
  },
}));

import { exportRunner, renderExport, EXPORT_DELETED_MESSAGE, type ExportParams } from "@/lib/jobs/runners/export";
import { ExportScheduler } from "@/lib/export/scheduler";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { createExportRecord, deleteExportRecord, getExportRecord } from "@/lib/exports/store";

const PIECE = "p-runner-records";
const SETTINGS = { format: "mp4", codec: "avc", bitrate: 1_000_000, width: 320, height: 240, fps: 24 } as const;

function ctx(params: ExportParams, shouldCancel: () => boolean = () => false): JobContext<ExportParams> {
  return { jobId: "job-r", params, resumeState: null, reportProgress: () => {}, checkpoint: async () => {}, shouldCancel };
}
function params(extra: Partial<ExportParams> = {}): ExportParams {
  return { pieceId: PIECE, source: "draft", filename: "out", settings: { ...SETTINGS }, ...extra } as ExportParams;
}
function record(name = "out") {
  return createExportRecord({ pieceId: PIECE, name, source: "user", settings: { format: "mp4", codec: "avc", fps: 24, width: 320, height: 240 } });
}
const exportsDir = () => path.join(getLibiStorageDir(), PIECE, "exports");
const filesInExports = () => (fs.existsSync(exportsDir()) ? fs.readdirSync(exportsDir()) : []);

beforeEach(async () => {
  // The scheduler gates on the HOST's load average once an export is running. The "cancelled export
  // and a new export of the same name" tests start a second export from inside the first one's render,
  // so on a loaded machine (a full `npm test` run, a busy CI box) the second waited forever for a slot
  // the first held — a 5 s timeout, and the stalled slot queued later tests behind it. A scheduler
  // with a fixed, idle machine makes admission deterministic; a fresh one per test drops any held slot.
  globalThis.__libiExportScheduler = new ExportScheduler({
    snapshot: () => ({ cores: 8, totalMemBytes: 16 * 1024 ** 3, availMemBytes: 12 * 1024 ** 3, load1: 0 }),
    config: { hwSessionCap: 2, softwareFallbackSafe: false },
  });
  stub.fail = null;
  stub.onRun = null;
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: PIECE });
  const m = await loadManifest(PIECE);
  Object.assign(m, { width: 320, height: 240, fps: 24 });
  m.overlays = [
    { id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" },
  ] as typeof m.overlays;
  await saveManifest(PIECE, m);
});
afterEach(() => {
  cleanupTempDir();
  resetTestDb();
  resetStorage();
});

describe("export runner — the record and the piece's exports folder", () => {
  it("writes into <storage>/<piece>/exports and completes the record", async () => {
    const rec = record();
    const result = await exportRunner.run(ctx(params({ exportId: rec.id })));
    expect(result.filePath).toBe(path.join(exportsDir(), "out.mp4"));
    expect(fs.readFileSync(result.filePath)).toHaveLength(3);
    expect(getExportRecord(rec.id)).toMatchObject({
      status: "done", relPath: "exports/out.mp4", name: "out", jobId: "job-r", sizeBytes: 3,
      width: 320, height: 240, backend: "chromium-render", carriesCopyrighted: false,
    });
  });

  it("a file already there is kept: the claim suffixes and the record follows the file", async () => {
    fs.mkdirSync(exportsDir(), { recursive: true });
    fs.writeFileSync(path.join(exportsDir(), "out.mp4"), "someone else's");
    const rec = record();
    const result = await exportRunner.run(ctx(params({ exportId: rec.id })));
    expect(path.basename(result.filePath)).toBe("out-1.mp4");
    expect(getExportRecord(rec.id)).toMatchObject({ name: "out-1", relPath: "exports/out-1.mp4" });
  });

  it("a job enqueued without a record adopts one of its own", async () => {
    await exportRunner.run(ctx(params()));
    const rows = getDb().select().from(pieceExports).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "done", source: "agent", jobId: "job-r", name: "out" });
  });

  it("a render that fails marks the record failed and leaves no file", async () => {
    stub.fail = new Error("render exploded");
    const rec = record();
    await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow("render exploded");
    expect(getExportRecord(rec.id)).toMatchObject({ status: "failed", error: "render exploded" });
    expect(filesInExports()).toEqual([]);
  });

  it("a cancel mid-render marks the record cancelled", async () => {
    let cancelled = false;
    stub.onRun = () => {
      cancelled = true;
    };
    stub.fail = new Error("aborted");
    const rec = record();
    await expect(exportRunner.run(ctx(params({ exportId: rec.id }), () => cancelled))).rejects.toThrow();
    expect(getExportRecord(rec.id)?.status).toBe("cancelled");
  });

  it("a record deleted before the job ran fails the job and writes nothing", async () => {
    const rec = record();
    deleteExportRecord(rec.id);
    await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow(EXPORT_DELETED_MESSAGE);
    expect(filesInExports()).toEqual([]);
  });

  it("deleted while it rendered: the finished file is removed too", async () => {
    const rec = record();
    stub.onRun = () => {
      deleteExportRecord(rec.id);
    };
    const result = await exportRunner.run(ctx(params({ exportId: rec.id })));
    expect(fs.existsSync(result.filePath)).toBe(false);
  });

  // "Cancel, tweak a setting, Export again": removing a running export frees its name at once
  // (row and file go), the new export of the same name claims the same path, and the OLD runner
  // is still tearing down. Whatever it does next must not touch the new export's file.
  describe("a cancelled export's runner and a new export of the same name", () => {
    /** What `removeExport` does to a running export, then a full second export under the same name. */
    async function removeThenExportAgain(oldId: string): Promise<string> {
      deleteExportRecord(oldId);
      fs.rmSync(path.join(exportsDir(), "out.mp4"));
      const keep = { fail: stub.fail, onRun: stub.onRun };
      stub.fail = null;
      stub.onRun = null;
      const second = record("out");
      const result = await exportRunner.run(ctx(params({ exportId: second.id }), () => false));
      expect(path.basename(result.filePath)).toBe("out.mp4");
      stub.fail = keep.fail;
      stub.onRun = keep.onRun;
      return second.id;
    }

    it("the old runner's failure cleanup leaves the new export's file alone", async () => {
      const first = record("out");
      let secondId = "";
      let cancelled = false;
      stub.fail = new Error("aborted");
      stub.onRun = async () => {
        cancelled = true;
        secondId = await removeThenExportAgain(first.id);
      };
      await expect(exportRunner.run(ctx(params({ exportId: first.id }), () => cancelled))).rejects.toThrow("aborted");
      expect(fs.readFileSync(path.join(exportsDir(), "out.mp4"))).toHaveLength(3);
      expect(getExportRecord(secondId)).toMatchObject({ status: "done", relPath: "exports/out.mp4" });
      expect(filesInExports()).toEqual(["out.mp4"]);
    });

    it("an old render that still finishes never writes into, or removes, the new export's file", async () => {
      const first = record("out");
      let secondId = "";
      stub.onRun = async () => {
        secondId = await removeThenExportAgain(first.id);
      };
      // Not cancelled: the stub simply returns its bytes after the second export is done.
      await expect(exportRunner.run(ctx(params({ exportId: first.id })))).rejects.toThrow(EXPORT_DELETED_MESSAGE);
      expect(fs.readFileSync(path.join(exportsDir(), "out.mp4"))).toHaveLength(3);
      expect(getExportRecord(secondId)).toMatchObject({ status: "done" });
      expect(filesInExports()).toEqual(["out.mp4"]);
    });
  });

  // The claim's identity is device + inode of a placeholder descriptor the runner keeps OPEN for the
  // whole render. Birth time is not part of it (Linux without statx reports ctime in its place;
  // many filesystems keep none), and an open descriptor keeps its inode from being reused.
  describe("the claim holds its placeholder open", () => {
    /**
     * ONE ordered log of every `openSync` result and every `closeSync` in this realm. The kernel hands
     * out the lowest free descriptor number, so a number alone cannot name the claim: any other sync
     * open/close (Node's own readFileSync, leftover async work) reuses it. A claim is therefore an
     * exclusive create (`wx`) under the storage dir, and its lifetime is the window from its open to
     * the next open that returns the same number — closes are counted inside that window only.
     */
    function watchClaims() {
      type Entry = { op: "open"; fd: number; claim: boolean; dev: bigint; ino: bigint } | { op: "close"; fd: number };
      const log: Entry[] = [];
      const realOpen = fs.openSync;
      const realClose = fs.closeSync;
      const realFstat = fs.fstatSync;
      const storage = getLibiStorageDir();
      vi.spyOn(fs, "openSync").mockImplementation(((...a: Parameters<typeof fs.openSync>) => {
        const fd = realOpen(...a);
        const st = realFstat(fd, { bigint: true });
        log.push({ op: "open", fd, claim: a[1] === "wx" && String(a[0]).startsWith(storage), dev: st.dev, ino: st.ino });
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
        log.push({ op: "close", fd });
        return realClose(fd);
      }) as typeof fs.closeSync);
      /** Log indexes of the claims' opens. */
      const claims = () => log.flatMap((e, i) => (e.op === "open" && e.claim ? [i] : []));
      /** Closes of the descriptor opened at `i`, between that open and the next open returning the same number. */
      const closesOf = (i: number) => {
        const fd = log[i].fd;
        let n = 0;
        for (let j = i + 1; j < log.length; j++) {
          const e = log[j];
          if (e.fd !== fd) continue;
          if (e.op === "open") break;
          n++;
        }
        return n;
      };
      return { log, claims, closesOf };
    }
    afterEach(() => vi.restoreAllMocks());

    /** A stat where birth time is not known: `birthtimeNs` is whatever `birth()` says, and `ctimeNs` moves on every call. */
    function lieAboutTimes(birth: (ctime: bigint) => bigint) {
      const realStat = fs.statSync;
      const realFstat = fs.fstatSync;
      let tick = BigInt(1_000_000_000);
      const bent = (st: unknown) => {
        tick += BigInt(1_000_000);
        return Object.assign(st as object, { ctimeNs: tick, birthtimeNs: birth(tick) });
      };
      vi.spyOn(fs, "statSync").mockImplementation(((...a: unknown[]) =>
        bent((realStat as (...x: unknown[]) => unknown)(...a))) as typeof fs.statSync);
      vi.spyOn(fs, "fstatSync").mockImplementation(((...a: unknown[]) =>
        bent((realFstat as (...x: unknown[]) => unknown)(...a))) as typeof fs.fstatSync);
    }

    it("a statx-less stat (birth time = ctime, which ffmpeg's writes change) still removes the run's own partial", async () => {
      lieAboutTimes((ctime) => ctime);
      const rec = record();
      stub.onRun = () => {
        fs.writeFileSync(path.join(exportsDir(), "out.mp4"), "partial output");
      };
      stub.fail = new Error("render exploded");
      await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow("render exploded");
      expect(filesInExports()).toEqual([]);
    });

    it("a filesystem with no birth time (0) and a path that now names another file: the old runner leaves it alone", async () => {
      lieAboutTimes(() => BigInt(0));
      const rec = record();
      let oldIno = BigInt(0);
      let newIno = BigInt(0);
      stub.onRun = () => {
        const file = path.join(exportsDir(), "out.mp4");
        oldIno = fs.statSync(file, { bigint: true }).ino;
        fs.rmSync(file);
        fs.writeFileSync(file, "someone else's export");
        newIno = fs.statSync(file, { bigint: true }).ino;
      };
      stub.fail = new Error("aborted");
      await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow("aborted");
      // The held descriptor kept the old inode allocated, so the new file cannot have been given its number.
      expect(newIno).not.toBe(oldIno);
      expect(fs.readFileSync(path.join(exportsDir(), "out.mp4"), "utf8")).toBe("someone else's export");
    });

    it("the descriptor is open during the render and closed once after a success", async () => {
      const w = watchClaims();
      const rec = record();
      let during: { claims: number; closes: number; sameFile: boolean } | null = null;
      stub.onRun = () => {
        const [i] = w.claims();
        const open = w.log[i] as { fd: number; dev: bigint; ino: bigint };
        const onDisk = fs.statSync(path.join(exportsDir(), "out.mp4"), { bigint: true });
        during = { claims: w.claims().length, closes: w.closesOf(i), sameFile: open.dev === onDisk.dev && open.ino === onDisk.ino };
      };
      await exportRunner.run(ctx(params({ exportId: rec.id })));
      expect(during).toEqual({ claims: 1, closes: 0, sameFile: true });
      expect(w.claims()).toHaveLength(1);
      expect(w.closesOf(w.claims()[0])).toBe(1);
    });

    it("the descriptor is closed once after a failure", async () => {
      const w = watchClaims();
      stub.fail = new Error("render exploded");
      const rec = record();
      await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow("render exploded");
      expect(w.claims()).toHaveLength(1);
      expect(w.closesOf(w.claims()[0])).toBe(1);
    });

    it("the descriptor is closed once after a cancel", async () => {
      const w = watchClaims();
      let cancelled = false;
      stub.onRun = () => {
        cancelled = true;
      };
      stub.fail = new Error("aborted");
      const rec = record();
      await expect(exportRunner.run(ctx(params({ exportId: rec.id }), () => cancelled))).rejects.toThrow("aborted");
      expect(getExportRecord(rec.id)).toMatchObject({ status: "cancelled" });
      expect(w.claims()).toHaveLength(1);
      expect(w.closesOf(w.claims()[0])).toBe(1);
    });

    it("the descriptor is closed once when the render is deleted while it ran", async () => {
      const w = watchClaims();
      const rec = record();
      stub.onRun = () => {
        deleteExportRecord(rec.id);
      };
      await exportRunner.run(ctx(params({ exportId: rec.id })));
      expect(w.claims()).toHaveLength(1);
      expect(w.closesOf(w.claims()[0])).toBe(1);
    });

    it("a render with no record (a template example) releases its own claim", async () => {
      const w = watchClaims();
      const dir = path.join(getLibiStorageDir(), "example-work");
      const r = await renderExport(ctx(params()), { kind: "dir", dir });
      expect(fs.existsSync(r.filePath)).toBe(true);
      stub.fail = new Error("render exploded");
      await expect(renderExport(ctx(params()), { kind: "dir", dir })).rejects.toThrow("render exploded");
      expect(w.claims()).toHaveLength(2);
      for (const i of w.claims()) expect(w.closesOf(i)).toBe(1);
      expect(fs.readdirSync(dir)).toEqual(["out.mp4"]);
    });
  });

  it("a cancelled or failed run leaves its row without a path, and no file", async () => {
    stub.fail = new Error("render exploded");
    const rec = record();
    await expect(exportRunner.run(ctx(params({ exportId: rec.id })))).rejects.toThrow();
    expect(getExportRecord(rec.id)).toMatchObject({ status: "failed", relPath: null });
    expect(filesInExports()).toEqual([]);
  });
});
