"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { StatusChip, TargetChips } from "@/components/social/status-chips";
import { PostActions } from "@/components/social/post-actions";
import { AnalyticsPanel } from "@/components/social/analytics-panel";
import { AskAgentButton } from "@/components/social/ask-agent-button";
import { PostDetailSkeleton } from "@/components/social/social-skeletons";
import { captionFirstLine } from "@/lib/social/format";
import { platformLabel } from "@/lib/social/catalog";
import { useSocialAccounts, useSocialPost, useUpdateSocialPost } from "@/lib/queries/social";
import type { InstagramOptions, SocialTarget, TikTokOptions } from "@/lib/social/types";


/** Every option chip is read from what the target's own `options` carry —
 *  never a hardcoded toggle list — because the provider is the only source
 *  of truth for what a platform actually allows on this account. */
function describeInstagramOptions(o: InstagramOptions): string {
  return [
    o.contentType.charAt(0).toUpperCase() + o.contentType.slice(1),
    // "share to feed" is a Reel-only concept — Feed and Story never have it
    // (the Targets step hides the switch for both), so stating either way
    // for them would describe something that was never a choice. Guards
    // `toCreateBody` (lib/social/providers/zernio/normalize.ts) already
    // stops sending it for non-Reels; this is the display side of the same
    // fix, independent of whatever the provider happens to echo back.
    ...(o.contentType === "reel" ? [o.shareToFeed ? "share to feed" : "not shared to feed"] : []),
    o.isAiGenerated ? "AI label" : "no AI label",
    o.commentsEnabled === false ? "comments off" : "comments on",
  ].join(" · ");
}

function describeTikTokOptions(o: TikTokOptions): string {
  const privacy =
    o.privacyLevel === "PUBLIC_TO_EVERYONE"
      ? "public"
      : o.privacyLevel === "SELF_ONLY"
        ? "only me"
        : o.privacyLevel === "MUTUAL_FOLLOW_FRIENDS"
          ? "friends"
          : o.privacyLevel.toLowerCase();
  return [privacy, o.allowDuet ? "duet on" : "duet off", o.allowStitch ? "stitch on" : "stitch off", o.madeWithAi ? "AI label" : "no AI label"].join(
    " · ",
  );
}

function describeOptions(t: SocialTarget): string | null {
  if (!t.options) return null;
  return t.options.platform === "instagram" ? describeInstagramOptions(t.options.instagram) : describeTikTokOptions(t.options.tiktok);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function PostDetailSheet({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const q = useSocialPost(postId);
  const accounts = useSocialAccounts(!!postId);
  const update = useUpdateSocialPost();
  const [editing, setEditing] = useState(false);
  const [draftCaption, setDraftCaption] = useState("");

  const post = q.data;

  // Reset the caption editor when a DIFFERENT post is opened — the
  // previous-value pattern (compare-during-render), not setState-in-effect.
  const [prevPostId, setPrevPostId] = useState(postId);
  if (postId !== prevPostId) {
    setPrevPostId(postId);
    setEditing(false);
  }

  const usernameFor = (accountId: string) => accounts.data?.find((a) => a.id === accountId)?.username;

  const uploadExpiryWarning = useMemo(() => {
    if (!post || post.status !== "scheduled" || !post.scheduledFor) return null;
    const scheduled = new Date(post.scheduledFor).getTime();
    const created = new Date(post.createdAt).getTime();
    if (Number.isNaN(scheduled) || Number.isNaN(created)) return null;
    return scheduled - created > SEVEN_DAYS_MS
      ? "The uploaded media URL expires 7 days after upload — re-post this before then or move the date"
      : null;
  }, [post]);

  return (
    <Sheet open={!!postId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-testid="post-detail-sheet">
        {!post ? (
          <div className="p-4">
            <PostDetailSkeleton />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="truncate">{captionFirstLine(post.content) || "Untitled post"}</span>
                <StatusChip post={post} />
              </SheetTitle>
            </SheetHeader>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
              {post.media[0] &&
                (post.media[0].type === "video" ? (
                  <video controls muted className="w-full rounded-md" src={post.media[0].url} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- remote provider media, not a static asset
                  <img src={post.media[0].url} alt="" className="w-full rounded-md object-cover" />
                ))}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Caption</span>
                  {!editing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer"
                      onClick={() => {
                        setDraftCaption(post.content);
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                {editing ? (
                  <div className="space-y-2">
                    <textarea
                      value={draftCaption}
                      onChange={(e) => setDraftCaption(e.target.value)}
                      className="block min-h-24 w-full resize-none rounded-lg border border-input bg-transparent p-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="cursor-pointer"
                        disabled={update.isPending}
                        onClick={() => {
                          update.mutate(
                            { id: post.id, requestId: post.link?.requestId ?? crypto.randomUUID(), content: draftCaption },
                            { onSuccess: () => setEditing(false) },
                          );
                        }}
                      >
                        Save
                      </Button>
                      <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => setEditing(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{post.content || <span className="italic text-muted-foreground">No caption</span>}</p>
                )}
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Targets</span>
                {post.targets.map((t) => (
                  <div key={`${t.platform}:${t.accountId}`} className="rounded-lg border border-border p-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {platformLabel(t.platform)}
                        {usernameFor(t.accountId) ? ` @${usernameFor(t.accountId)}` : ""}
                      </span>
                      <TargetChips targets={[t]} />
                    </div>
                    {t.url && (
                      <a href={t.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block cursor-pointer text-xs text-primary hover:underline">
                        Open on {platformLabel(t.platform)} ↗
                      </a>
                    )}
                    {t.error && <p className="mt-1 text-xs text-destructive">{t.error}</p>}
                    {describeOptions(t) && <p className="mt-1 text-xs text-muted-foreground">{describeOptions(t)}</p>}
                  </div>
                ))}
              </div>

              <PostActions post={post} onEdit={() => { setDraftCaption(post.content); setEditing(true); }} />

              {(post.libi?.pieceName || post.link?.exportPath) && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Made from </span>
                  {post.libi?.pieceName && (
                    // `?piece=` is the deep-link the editor page reads on
                    // mount to open a specific piece (and land on its
                    // Posting tab) instead of whatever piece happened to be
                    // open last — see app/(app)/editor/page.tsx's deep-link
                    // restore effect.
                    <Link
                      href={`/editor?piece=${encodeURIComponent(post.libi.pieceId)}`}
                      className="cursor-pointer text-primary hover:underline"
                    >
                      {post.libi.pieceName}
                    </Link>
                  )}
                  {post.link?.exportPath && <span> ({post.link.exportPath.split("/").pop()})</span>}
                </div>
              )}

              {uploadExpiryWarning && <p className="text-xs text-amber-500">{uploadExpiryWarning}</p>}

              {(post.status === "published" || post.status === "partial") && (
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">Analytics</span>
                  <AnalyticsPanel postId={post.id} />
                </div>
              )}

              {post.status === "published" && (
                <AskAgentButton kind="ads" ctx={{ postId: post.id }} label="Boost as an ad… (needs the agent)" />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
