/**
 * Keep a long filter graph off the command line.
 *
 * Windows caps a whole command line at 32,767 characters (CreateProcess), and
 * the ffmpeg-overlay export puts one drawtext per caption line into
 * `-filter_complex`: 120 short captions measured 30.7k (QA 2026-09-18 recheck).
 * ffmpeg 7.0+ reads ANY option's value from a file when the option is spelled
 * `-/<name>`, so a long graph goes into a file instead. The older
 * `-filter_complex_script` is not an alternative: it is gone in the bundled
 * 9.0.1 ("Unrecognized option"). libi still accepts ffmpeg 6.1 (the drawtext
 * `y_align` capability check), which gets the inline form.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFfmpegPath } from "./exec";

const run = promisify(execFile);

/** Graphs up to this many characters stay inline — the common case, and what
 *  every log line and test has always seen. Far below the Windows limit. */
export const INLINE_GRAPH_MAX = 16_000;

const support = new Map<string, Promise<boolean>>();

/**
 * Does the resolved ffmpeg read `-/filter_complex <file>`? Probed by DOING it
 * on a trivial graph (a version string doesn't answer this: BtbN's master
 * builds report `N-<rev>`, not a release number). Cached per binary path, so
 * it spawns once per process; a failed probe answers false (inline form).
 */
export function supportsFilterFileOption(ffmpegPath = resolveFfmpegPath()): Promise<boolean> {
  let p = support.get(ffmpegPath);
  if (p) return p;
  p = (async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), "libi-ffprobe-graph-"));
      const file = path.join(dir, "graph.txt");
      await writeFile(file, "[0:v]null[v]");
      await run(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=16x16:d=0.04",
          "-/filter_complex", file, "-map", "[v]", "-f", "null", "-"],
        { timeout: 10_000, windowsHide: true },
      );
      return true;
    } catch {
      return false;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  support.set(ffmpegPath, p);
  return p;
}

/**
 * The argv for a filter graph: inline when it is short or the ffmpeg can't
 * read it from a file, else written to `<dir>/filter_complex.txt` and passed
 * as `-/filter_complex <file>`. The caller owns `dir` and removes it.
 */
export async function filterGraphArgs(graph: string, dir: string, supportsFile: boolean): Promise<string[]> {
  if (graph.length <= INLINE_GRAPH_MAX || !supportsFile) return ["-filter_complex", graph];
  const file = path.join(dir, "filter_complex.txt");
  await writeFile(file, graph, "utf-8");
  return ["-/filter_complex", file];
}
