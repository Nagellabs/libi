/** `libi.set_audio_rights` (spec §4.3). The agent may confirm a song's identity
 *  and stamp `generated`/`copyrighted`; `owned` is the user's alone. A new
 *  identity on a copyrighted song is matched again on the platforms — over
 *  the studio's loopback route (the MCP child never imports lib/social). */
import { updateAudioRights } from "@/lib/audio-rights/write";
import { notify } from "@/mcp/notify";
import { mcpLogger as logger } from "@/lib/logger";
import { api } from "./social-http";
import type { ToolResult } from "./types";
import type { SetAudioRightsParams } from "./schemas";

const MATCH_UNAVAILABLE = "libi couldn't match the song on the platforms right now — the user can pick a track when posting.";

/** POST music-match; never throws — a failed match never fails the caller's tool. */
export async function requestSongMatch(fileId: string): Promise<Record<string, unknown>> {
  const r = await api<Record<string, unknown>>(`/api/files/by-id/${fileId}/music-match`, { method: "POST" });
  if (r.ok) return r.body;
  logger.warn({ tag: "social-music", op: "match_failed", fileId, status: r.status }, "song match request failed");
  return { error: r.status === 0 ? "libi_server_unavailable" : "music_match_failed", summary: [MATCH_UNAVAILABLE] };
}

export async function setAudioRights(params: SetAudioRightsParams): Promise<ToolResult> {
  const r = updateAudioRights(
    params.fileId,
    { ...(params.class ? { class: params.class } : {}), ...(params.track ? { track: params.track } : {}) },
    "agent",
    { pieceId: params.pieceId },
  );
  if (!r.ok) {
    if (r.code === "owned_user_only" || r.code === "user_decided") return { success: false, error: r.code, data: { hint: r.message } };
    return { success: false, error: r.code === "not_found" ? "file_not_found" : "no_audio", data: { hint: r.message } };
  }
  logger.info({ tag: "social-music", op: "rights_set", fileId: params.fileId, class: r.rights.class }, "agent set audio rights");
  const music = r.trackChanged && r.rights.class === "copyrighted" ? await requestSongMatch(params.fileId) : undefined;
  notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
  return { success: true, data: { fileId: params.fileId, rights: r.rights, ...(music ? { music } : {}) } };
}
