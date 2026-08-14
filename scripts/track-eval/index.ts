import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { getTrackRow, listTracksByFile } from "@/lib/tracking/repo";
import { readTrack } from "@/lib/tracking/storage";
import { summarizeTrack, APPEARANCE_TAU } from "@/lib/tracking/summary";
import { renderAnnotatedVideo } from "@/scripts/track-eval/render";

const pexec = promisify(execFile);
const PASS_VIS_THRESHOLD = 0.85; // <85% visible usually = tracking loss / wrong target

export interface TrackEvalArgs {
  fileId: string;
  trackId?: string;
  outDir: string;
  range?: { start: number; end: number };
  fps?: number;
  /** Validate the genuine product track→rect math instead of the independent drawer. */
  viaProductRender?: boolean;
  assert?: boolean;
}

export interface TrackEvalResult {
  videoPath: string;
  metricsPath: string;
}

export async function runTrackEval(args: TrackEvalArgs): Promise<TrackEvalResult> {
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, args.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) throw new Error(`file not found: ${args.fileId}`);
  if (!file.pieceId) throw new Error("file has no pieceId");

  let trackId = args.trackId;
  if (!trackId) {
    const rows = await listTracksByFile(db, args.fileId);
    if (rows.length === 0) throw new Error(`no tracks for file ${args.fileId}`);
    rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    trackId = rows[0].id;
  }
  const row = await getTrackRow(db, trackId);
  if (!row) throw new Error(`track row not found: ${trackId}`);

  const track = await readTrack(file.pieceId, trackId);
  if (!track) throw new Error(`track sidecar not found: ${trackId}`);

  const storage = await getStorage();
  const videoPath = storage.localPath(file.pieceId, file.filename);

  await mkdir(args.outDir, { recursive: true });
  const videoOut = join(args.outDir, `${trackId}.annotated.mp4`);
  const metricsOut = join(args.outDir, `${trackId}.metrics.json`);

  const summary = summarizeTrack(track, {
    frameW: (file as { mediaWidth?: number }).mediaWidth ?? 1,
    frameH: (file as { mediaHeight?: number }).mediaHeight ?? 1,
    clipDurationSec: (file as { mediaDuration?: number }).mediaDuration ?? Number.POSITIVE_INFINITY,
  });

  await renderAnnotatedVideo({ videoPath, track, outPath: videoOut, fps: args.fps, range: args.range, viaProductRender: args.viaProductRender });
  await writeFile(metricsOut, JSON.stringify({ trackId, fileId: args.fileId, method: track.method, ...summary }, null, 2));

  // Always extract a fixed spot-check grid (non-anchor seconds) for the
  // mandatory human/vision look. Frames or it didn't happen.
  const grid = [2, 6, 10, 14, 18, 22, 26, 30, 34, 37];
  for (const sec of grid) {
    // best-effort visual aid: a timestamp past the clip end just produces no frame
    await pexec("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-ss", String(sec), "-i", videoOut,
      "-frames:v", "1", "-y", join(args.outDir, `${trackId}.f${sec}s.png`),
    ]).catch(() => {});
  }

  if (args.assert) {
    // fraction of *sampled* frames where the object was visible
    const visFrac = summary.total > 0 ? summary.visible / summary.total : 0;
    const reasons: string[] = [];
    if (summary.flags.length > 0) reasons.push(`flags=[${summary.flags.join(",")}]`);
    if (visFrac < PASS_VIS_THRESHOLD) reasons.push(`visible fraction ${(visFrac * 100).toFixed(1)}% < ${(PASS_VIS_THRESHOLD * 100).toFixed(0)}%`);
    // Sustained-low-targetSim gate: a track can be 100%-visible with no
    // flags yet be confidently tracking the WRONG subject — the appearance
    // similarity to the anchored target stays below APPEARANCE_TAU for a
    // sustained run. summarizeTrack already flags the FIRST such window,
    // but assert must independently refuse ANY sustained low-sim run so a
    // calibrated-narrow τ produces an honest exit 2 instead of a silent
    // "looks fine". Window: ≥0.5s of contiguous visible samples whose
    // targetSim is present and < APPEARANCE_TAU.
    const samples = track.samples ?? [];
    const hasAppearance = samples.some((s) => s.targetSim != null);
    if (hasAppearance) {
      const assertAnchorTimes = [
        ...((track.manualAnchors ?? []).map((a) => a.time)),
        ...((track.agentAnchors ?? []).map((a) => a.time)),
      ];
      const ANCHOR_EPS = 0.05;
      const LOW_SIM_MIN_SEC = 0.5;
      let runStart: number | null = null;
      let prevT = 0;
      let worstSec = 0;
      let worstSim = 1;
      let lowSimReason: string | null = null;
      const flushRun = () => {
        if (
          runStart != null &&
          prevT - runStart >= LOW_SIM_MIN_SEC &&
          lowSimReason == null &&
          !assertAnchorTimes.some(
            (t) => t >= (runStart as number) - ANCHOR_EPS && t <= prevT + ANCHOR_EPS,
          )
        ) {
          lowSimReason =
            `sustained targetSim < APPEARANCE_TAU(${APPEARANCE_TAU}) ` +
            `over [${runStart.toFixed(2)},${prevT.toFixed(2)}]s ` +
            `(min ${worstSim.toFixed(3)} @ ${worstSec.toFixed(2)}s) — wrong-subject lock`;
        }
      };
      for (const s of samples) {
        const low =
          s.visible && s.targetSim != null && s.targetSim < APPEARANCE_TAU;
        if (low) {
          if (runStart == null) runStart = s.t;
          if ((s.targetSim ?? 1) < worstSim) {
            worstSim = s.targetSim ?? 1;
            worstSec = s.t;
          }
          prevT = s.t;
        } else if (runStart != null) {
          flushRun();
          if (lowSimReason != null) break;
          runStart = null;
        }
      }
      flushRun(); // catch a low-sim run that extends to the final sample
      if (lowSimReason != null) reasons.push(lowSimReason);
    }
    if (reasons.length > 0) {
      console.error(`VERDICT: FAIL — ${reasons.join("; ")}`);
      console.error(`Frames for visual confirmation: ${args.outDir}/${trackId}.f*.png`);
      process.exitCode = 2;
    } else {
      console.log(`VERDICT: machine-checks PASS (visible ${(visFrac * 100).toFixed(1)}%, no flags).`);
      console.log(`Now visually confirm the box is on the subject: ${args.outDir}/${trackId}.f*.png`);
    }
  }

  return { videoPath: videoOut, metricsPath: metricsOut };
}

// CLI: npm run track:eval -- --file <id> [--track <id>] [--range a-b] [--fps n] [--out dir]
if (process.argv[1] && process.argv[1].endsWith("track-eval/index.ts")) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const flag = (k: string) => process.argv.includes(`--${k}`);
  const file = arg("file");
  if (!file) { console.error("Usage: npm run track:eval -- --file <fileId> [--track <trackId>] [--range a-b] [--fps n] [--out dir] [--via-product-render] [--assert]"); process.exit(1); }
  const rangeRaw = arg("range");
  const range = rangeRaw ? { start: Number(rangeRaw.split("-")[0]), end: Number(rangeRaw.split("-")[1]) } : undefined;
  runTrackEval({
    fileId: file, trackId: arg("track"),
    outDir: arg("out") ?? "track-eval-out",
    range, fps: arg("fps") ? Number(arg("fps")) : undefined,
    viaProductRender: flag("via-product-render"),
    assert: flag("assert"),
  })
    .then((r) => { console.log("annotated:", r.videoPath, "\nmetrics:  ", r.metricsPath); })
    .catch((e) => { console.error(e); process.exit(1); });
}
