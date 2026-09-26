/**
 * GET /api/files/by-id/[fileId]/timing with real ffprobe: the start time the
 * preview reads a file's source time 0 from (lib/engine/source-time-origin.ts),
 * and ffmpeg's first audio packet time, which differs from mediabunny's by a
 * Matroska track's CodecDelay. docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { files } from "@/lib/db/schema/sqlite";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

import { GET } from "@/app/api/files/by-id/[fileId]/timing/route";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

const PIECE = "p-timing";
const params = (fileId: string) => ({ params: Promise.resolve({ fileId }) });
const TONE = ["-f", "lavfi", "-i", "sine=f=440:sample_rate=44100:d=1"];

skipIf("GET /api/files/by-id/[fileId]/timing (real ffprobe)", () => {
  let storageDir: string;
  let prevStorageDir: string | undefined;
  beforeAll(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-timing-"));
    prevStorageDir = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = storageDir;
    const dir = path.join(storageDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    ff([...TONE, "-c:a", "libmp3lame", path.join(dir, "lame.mp3")]);
    ff([...TONE, "-c:a", "libmp3lame", path.join(dir, "mp3.mkv")]);
    ff([...TONE, "-c:a", "pcm_s16le", path.join(dir, "tone.wav")]);
    // trim_video's command (mcp/tools/ffmpeg-tools.ts): -ss/-to before -i, stream copy,
    // cutting between keyframes of a 2 s-GOP source.
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:sample_rate=44100:d=4",
      "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "src.mp4")]);
    ff(["-ss", "1.3", "-to", "3.3", "-i", path.join(dir, "src.mp4"), "-c", "copy", path.join(dir, "cut.mp4")]);
    // A browser-recording shape: the video from 0, the Opus track 0.4 s in (review round 3, R3-C1).
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=2", "-itsoffset", "0.4", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=1.5",
      "-map", "0:v", "-map", "1:a", "-c:v", "libvpx", "-c:a", "libopus", path.join(dir, "late-opus.webm")]);
    // An Ogg cut with -ss -c copy: ffmpeg starts it before 0 (R3-M4).
    ff(["-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=4", "-c:a", "libopus", path.join(dir, "full.ogg")]);
    ff(["-ss", "1.3", "-to", "3.3", "-i", path.join(dir, "full.ogg"), "-c", "copy", path.join(dir, "cut.ogg")]);
    // Two Opus encodes joined by stream copy (60 ms frames, then 20 ms): the
    // first's last frame is cut short at the join (review round 4).
    ff(["-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=1", "-c:a", "libopus", "-frame_duration", "60", path.join(dir, "seg1.webm")]);
    ff(["-f", "lavfi", "-i", "sine=f=660:sample_rate=48000:d=1", "-c:a", "libopus", "-frame_duration", "20", path.join(dir, "seg2.webm")]);
    fs.writeFileSync(path.join(dir, "join.txt"), "file 'seg1.webm'\nfile 'seg2.webm'\n");
    ff(["-f", "concat", "-safe", "0", "-i", path.join(dir, "join.txt"), "-c", "copy", path.join(dir, "joined.webm")]);
    fs.writeFileSync(path.join(dir, "junk.mp4"), "not media");
    for (const name of ["lame.mp3", "mp3.mkv", "tone.wav", "cut.mp4", "late-opus.webm", "cut.ogg", "joined.webm", "junk.mp4"]) {
      testDb.insert(files).values({
        id: name, pieceId: PIECE, filename: name, name, description: "", type: "audio", storagePath: `${PIECE}/${name}`, size: 1,
      }).run();
    }
  });
  afterAll(() => {
    if (prevStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = prevStorageDir;
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("a LAME MP3 starts at 0.025 s (the encoder delay ffmpeg skips)", async () => {
    const res = await GET(new Request("http://x"), params("lame.mp3"));
    const body = await res.json();
    expect(body.startTime).toBeCloseTo(1105 / 44100, 5);
    expect(body.audioCodecDelay).toBe(0);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("an MP3 in MKV: the track's CodecDelay (1105 samples) as ffmpeg subtracts it, in whole 1 ms ticks; the file starts at 0", async () => {
    const body = await (await GET(new Request("http://x"), params("mp3.mkv"))).json();
    expect(body.startTime).toBe(0);
    // 25.057 ms in the file; ffmpeg's demuxer rescales it to the track's 1 ms time base.
    expect(body.audioCodecDelay).toBe(0.025);
    // ...and exact, for the frame grid (review round 4, packet-grid.ts).
    expect(body.audioPadding).toBeCloseTo(1105 / 44100, 9);
    // ...and that is exactly how far ffmpeg moves the track: its first packet, stored at 0, reads -0.025.
    const firstPts = execFileSync(resolveFfprobePath(), [
      "-v", "error", "-select_streams", "a:0", "-read_intervals", "%+#1",
      "-show_entries", "packet=pts_time", "-of", "csv=p=0", path.join(storageDir, PIECE, "mp3.mkv"),
    ]).toString().trim().split(/\s+/)[0];
    expect(parseFloat(firstPts)).toBe(-body.audioCodecDelay);
  });

  it("an MP4 stream-copied at a non-keyframe (what trim_video makes): no shift, whatever its first packets are (review C1)", async () => {
    const body = await (await GET(new Request("http://x"), params("cut.mp4"))).json();
    expect(body.startTime).toBe(0);
    expect(body.audioCodecDelay).toBe(0);
  });

  it("a WAV has no start time: the preview falls back to mediabunny's", async () => {
    const body = await (await GET(new Request("http://x"), params("tone.wav"))).json();
    expect(body.startTime).toBeNull();
  });

  it("an Opus track that starts after its file: audioStart is its lead (R3-C1)", async () => {
    const body = await (await GET(new Request("http://x"), params("late-opus.webm"))).json();
    expect(body.startTime).toBe(0);
    expect(body.audioStart).toBeCloseTo(0.4, 2);
    expect(body.oggFirstPacket).toBeNull();
  });

  it("an Ogg cut: ffmpeg starts it before 0, and says where its first packet is (R3-M4)", async () => {
    const body = await (await GET(new Request("http://x"), params("cut.ogg"))).json();
    expect(body.startTime).toBeLessThan(0);
    expect(body.audioStart).toBeCloseTo(0, 3);
    expect(body.oggFirstPacket).toBeCloseTo(-312 / 48000, 4); // the pre-skip before the first sample
    expect(body.oggFirstPacketDuration).toBeGreaterThan(0);
  });

  it("an Opus WebM joined from two encodes: the packet ffmpeg cuts short at the join (review round 4)", async () => {
    const body = await (await GET(new Request("http://x"), params("joined.webm"))).json();
    const file = path.join(storageDir, PIECE, "joined.webm");
    // ffprobe's own word for it: the packet at the join carries a DiscardPadding.
    const lines = execFileSync(resolveFfprobePath(), [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time:packet_side_data=discard_padding", "-of", "csv=p=0", file,
    ]).toString().trim().split("\n").map((l) => l.split(",").map(Number));
    const first = lines[0][0];
    const join = lines.find(([t, d]) => d > 0 && t > 0.5 && t < 1.5)!;
    expect(body.opusTrims).toContainEqual([+(join[0] - first).toFixed(6), join[1]]);
    expect(join[1]).toBeGreaterThan(0);
    expect(join[1]).toBeLessThan(2880);
    // Nothing else pays for the packet scan.
    expect((await (await GET(new Request("http://x"), params("mp3.mkv"))).json()).opusTrims).toEqual([]);
  });

  it("a probe that fails is not an answer: 503, so the preview asks again (review round 3)", async () => {
    const res = await GET(new Request("http://x"), params("junk.mp4"));
    expect(res.status).toBe(503);
  });

  it("404 for an unknown file", async () => {
    expect((await GET(new Request("http://x"), params("nope"))).status).toBe(404);
  });
});
