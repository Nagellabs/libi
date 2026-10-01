import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { isUnsafeStorageName } from "@/lib/storage/safe-name";
import { fileTiming, type FileTiming } from "@/lib/ffmpeg/file-timing";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

/** Probed timings, keyed by path + mtime + size so a replaced file is re-probed. */
const cache = new Map<string, FileTiming>();
const CACHE_MAX = 512;

/** One `fileTiming` probe in flight per key, so concurrent uncached requests
 *  for the same file (a fresh preview mounting several players at once) share
 *  one ffprobe read instead of each running it themselves. */
const inflight = new Map<string, ReturnType<typeof fileTiming>>();

/**
 * GET /api/files/by-id/[fileId]/timing →
 *   `{ startTime: number | null, audioCodecDelay: number, audioPadding: number, audioStart: number | null,
 *      oggFirstPacket: number | null, oggFirstPacketDuration: number,
 *      opusTrims: Array<[number, number]>, preferProxyAudio: boolean }`
 *
 * The original file's start on ffmpeg's timeline (ffprobe `format.start_time`):
 * source time 0 for the preview, as it already is for `-ss` and the export
 * mix. The preview can't work it out from mediabunny, which ignores the
 * encoder delay a gapless MP3 (LAME header, 0.025 s) or Apple AAC file
 * (iTunSMPB, 0.048 s) declares; ffmpeg skips it
 * (lib/engine/source-time-origin.ts). `null` when ffprobe reports none (WAV)
 * or can't read the file; the preview then falls back to mediabunny's own
 * first timestamp.
 *
 * `audioCodecDelay` is the primary audio track's Matroska CodecDelay (0
 * elsewhere): ffmpeg subtracts it from that track's timestamps and mediabunny
 * doesn't. It is read from the file's own metadata, never inferred from
 * first-packet times, which differ on a stream-copied MP4 cut for another
 * reason (review C1: mediabunny lists the pre-roll packets an edit list hides).
 *
 * `audioPadding` is that CodecDelay exact (ffprobe's `initial_padding`): the
 * preview puts AAC and MP3 runs on the exact frame grid (packet-grid.ts).
 *
 * `oggFirstPacketDuration` is that packet's length.
 *
 * `opusTrims` (Opus in Matroska only, else empty): the packets ffmpeg cuts
 * short by a DiscardPadding, as `[seconds after the stream's first packet,
 * samples]`. A stream joined from two encodes carries one at the join; the
 * preview trims the same samples (probe.ts `readOpusDiscards`, opus-seek.ts).
 *
 * `preferProxyAudio`: the preview should play the proxy's audio, because
 * mediabunny misreads this file's without failing: a chained Ogg (silence
 * after its first stream) or FLAC in Ogg (no track). lib/ffmpeg/audio-preview.ts.
 *
 * `audioStart` is the primary audio stream's start on the file's timeline,
 * unclamped (ffprobe's stream `start_time` minus `format.start_time`): where
 * its first decoded sample sits. The preview places an Opus track that starts
 * after its file (a browser recording: the video at 0, the Opus track 0.343 s
 * in). `oggFirstPacket` (Ogg only) is where the primary audio stream's first
 * packet is, from its granules: mediabunny reads an Ogg stream from its start
 * as if they began at 0 (review round 3, R3-C1 and R3-M4).
 *
 * A probe that fails (timeout, ffprobe missing) answers 503, so the preview
 * asks again later; a 200 is an answer, `null` fields included.
 *
 * Only a fileId goes in, and only a number comes out; no path is revealed.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  const [file] = getDb().select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
  if (isUnsafeStorageName(file.filename)) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  let filePath: string;
  let key: string;
  try {
    const storage = await getStorage();
    filePath = await storage.realPathForRead(file.pieceId, file.filename);
    const st = await stat(filePath);
    key = `${filePath}|${st.mtimeMs}|${st.size}`;
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  let timing = cache.get(key);
  if (timing === undefined) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = fileTiming(filePath).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const answer = await pending;
    // A failed probe (timeout, ffprobe missing) is not remembered, and not an
    // answer: the preview retries it (source-time-origin.ts).
    if (!answer) {
      return NextResponse.json({ error: "probe failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const { cacheable, ...body } = answer;
    timing = body;
    // An answer with a part that couldn't be read (an Opus file's trims that
    // timed out) is served, but not remembered: the next request reads it
    // again (review round 5, M5).
    if (cacheable) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, timing);
    }
  }
  return NextResponse.json(timing, { headers: { "Cache-Control": "no-store" } });
}
