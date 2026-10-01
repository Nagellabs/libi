/**
 * The audio-preview boot sweep (lib/proxy/regen-audio-preview.ts) probes only
 * the audio files whose format the preview might not play itself (review
 * round 5, M4): the same extension rule storeFile uses
 * (`mayNeedAudioPreviewProxy`): an MP3 or FLAC file holds only its own
 * codec, which the preview plays (an ADTS .aac is probed since AUD-4: it may
 * be HE-AAC on a mono core). It used to probe every audio file without a
 * proxy: one ffprobe each for a library of thousands of generated MP3s.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

const probe = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/ffmpeg/probe", () => ({
  probeMedia: vi.fn(async (p: string) => {
    probe.calls.push(path.basename(p));
    return p.endsWith(".m4a") ? { hasAudio: true, audioCodec: "alac", formatName: "mov,mp4,m4a,3gp,3g2,mj2" } : { hasAudio: true, audioCodec: "mp3", formatName: "mp3" };
  }),
}));
const jobs = vi.hoisted(() => ({
  enqueue: vi.fn(async (_k: string, p: { fileId: string }) => ({ status: "new", jobId: `job-${p.fileId}` })),
  runToCompletion: vi.fn(async () => ({})),
}));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobs }));
vi.mock("@/lib/jobs/repo", () => ({ findRunningByHash: vi.fn(async () => null) }));

import { getDb } from "@/lib/db/client";
import { sweepAudioPreviewProxies } from "@/lib/proxy/regen-audio-preview";
import { mayNeedAudioPreviewProxy } from "@/lib/ffmpeg/audio-preview";
import { resetRegenOnceForTest } from "@/lib/proxy/regen-once";

describe("sweepAudioPreviewProxies", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-audio-sweep-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    probe.calls = [];
    jobs.enqueue.mockClear();
    resetRegenOnceForTest();
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
  });
  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the extension rule: MP3 and FLAC never need one, anything else may", () => {
    for (const n of ["a.mp3", "c.flac", "d.FLAC"]) expect(mayNeedAudioPreviewProxy(n)).toBe(false);
    // AUD-4: an ADTS .aac may be HE-AAC on a mono core (in-band SBR), which the preview can't decode.
    for (const n of ["a.m4a", "b.AAC", "b.ogg", "c.wav", "d.opus", "e.wma", "noext"]) expect(mayNeedAudioPreviewProxy(n)).toBe(true);
  });

  it("1000 MP3s and one ALAC .m4a: one probe, and only the ALAC file gets a proxy", async () => {
    const dir = path.join(tmp, "storage", "p1");
    fs.mkdirSync(dir, { recursive: true });
    const rows: Array<typeof files.$inferInsert> = [];
    for (let i = 0; i < 1000; i++) {
      const filename = `gen-${i}.mp3`;
      fs.writeFileSync(path.join(dir, filename), "x");
      rows.push({ id: `mp3-${i}`, pieceId: "p1", filename, name: filename, description: "", type: "audio", storagePath: `p1/${filename}` });
    }
    fs.writeFileSync(path.join(dir, "song.m4a"), "x");
    rows.push({ id: "alac", pieceId: "p1", filename: "song.m4a", name: "song.m4a", description: "", type: "audio", storagePath: "p1/song.m4a" });
    for (let i = 0; i < rows.length; i += 200) getDb().insert(files).values(rows.slice(i, i + 200)).run();

    await sweepAudioPreviewProxies();
    expect(probe.calls).toEqual(["song.m4a"]);
    expect(jobs.enqueue.mock.calls.map((c) => c[1])).toEqual([{ fileId: "alac" }]);
  });
});
