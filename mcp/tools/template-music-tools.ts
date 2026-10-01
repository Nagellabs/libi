/**
 * `libi.fetch_template_music` (social-music spec §7, D3): the agent, AFTER the
 * user said yes, downloads a template's song from its source link with libi's
 * own downloader (the `video_download` job — progress, dedupe, cancel), names
 * it with the template's identity, and places it at the template's timing.
 */
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { addClip } from "@/lib/composition/audio-clips";
import { updateAudioRights } from "@/lib/audio-rights/write";
import { songLabel } from "@/lib/audio-rights/types";
import { downloadVideo } from "@/mcp/tools/video-download-tools";
import { notify } from "@/mcp/notify";
import { mcpLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type { FetchTemplateMusicParams } from "./schemas";

const rand = () => Math.random().toString(36).slice(2, 10);

export async function fetchTemplateMusic(
  params: FetchTemplateMusicParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  const before = await loadManifest(params.pieceId);
  const entry = before.pendingMusic?.find((p) => p.assetId === params.assetId);
  if (!entry) {
    return {
      success: false,
      error: "pending_music_not_found",
      data: { hint: "libi.get_piece_state or the apply result lists this piece's pending music." },
    };
  }
  if (!entry.sourceUrl) {
    return { success: false, error: "no_source", data: { hint: `ask the user for a file or link for ${songLabel(entry.track)}` } };
  }
  const dl = await downloadVideo({ url: entry.sourceUrl, pieceId: params.pieceId, audioOnly: true }, extra);
  if (!dl.success) return dl;
  const fileId = String((dl.data as { fileId: string }).fileId);
  // The downloader stamped it copyrighted with its source page; the template knows its name.
  const rights = updateAudioRights(fileId, { class: "copyrighted", track: entry.track }, "agent", { pieceId: params.pieceId });
  if (!rights.ok) {
    logger.warn(
      { tag: "social-music", op: "template_music_rights_failed", pieceId: params.pieceId, fileId, code: rights.code },
      "could not record the template's track on the downloaded file",
    );
  }
  let m = await loadManifest(params.pieceId);
  // The duck's sidechains were re-minted to this piece's clip ids at apply; one
  // the user has deleted since drives nothing and is dropped.
  const liveClipIds = new Set((m.audioClips ?? []).map((c) => c.id));
  const clipIds: string[] = [];
  for (const c of entry.clips) {
    const id = `clip_${rand()}`;
    clipIds.push(id);
    m = addClip(m, {
      id,
      kind: "standalone",
      fileId,
      startTime: c.startTime,
      duration: c.duration,
      trimStart: c.trimStart,
      volume: c.volume,
      enabled: c.enabled ?? true,
      label: entry.track.title,
      ...(c.duck ? { duck: { ...c.duck, sidechainClipIds: c.duck.sidechainClipIds.filter((s) => liveClipIds.has(s)) } } : {}),
    });
  }
  const rest = (m.pendingMusic ?? []).filter((p) => p.assetId !== params.assetId);
  if (rest.length > 0) m.pendingMusic = rest;
  else delete m.pendingMusic;
  await saveManifest(params.pieceId, m);
  logger.info(
    { tag: "social-music", op: "template_music_fetched", pieceId: params.pieceId, assetId: params.assetId, clips: clipIds.length },
    "template music fetched and placed",
  );
  notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
  notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
  return { success: true, data: { fileId, clipIds, track: entry.track } };
}
