/**
 * One-time boot migration (Export lead fix): regenerate the proxies that start
 * late. A proxy of a source whose streams all start after the file started at
 * its first packet, and the preview, which reads a proxy's source time 0 from
 * its first timestamp, played it that much early. Real ffmpeg makes the
 * proxies (the old command, and the new one); the regeneration itself is the
 * normal proxy_gen job path (JobManager, mocked here; regen-once.ts).
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
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
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { buildProxyArgs } from "@/lib/proxy/args";
import { sweepRegenLateStartProxies, STREAM_LEAD_SWEEP_MARKER } from "@/lib/proxy/regen-stream-lead";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

skipIf("sweepRegenLateStartProxies", () => {
  let tmp: string;
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-lead-sweep-"));
    process.env.LIBI_HOME = tmp;
    delete process.env.STORAGE_DIR;
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    jobs.enqueue.mockClear();
    jobs.runToCompletion.mockClear();
    seedPiece(db as never, { id: "p" });
    const dir = path.join(tmp, "storage", "p");
    fs.mkdirSync(dir, { recursive: true });
    // Both streams 0.4 s after the file's start (a subtitle first).
    fs.writeFileSync(path.join(dir, "s.srt"), "1\n00:00:00,600 --> 00:00:01,000\nhi\n");
    ff(["-itsoffset", "1", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=10:d=1", "-itsoffset", "1", "-f", "lavfi", "-i", "sine=d=1",
      "-i", path.join(dir, "s.srt"), "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "srt",
      path.join(dir, "late.mkv")]);
    // The proxy the old command made: it starts at its first packet.
    ff(["-i", path.join(dir, "late.mkv"), "-map", "0:V:0", "-map", "0:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "late-old-proxy.mp4")]);
    // The proxy the new command makes.
    execFileSync(resolveFfmpegPath(), ["-v", "error", ...buildProxyArgs(path.join(dir, "late.mkv"), path.join(dir, "late-new-proxy.mp4"), { fps: 10, videoLead: 0.4 })]);
    const row = (id: string, proxyFilename: string) =>
      db.insert(files).values({
        id, pieceId: "p", filename: "late.mkv", name: id, description: "", type: "video", storagePath: "p/late.mkv", size: 1,
        proxyFilename, proxyStatus: "ready",
      }).run();
    row("f-old", "late-old-proxy.mp4");
    row("f-new", "late-new-proxy.mp4");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("regenerates the proxy that starts late, and not one made by the new command", async () => {
    await sweepRegenLateStartProxies();
    expect(jobs.enqueue.mock.calls).toEqual([["proxy_gen", { fileId: "f-old" }, { pieceId: "p", fileId: "f-old", forceNew: true }]]);
    expect(jobs.runToCompletion).toHaveBeenCalledWith("job-f-old");
  });

  it("runs once: its marker stops it on the next boot", async () => {
    await sweepRegenLateStartProxies();
    expect(fs.existsSync(path.join(tmp, "state", STREAM_LEAD_SWEEP_MARKER))).toBe(true);
    jobs.enqueue.mockClear();
    jobs.runToCompletion.mockClear();
    await sweepRegenLateStartProxies();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("skips a proxy file that is missing", async () => {
    fs.rmSync(path.join(tmp, "storage", "p", "late-old-proxy.mp4"));
    await sweepRegenLateStartProxies();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
