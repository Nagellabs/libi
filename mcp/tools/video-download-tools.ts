import fs from "node:fs";
import path from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { runJobViaServer } from "@/mcp/jobs-client";
import { getLibiBinDir } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";
import { mcpLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type { DownloadVideoParams } from "./schemas";
import { reportToolProgress } from "./tool-progress";

export { YT_DLP_INSTALL_MB } from "@/lib/video-download/install-size";
import { YT_DLP_INSTALL_MB } from "@/lib/video-download/install-size";

/** The bundled def that owns this tool and carries its `uv` + `yt-dlp` deps. */
const EXTENSION_ID = "youtube-download";

/**
 * Keep only the single-video form of a YouTube URL.
 *
 * A URL carrying `&list=RD…`/`&start_radio=1` is a Radio/Mix — an effectively
 * endless auto-playlist. yt-dlp is invoked with `--no-playlist`, but stripping
 * here also removes `t`/`index`/`pp`, which change the dedupe params hash for
 * URLs that resolve to the identical media.
 *
 * `/shorts/<id>` folds onto `watch?v=<id>`: it is the same video to yt-dlp,
 * and its share links carry their own tracking parameters.
 */
export function canonicalizeVideoUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    return `https://youtu.be${u.pathname}`;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const v = u.searchParams.get("v");
    if (v) return `https://www.youtube.com/watch?v=${v}`;
    // A Short is the same media as `watch?v=<id>` — yt-dlp resolves both to
    // one video — but its share links carry `?feature=share`, `?si=…` and
    // friends, and `return raw` kept every one of them. Two share links for
    // the same Short therefore hashed differently and became two jobs, which
    // is exactly what `(kind, paramsHash)` dedupe exists to prevent. Folded
    // onto the `watch?v=` form so a Short and its long-form URL dedupe
    // together too.
    const shorts = /^\/shorts\/([^/]+)\/?$/.exec(u.pathname);
    if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;
  }
  return raw;
}

/**
 * The wrapper the `yt-dlp-uv` installer writes into `~/.libi/bin`. Mirrors
 * `ytDlpBinaryPath()` in the runner, which this process must not import
 * (nothing under `mcp/` imports `lib/jobs/*`). Only its EXISTENCE is read
 * here, to know whether this call is the first-use install.
 */
function ytDlpWrapperPresent(): boolean {
  return fs.existsSync(path.join(getLibiBinDir(), isWindows() ? "yt-dlp.cmd" : "yt-dlp"));
}

interface DownloadedVideo {
  fileId: string;
  filename: string;
  title: string;
  bytes: number;
}

/**
 * Download a video (or its audio) with libi's own yt-dlp and import it as an
 * asset. Runs as the `video_download` job so progress, cancellation and dedupe
 * come from JobManager. Nothing under `mcp/` may import `lib/jobs/*` — the
 * dispatch goes through the HTTP client (`mcp/jobs-client.ts`).
 *
 * First use: the runner installs uv + yt-dlp (~YT_DLP_INSTALL_MB MB) before
 * spawning anything. Same disclosure pattern as the export tool's Chromium
 * download — a progress line naming the size goes out BEFORE the job so the
 * chat shows why the first call is slow, and the result carries
 * `ytDlpInstalled: true` so the agent can tell the user what just happened.
 */
export async function downloadVideo(
  params: DownloadVideoParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  const url = canonicalizeVideoUrl(params.url);
  const firstUse = !ytDlpWrapperPresent();
  if (firstUse) {
    logger.info(
      { tag: "video-download", op: "first_use_install", installMb: YT_DLP_INSTALL_MB },
      "yt-dlp wrapper absent; the job will install uv + yt-dlp first",
    );
    // Best-effort; the download proceeds regardless. Also rides the job_progress side
    // channel so Claude's chat row shows it.
    await reportToolProgress(extra, {
      progress: 0,
      total: YT_DLP_INSTALL_MB,
      message: `first video download installs uv + yt-dlp, ~${YT_DLP_INSTALL_MB} MB`,
    });
  }
  try {
    const resp = await runJobViaServer<DownloadedVideo>(
      "video_download",
      { url, pieceId: params.pieceId, audioOnly: params.audioOnly },
      { extra, pieceId: params.pieceId ?? undefined },
    );
    const result =
      resp.status === "matching_completed" ? resp.existingJob.result : resp.result;
    if (!result) {
      return { success: false, error: "download_failed", data: { message: "the job returned no file" } };
    }
    return { success: true, data: firstUse ? { ...result, ytDlpInstalled: true } : { ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The wrapper is a tier-2 dependency of the youtube-download extension.
    // The runner installs it itself, so reaching a spawn ENOENT (or a
    // "uv not found" from the installer) means that install did not leave a
    // usable wrapper — a recoverable state the user fixes from Settings, not
    // an error the agent should retry.
    if (/ENOENT|not found|no such file/i.test(message)) {
      logger.info(
        { tag: "video-download", op: "needs_install", message },
        "yt-dlp wrapper absent after the job; returning needs_install",
      );
      return {
        success: false,
        error: "needs_install",
        data: {
          extensionId: EXTENSION_ID,
          message:
            `yt-dlp is not installed and libi could not install it automatically (${message}). ` +
            `Tell the user this downloads uv + yt-dlp (public domain, ~${YT_DLP_INSTALL_MB} MB) onto their machine ` +
            "and ask them to install the Video download extension from Settings, then retry.",
        },
      };
    }
    return { success: false, error: "download_failed", data: { message } };
  }
}
