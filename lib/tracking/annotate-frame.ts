import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runFfmpeg, resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { getLibiStorageDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { storeFile } from "@/mcp/tools/file-tools";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * Some ffmpeg builds (e.g. minimal homebrew installs) ship without
 * `--enable-libfreetype`, which means the `drawtext` filter isn't available.
 * Detect once and skip labels when missing — boxes always render.
 */
let drawtextAvailableCache: boolean | null = null;
function isDrawtextAvailable(): boolean {
  if (drawtextAvailableCache !== null) return drawtextAvailableCache;
  try {
    const result = spawnSync(resolveFfmpegPath(), ["-hide_banner", "-filters"], {
      encoding: "utf8",
    });
    drawtextAvailableCache = /\bdrawtext\b/.test(result.stdout || "");
  } catch {
    drawtextAvailableCache = false;
  }
  return drawtextAvailableCache;
}

export interface AnnotateBox { x: number; y: number; w: number; h: number; label?: string; color?: string }

/**
 * Injection-safe color for the ffmpeg `-vf` string. `color` is interpolated
 * raw into a filtergraph (`drawbox=...:color=<c>@1.0`, `drawtext=...:fontcolor=<c>`),
 * so an unvalidated value containing filter metacharacters (`:`, `@`, `,`, `'`,
 * `\`, `=`, whitespace) could break out of the argument. Mirrors the allowlist
 * pattern of `cssColorToFfmpeg` (lib/export/backends/ffmpeg-overlay.ts): only a
 * hex color (`#RGB`..`#RRGGBBAA`), an `rgb()/rgba()` triple, or a plain
 * alphabetic ffmpeg color name is accepted — none of which can carry a
 * metacharacter. Anything else falls back to the default `"red"`. Not
 * attacker-reachable today (color is hardcoded upstream); latent-injection defense.
 */
export function safeAnnotateColor(color: string | undefined): string {
  const raw = (color ?? "").trim();
  // Hex color — metacharacter-free, pass through.
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw;
  // Plain alphabetic ffmpeg color name (e.g. "red", "cyan") — no metacharacters.
  if (/^[a-zA-Z]+$/.test(raw)) return raw.toLowerCase();
  // rgb()/hsl()/anything with filter metacharacters — do NOT interpolate raw
  // (commas would be read as filterchain separators); use the safe default.
  return "red";
}

/** Extract ONE frame at `time` from a video and draw red boxes over it.
 *  Stores the result as a global image file; returns its FileRecord. */
export async function annotateFrame(input: {
  sourceFile: FileRecord;
  time: number;
  boxes: AnnotateBox[];
  name: string;
}): Promise<FileRecord> {
  const src = path.isAbsolute(input.sourceFile.storagePath)
    ? input.sourceFile.storagePath
    : path.join(getLibiStorageDir(), input.sourceFile.storagePath);
  const safe = input.name.replace(/[^a-z0-9-]+/gi, "-");
  const tmp = path.join("/tmp", `${safe}-${randomUUID().slice(0, 8)}.jpg`);

  const draw = input.boxes
    .map((b) => {
      const c = safeAnnotateColor(b.color);
      const box = `drawbox=x=${Math.round(b.x)}:y=${Math.round(b.y)}:w=${Math.round(b.w)}:h=${Math.round(b.h)}:color=${c}@1.0:thickness=4`;
      const txt =
        b.label && isDrawtextAvailable()
          ? `,drawtext=text='${b.label.replace(/'/g, "")}':x=${Math.round(b.x)}:y=${Math.max(0, Math.round(b.y) - 24)}:fontcolor=${c}:fontsize=22`
          : "";
      return box + txt;
    })
    .join(",");

  const args = ["-y", "-ss", String(input.time), "-i", src, "-frames:v", "1", "-vf", draw, tmp];
  logger.info({ tag: "tracking-ground", op: "ground_annotate", time: input.time, boxes: input.boxes.length }, "annotate_frame_start");
  await runFfmpeg(args, { op: "ground_annotate" });

  const buffer = await fs.readFile(tmp);
  const stored = await storeFile({
    pieceId: null,
    filename: path.basename(tmp),
    buffer,
    contentType: "image/jpeg",
    name: input.name,
    description: `Grounded candidates for "${input.name}" @ ${input.time.toFixed(2)}s`,
  });
  await fs.unlink(tmp).catch(() => {});
  return stored;
}
