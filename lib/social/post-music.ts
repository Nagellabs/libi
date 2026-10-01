import type { SocialPost } from "./types";
import type { TargetMusic } from "./music-policy";
import { targetMusicSchema } from "./music-schema";

/** A target's music as libi stamped it (`metadata.libi.targetOptions`, written
 *  in target order by `toCreateBody` / `toUpdateBody`). The stamp round-trips
 *  through the provider's metadata, so it is re-validated: a malformed one
 *  reads as no music rather than a half-shaped decision. */
export function musicOfTarget(post: SocialPost, index: number): TargetMusic | undefined {
  const target = post.targets[index];
  const stamped = post.libi?.targetOptions?.[index];
  if (!target || !stamped || stamped.platform !== target.platform || stamped.music === undefined) return undefined;
  const parsed = targetMusicSchema.safeParse(stamped.music);
  return parsed.success ? parsed.data : undefined;
}
