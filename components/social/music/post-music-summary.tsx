"use client";

import { platformLabel } from "@/lib/social/catalog";
import { musicOfTarget } from "@/lib/social/post-music";
import { finishLinkFor } from "@/lib/social/finish-links";
import { songLabel } from "@/lib/audio-rights/types";
import { useCatalogTrack } from "@/lib/queries/social-music";
import type { SocialPost, SocialTarget } from "@/lib/social/types";
import type { TargetMusic } from "@/lib/social/music-policy";
import { MusicSentence } from "./music-sentence";
import { FinishLink } from "./finish-link";

const LINE: Record<TargetMusic["mode"], string> = {
  attach: "Licensed track attached",
  draft: "Draft to finish in the app",
  include: "Song kept in the video",
  strip: "Posted without the song",
};

/** The targets worth a music line: those libi stamped a decision on, and those
 *  with somewhere to finish by hand even without one. */
function musicRows(post: SocialPost, pieceHasCopyrighted: boolean) {
  return post.targets
    .map((t, i) => ({ t, music: musicOfTarget(post, i) }))
    .filter(({ t, music }) => music || finishLinkFor(t, undefined, pieceHasCopyrighted));
}

/** Whether `PostMusicSummary` draws anything — so a caller can leave out a
 *  detail section that would otherwise be an empty divider. */
export function hasPostMusic(post: SocialPost, pieceHasCopyrighted: boolean): boolean {
  return musicRows(post, pieceHasCopyrighted).length > 0;
}

/** What each target of a posted piece did with its music, and where to finish by hand (spec §6.5). */
export function PostMusicSummary({ post, pieceHasCopyrighted }: { post: SocialPost; pieceHasCopyrighted: boolean }) {
  const rows = musicRows(post, pieceHasCopyrighted);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid={`post-music-${post.id}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Music</h4>
      {rows.map(({ t, music }) => (
        <TargetMusicRow key={`${t.platform}-${t.accountId}`} post={post} target={t} music={music} pieceHasCopyrighted={pieceHasCopyrighted} />
      ))}
    </div>
  );
}

function TargetMusicRow({
  post,
  target,
  music,
  pieceHasCopyrighted,
}: {
  post: SocialPost;
  target: SocialTarget;
  music: TargetMusic | undefined;
  pieceHasCopyrighted: boolean;
}) {
  const attachIg = target.platform === "instagram" && music?.mode === "attach" ? music : null;
  // Only a SCHEDULED Instagram attach can still lose its track before it goes out.
  const check = useCatalogTrack(target.accountId, attachIg?.track.id ?? "", post.status === "scheduled" && !!attachIg);
  const link = finishLinkFor(target, music, pieceHasCopyrighted);
  return (
    <div className="space-y-1" data-testid={`post-music-${target.platform}-${target.accountId}`}>
      <p className="text-xs">
        {platformLabel(target.platform)} · {music ? LINE[music.mode] : LINE.include}
        {music?.mode === "attach" ? ` — ${songLabel(music.track)}` : ""}
      </p>
      {attachIg && check.data && check.data.track === null && (
        <div data-testid="music-track-gone" className="text-amber-600 dark:text-amber-400">
          <MusicSentence
            text={`Instagram no longer offers *${attachIg.track.title}*. Edit the post to pick another track, or it posts without it.`}
            testId="music-track-gone-text"
          />
        </div>
      )}
      {link && <FinishLink link={link} />}
    </div>
  );
}
