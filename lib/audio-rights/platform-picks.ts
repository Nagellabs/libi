/**
 * The one writer of a song's per-platform pick (addendum §1). It goes through
 * `updateAudioRights` — one write path, one row — and adds the precedence:
 * the user's pick is theirs; the automatic match and the agent never replace
 * or clear it. Which platforms can hold a pick is the platform rules' call
 * (a catalog; a draft only where the platform hands drafts off), never a list.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { platformLabel, type KnownPlatform } from "@/lib/social/catalog";
import { PLATFORM_MUSIC_RULES, type PlatformMusicRules } from "@/lib/social/music-policy";
import { serverLogger as logger } from "@/lib/logger";
import { effectiveRights } from "./read";
import type { AudioRights, PlatformPick } from "./types";
import { updateAudioRights } from "./write";

export type SetPickResult =
  | { ok: true; written: boolean; rights: AudioRights; pieceId: string | null }
  | { ok: false; code: "not_found" | "no_audio" | "invalid_pick"; message: string };

export function pickRefusal(platform: string, pick: PlatformPick | null): string | null {
  const rules = (PLATFORM_MUSIC_RULES as Record<string, PlatformMusicRules | undefined>)[platform];
  if (!rules || rules.catalog === "none") return `${platformLabel(platform)} has no music library to pick from.`;
  if (pick?.status === "draft" && !rules.draftHandoff) return `${platformLabel(platform)} has no draft to finish in the app.`;
  return null;
}

export function setPlatformPick(
  fileId: string,
  platform: KnownPlatform,
  pick: PlatformPick | null,
  actor: "auto" | "agent" | "user" = pick?.decidedBy ?? "auto",
): SetPickResult {
  const refused = pickRefusal(platform, pick);
  if (refused) return { ok: false, code: "invalid_pick", message: refused };
  const row = getDb().select().from(files).where(eq(files.id, fileId)).get();
  if (!row) return { ok: false, code: "not_found", message: `File not found: ${fileId}` };
  const current = effectiveRights(row);
  if (!current) return { ok: false, code: "no_audio", message: "This file has no audio." };
  if (current.platformPicks?.[platform]?.decidedBy === "user" && actor !== "user") {
    return { ok: true, written: false, rights: current, pieceId: row.pieceId };
  }
  const r = updateAudioRights(fileId, { platformPick: { platform, pick } }, actor === "user" ? "user" : "agent");
  if (!r.ok) return { ok: false, code: r.code === "not_found" ? "not_found" : "no_audio", message: r.message };
  logger.info(
    { tag: "social-music", op: "platform_pick_set", fileId, platform, status: pick?.status ?? "cleared", decidedBy: pick?.decidedBy ?? actor },
    "song platform pick written",
  );
  return { ok: true, written: true, rights: r.rights, pieceId: r.pieceId };
}
