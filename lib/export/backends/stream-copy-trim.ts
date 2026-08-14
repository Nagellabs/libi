import fs from "fs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { baseTimeRange, keepsBaseAudio, resolveExportBase } from "../export-base";
import type { ExportBackend, ExportContext } from "../backend";
import type { ExportResult } from "@/lib/engine/types";

export class StreamCopyTrimBackend implements ExportBackend {
  name = "stream-copy-trim" as const;

  async run(ctx: ExportContext): Promise<ExportResult> {
    // The base is a legacy video SCENE or a base-shaped video OVERLAY — the
    // resolver is the single authority the classifier also reads.
    const base = resolveExportBase(ctx.composition);
    if (!base) {
      throw new Error("StreamCopyTrimBackend: composition has no resolvable base video");
    }
    const db = getDb();
    const [file] = db.select().from(files).where(eq(files.id, base.fileId)).limit(1).all();
    if (!file) throw new Error(`Source file not found: ${base.fileId}`);
    const storage = await getStorage();
    if (!(storage instanceof LocalFileStorage)) {
      throw new Error("StreamCopyTrimBackend requires local storage");
    }
    // ORIGINAL file only — never `file.proxyFilename`. Proxies are
    // alpha-stripped, resolution-reduced editor stand-ins.
    const srcPath = storage.localPath(file.pieceId, file.filename);

    // `trim` selects a SOURCE range; `duration` is the TIMELINE length. The
    // preview shows whichever is shorter, so the export must cut there too.
    const { start, end, duration } = baseTimeRange(base);

    if (!ctx.outputPath) {
      throw new Error("StreamCopyTrimBackend requires ctx.outputPath");
    }

    // Muting a base video REMOVES its inline audio clip, which leaves nothing
    // for the classifier's audio check to see — so without `-an` a `-c copy`
    // export would carry the source's audio track straight through and the
    // user's muted video would ship with sound. The passthrough case (an
    // enabled inline clip on the base) keeps its audio.
    const audioArgs = keepsBaseAudio(ctx.composition, base) ? [] : ["-an"];

    let ok = false;
    try {
      await runFfmpeg(
        [
          "-y",
          "-ss", String(start),
          "-to", String(end),
          "-i", srcPath,
          "-c", "copy",
          ...audioArgs,
          "-movflags", "+faststart",
          ctx.outputPath,
        ],
        {
          op: "export_stream_copy",
          context: { compositionId: ctx.composition.id, fileId: base.fileId },
          totalDurationSeconds: duration,
          onProgress: ctx.onProgress,
          signal: ctx.signal,
        },
      );

      if (ctx.signal?.aborted) throw new Error("export aborted");

      const data = fs.readFileSync(ctx.outputPath);
      ok = true;
      return {
        blob: new Blob([data], { type: `video/${ctx.settings.format}` }),
        duration,
        format: ctx.settings.format,
      };
    } finally {
      if (!ok) {
        try { fs.unlinkSync(ctx.outputPath); } catch { /* ignore */ }
      }
    }
  }
}
