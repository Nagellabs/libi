/**
 * One-time boot migration (review round 2, M5): regenerate the proxies of MKVs
 * whose primary stream the server now chooses differently, because it passes
 * over the Matroska tracks mediabunny drops (1cb10147). A proxy made before
 * that carries the old choice while the preview and the export play the new
 * one. Real ffmpeg makes the files; the regeneration itself is the normal
 * proxy_gen job path (JobManager, mocked here; regen-once.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
// The regeneration runs through JobManager (lib/proxy/regen-once.ts).
const jobs = vi.hoisted(() => ({
  enqueue: vi.fn(async (_kind: string, params: { fileId: string }) => ({ status: "new", jobId: `job-${params.fileId}` })),
  runToCompletion: vi.fn(async () => ({})),
}));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobs }));
vi.mock("@/lib/jobs/repo", () => ({ findRunningByHash: vi.fn(async () => null) }));

import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { sweepRegenMkvStreamProxies, MKV_STREAMS_SWEEP_MARKER } from "@/lib/proxy/regen-mkv-streams";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });
const V = ["-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=1"];
const A = (f: number) => ["-f", "lavfi", "-i", `sine=f=${f}:sample_rate=44100:d=1`];

skipIf("sweepRegenMkvStreamProxies", () => {
  let tmp: string;
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mkv-sweep-"));
    process.env.LIBI_HOME = tmp;
    delete process.env.STORAGE_DIR;
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    jobs.enqueue.mockClear();
    jobs.runToCompletion.mockClear();
    seedPiece(db as never, { id: "p" });
    const dir = path.join(tmp, "storage", "p");
    fs.mkdirSync(dir, { recursive: true });
    // Two audio tracks, the first disabled: FlagLacing (9C 81 00) of the first
    // audio entry turned into FlagEnabled = 0 (B9 81 00), sizes unchanged.
    ff([...V, ...A(440), ...A(880), "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "disabled.mkv")]);
    const b = fs.readFileSync(path.join(dir, "disabled.mkv"));
    let at = -1;
    for (let i = 0; i < 2; i++) at = b.indexOf(Buffer.from([0x9c, 0x81, 0x00]), at + 1);
    Buffer.from([0xb9, 0x81, 0x00]).copy(b, at);
    fs.writeFileSync(path.join(dir, "disabled.mkv"), b);
    ff([...V, ...A(440), ...A(880), "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "plain.mkv")]);
    ff([...V, ...A(440), "-map", "0", "-map", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "plain.mp4")]);
    const row = (id: string, filename: string, proxyStatus: "ready" | "idle" = "ready") =>
      db.insert(files).values({
        id, pieceId: "p", filename, name: filename, description: "", type: "video", storagePath: `p/${filename}`, size: 1,
        proxyFilename: proxyStatus === "ready" ? `${filename}-proxy.mp4` : null, proxyStatus,
      }).run();
    row("f-disabled", "disabled.mkv");
    row("f-plain", "plain.mkv");
    row("f-mp4", "plain.mp4");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("regenerates only the MKV whose stream choice changed, through the proxy job path", async () => {
    await sweepRegenMkvStreamProxies();
    expect(jobs.enqueue.mock.calls).toEqual([["proxy_gen", { fileId: "f-disabled" }, { pieceId: "p", fileId: "f-disabled", forceNew: true }]]);
    expect(jobs.runToCompletion).toHaveBeenCalledWith("job-f-disabled");
  });

  it("runs once: its marker stops it on the next boot", async () => {
    await sweepRegenMkvStreamProxies();
    expect(fs.existsSync(path.join(tmp, "state", MKV_STREAMS_SWEEP_MARKER))).toBe(true);
    jobs.enqueue.mockClear();
    jobs.runToCompletion.mockClear();
    await sweepRegenMkvStreamProxies();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("leaves a file without a ready proxy alone", async () => {
    db.update(files).set({ proxyStatus: "idle", proxyFilename: null }).run();
    await sweepRegenMkvStreamProxies();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
