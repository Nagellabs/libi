"use client";

import { MusicBlock, type MainSong } from "@/components/social/music/music-block";
import { platformLabel } from "@/lib/social/catalog";
import type { TargetMusic } from "@/lib/social/music-policy";
import type { MusicChoice } from "@/lib/queries/social-music";
import type { SocialAccount } from "@/lib/social/types";
import type { TargetDraft } from "./types";

/** The Music step (addendum §5): one card per selected target. */
export function MusicStep({
  pieceId,
  targets,
  accounts,
  mainSong,
  mainSongLoading,
  mainSongError,
  onMusic,
  onChoice,
  onResolved,
  onAwaitingPick,
  onError,
}: {
  pieceId: string;
  targets: TargetDraft[];
  accounts: SocialAccount[];
  mainSong?: MainSong;
  mainSongLoading?: boolean;
  mainSongError?: boolean;
  onMusic: (accountId: string, music: TargetMusic | undefined) => void;
  /** The user's own override for one target's post changed (see `MusicBlock`'s `onChoice`). */
  onChoice: (accountId: string, choice: MusicChoice | undefined, expected?: MusicChoice) => void;
  onResolved: (accountId: string, resolved: boolean) => void;
  onAwaitingPick: (accountId: string, awaiting: boolean) => void;
  onError: (accountId: string, hasError: boolean) => void;
}) {
  return (
    <div className="space-y-4" data-testid="music-step">
      {targets.map((t) => {
        const account = accounts.find((a) => a.id === t.accountId);
        return (
          <div key={t.accountId} data-testid={`music-card-${t.accountId}`} className="space-y-2 rounded-lg border border-border p-3">
            <div className="text-sm font-medium">
              {platformLabel(t.platform)} @{account?.username ?? t.accountId}
            </div>
            <MusicBlock
              pieceId={pieceId}
              platform={t.platform}
              accountId={t.accountId}
              value={t.options.music}
              choice={t.musicChoice}
              onChoice={(c, expected) => onChoice(t.accountId, c, expected)}
              mainSong={mainSong}
              mainSongLoading={mainSongLoading}
              mainSongError={mainSongError}
              onChange={(m) => onMusic(t.accountId, m)}
              onResolved={(r) => onResolved(t.accountId, r)}
              onAwaitingPick={(w) => onAwaitingPick(t.accountId, w)}
              onError={(e) => onError(t.accountId, e)}
            />
          </div>
        );
      })}
    </div>
  );
}
