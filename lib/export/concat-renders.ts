import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "@/lib/ffmpeg/exec";

/**
 * Build the ffmpeg concat-demuxer list-file content for a set of chunk files.
 *
 * Each entry is `file '<absolute path>'`. Within the single-quoted form the
 * concat demuxer expects a literal single quote to be written as `'\''`
 * (close-quote, escaped-quote, re-open-quote) — so a path containing a quote
 * round-trips exactly. Pure (no IO) so it's unit-testable.
 */
export function buildConcatListContent(paths: string[]): string {
  return (
    paths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

/**
 * Losslessly join sequential chunk files via ffmpeg's concat demuxer
 * (`-c copy`, no re-encode). Each chunk was encoded starting at t=0 with a
 * keyframe at frame 0, so a stream-copy concat is frame-exact at the seams.
 *
 * A single path in → returned unchanged (no ffmpeg run). Otherwise writes a
 * list file in a fresh mkdtemp dir and returns the absolute path to the joined
 * output (also in that dir, so the caller's dir cleanup removes both).
 */
export async function concatRenderChunks(
  paths: string[],
  format: "mp4" | "webm",
): Promise<string> {
  if (paths.length === 0) {
    throw new Error("concatRenderChunks: no chunk paths provided");
  }
  if (paths.length === 1) return paths[0];

  const dir = await mkdtemp(join(tmpdir(), "libi-concat-"));
  const listPath = join(dir, "list.txt");
  await writeFile(listPath, buildConcatListContent(paths), "utf8");

  const ext = format === "webm" ? "webm" : "mp4";
  const outPath = join(dir, `concat.${ext}`);
  await runFfmpeg(
    ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
    { op: "export_render_concat", context: { chunks: paths.length, format } },
  );
  return outPath;
}
