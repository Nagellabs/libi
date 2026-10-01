/**
 * `libi.social_music_search` (spec §6.4): what libi will do with the piece's
 * music on one platform (the plan sentence to relay), the `libi.export_video`
 * arguments that plan implies, and — where the platform has a catalog — the
 * tracks the user can pick. Read-only, over the studio's HTTP routes (nothing
 * under mcp/ may import lib/social/service or lib/jobs).
 *
 * It answers for all five platforms (plan decision D-D): `libi.post_piece`
 * builds only Instagram and TikTok and exports per platform itself, so for
 * YouTube, Facebook and X this tool's `exportVideoArgs` is how the agent's own
 * export keeps (YouTube) or strips (Facebook, X) the song as the plan says.
 */
import type { ToolResult } from "./types";
import type { SocialMusicSearchParams } from "./schemas";
import { api } from "./social-http";

interface PlanBody {
  targets: Array<{
    plan: {
      mode: string;
      track?: { id: string };
      sentence: string;
      warnings: string[];
      needs?: string;
      needsChoice?: boolean;
      exportVariant: "with-song" | "without-song";
      allowedModes: string[];
    };
  }>;
}
type CatalogBody = { tracks: Array<{ id: string; title: string; artist?: string; durationSec?: number }> } | { unavailable: { reason: string } };

const MAX_CANDIDATES = 20;

export async function socialMusicSearch(params: SocialMusicSearchParams): Promise<ToolResult> {
  const composable = params.platform === "instagram" || params.platform === "tiktok";
  if (composable && !params.accountId) {
    return { success: false, error: "account_required", data: { hint: "Pass accountId (libi.social_status lists the connected accounts)." } };
  }
  const planRes = await api<PlanBody>("/api/social/music/plan", {
    method: "POST",
    body: JSON.stringify({ pieceId: params.pieceId, targets: [{ platform: params.platform, ...(params.accountId ? { accountId: params.accountId } : {}) }] }),
  });
  if (!planRes.ok) {
    if (planRes.status === 0) {
      return { success: false, error: "libi_server_unavailable", data: { hint: "libi's server did not answer. Say so; do not retry in a loop." } };
    }
    return {
      success: false,
      error: "music_plan_unavailable",
      data: { hint: planRes.body.message ?? planRes.body.error ?? "libi could not work out the music plan.", status: planRes.status },
    };
  }
  const { track, ...plan } = planRes.body.targets[0].plan;

  let candidates: Array<{ id: string; title: string; artist?: string; durationSec?: number }> = [];
  let unavailable: string | undefined;
  if (composable) {
    const q = params.platform === "instagram" && params.query ? `&q=${encodeURIComponent(params.query)}` : "";
    const cat = await api<CatalogBody>(`/api/social/music/catalog?platform=${params.platform}&accountId=${encodeURIComponent(params.accountId!)}${q}`);
    if (cat.ok && "tracks" in cat.body) {
      candidates = cat.body.tracks.slice(0, MAX_CANDIDATES).map((t) => ({
        id: t.id,
        title: t.title,
        ...(t.artist ? { artist: t.artist } : {}),
        ...(t.durationSec !== undefined ? { durationSec: t.durationSec } : {}),
      }));
    } else if (cat.ok && "unavailable" in cat.body) unavailable = cat.body.unavailable.reason;
  }

  // The export this plan implies. A social export's default leaves copyrighted
  // songs out, so the with-song variant has to say `include` explicitly.
  const copyrightedAudio = plan.exportVariant === "with-song" ? "include" : "exclude";
  const exportVideoArgs = { pieceId: params.pieceId, purpose: "social" as const, copyrightedAudio };
  const exportNote = composable
    ? "libi.post_piece exports Instagram and TikTok files itself, per this plan — use it rather than exporting. exportVideoArgs applies only if you post here with your own provider tools."
    : `To post on this platform, export with libi.export_video using exactly exportVideoArgs (${
        copyrightedAudio === "include" ? "the file keeps the song" : "the file leaves the copyrighted song out"
      }; for several platforms in one call, pieceId goes at the top level and each \`variants\` entry carries only the rest), then post it with your own provider tools and link it with libi.social_link_post.`;

  return {
    success: true,
    data: { plan, candidates, autoSelected: track?.id ?? null, ...(unavailable ? { unavailable } : {}), exportVideoArgs, exportNote },
  };
}
