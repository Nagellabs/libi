import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { proxyLogger as logger } from "@/lib/logger";
import { getLibiStorageDir } from "@/lib/libi-home";
import { resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { runOnceSweep } from "@/lib/proxy/regen-once";

const exec = promisify(execFile);

/**
 * One-time startup migration: regenerate the proxies that start late.
 *
 * A proxy of a source whose streams all start after the file (a subtitle
 * first, a stream cut) started at its first stream's first packet, not at 0.
 * The preview reads a proxy's source time 0 from its first timestamp, so it
 * played such a proxy that much early (0.38 s on a file whose audio and video
 * start 0.4 s in). Proxies made since keep the source's leads and start at 0
 * (lib/proxy/args.ts). docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 * (Export lead fix)
 *
 * Which proxies: a `ready` one whose own `format.start_time` is past 1 ms, one
 * ffprobe of the proxy's header each. The regeneration goes through the
 * normal `proxy_gen` job path; the marker under LIBI_HOME is written once
 * every one has finished (regen-once.ts), and stops it on the next boot.
 *
 * **Next.js process only** (uses the in-process JobManager).
 */
export const STREAM_LEAD_SWEEP_MARKER = "proxy-sweep-stream-lead-v1";

/** A proxy starting later than this starts late. */
const LATE_S = 0.001;

async function proxyStart(proxyPath: string): Promise<number | null> {
  try {
    const { stdout } = await exec(
      resolveFfprobePath(),
      ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", proxyPath],
      { timeout: 15_000, windowsHide: true },
    );
    const start = parseFloat(stdout.trim());
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

export async function sweepRegenLateStartProxies(): Promise<void> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn({ tag: "proxy", op: "sweep_regen_stream_lead_db_unavailable", err }, "proxy.sweep_regen_stream_lead.db_unavailable");
    return;
  }
  // Waits for every regeneration before writing the marker, one writer per
  // file (regen-once.ts). A sweep resumed after a quit re-probes: a proxy
  // regenerated meanwhile starts at 0 and is skipped.
  await runOnceSweep(STREAM_LEAD_SWEEP_MARKER, "sweep_regen_stream_lead", async () => {
    const rows = db
      .select()
      .from(files)
      .where(and(eq(files.proxyStatus, "ready"), isNotNull(files.proxyFilename)))
      .all();
    const late: Array<{ id: string; pieceId: string | null }> = [];
    for (const row of rows) {
      const proxyPath = path.join(getLibiStorageDir(), row.pieceId ?? "_global", row.proxyFilename!);
      if (!fs.existsSync(proxyPath)) continue;
      const start = await proxyStart(proxyPath);
      if (start !== null && start > LATE_S) late.push({ id: row.id, pieceId: row.pieceId });
    }
    return late;
  });
}
