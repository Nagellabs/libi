import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { runJobViaServer } from "@/mcp/jobs-client";
import {
  checkYtDlpLauncher,
  VIDEO_DOWNLOAD_UI_PATH,
  YT_DLP_UNAVAILABLE,
} from "@/lib/video-download/launcher";
import { isNetworkCause } from "@/lib/uv-env/network-failure";
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
 * The agent-facing text for the LAST-RESORT failure: libi tried to install or
 * repair yt-dlp itself and could not (offline, a proxy refusing PyPI, a full
 * disk). Only a cause that reads as the network gets the "check you are
 * online" advice; anything else is relayed as it is. Everything short of that
 * libi fixes on its own inside the job, so
 * this never asks the user to install anything by hand, never sends them to
 * Settings (the extension lives under Agents → Libi MCP), and forbids the
 * repair the owner's agent actually did on 2026-09-25 — `sed` on libi's
 * launcher. `cause` is the job's own error, marker stripped.
 */
export function needsInstallMessage(cause: string): string {
  const where =
    `${VIDEO_DOWNLOAD_UI_PATH}: the uv and yt-dlp chips there show the error, and their Download / ` +
    "Retry / Re-download button reinstalls.";
  const never =
    "Do NOT edit, create or delete anything under ~/.libi/bin or ~/.libi/uv, and do not fall back to " +
    "a system yt-dlp via Bash.";
  const head =
    `libi could not install or repair its video downloader (uv + yt-dlp) on this machine: ${cause}. ` +
    "libi installs and repairs Video download itself.";
  if (isNetworkCause(cause)) {
    return (
      `${head} This looks like a network problem (offline, or a network that blocks GitHub / PyPI). ` +
      "Tell the user that in plain words, ask them to check they are online, and retry this tool ONCE " +
      `when they say so. If it still fails, point them at ${where} ${never}`
    );
  }
  return (
    `${head} Tell the user plainly what failed (the reason above) and point them at ${where} ` +
    `Retry this tool ONCE after they have done that. ${never}`
  );
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
  // Only a launcher's EXISTENCE marks the first-use install; one that exists
  // but points at nothing is a repair the job does on its own (and, with the
  // uv tool still on disk, in seconds) — logged, not disclosed as a download.
  const launcher = checkYtDlpLauncher();
  const firstUse = !launcher.ok && launcher.reason === "missing";
  if (!launcher.ok && !firstUse) {
    logger.info(
      { tag: "video-download", op: "launcher_repair_expected", reason: launcher.reason, target: launcher.target },
      "yt-dlp launcher present but unusable; the job will reinstall it before downloading",
    );
  }
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
    // The runner installs uv + yt-dlp itself, reinstalls a launcher whose
    // target is gone, and repairs + retries once when yt-dlp cannot be
    // started. It marks the one failure left over — libi could NOT make
    // yt-dlp usable — with YT_DLP_UNAVAILABLE; only that is needs_install.
    // (The old `/ENOENT|not found|no such file/` test also caught yt-dlp's
    // own "Video not found" and sent the user off to reinstall.)
    const at = message.indexOf(YT_DLP_UNAVAILABLE);
    if (at !== -1) {
      const cause = message.slice(at + YT_DLP_UNAVAILABLE.length).trim();
      logger.info(
        { tag: "video-download", op: "needs_install", message },
        "libi could not install or repair yt-dlp; returning needs_install",
      );
      return {
        success: false,
        error: "needs_install",
        data: { extensionId: EXTENSION_ID, message: needsInstallMessage(cause) },
      };
    }
    return { success: false, error: "download_failed", data: { message } };
  }
}
