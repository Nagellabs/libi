"use client";

import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  type LinkedPost,
  SocialApiError,
  retryAtFor,
  useDeleteSocialPost,
  useRetrySocialPost,
  useSocialAccounts,
  useSocialStatus,
  useUpdateSocialPost,
} from "@/lib/queries/social";
import { trackEvent } from "@/lib/analytics/client";
import type { PostStatus } from "@/lib/social/types";
import { toDatetimeLocal } from "@/lib/social/format";
import { platformLabel } from "@/lib/social/catalog";
import { SchedulePicker } from "@/components/social/schedule-picker";
import { PlatformOpenLinks } from "@/components/social/post-links";

type ActionName = "schedule" | "reschedule" | "cancel" | "publish" | "edit" | "delete" | "retry" | "open";

/**
 * The closed lifecycle list. Nothing outside this map ever renders, and the
 * order here is the render order — the spec's "libi's UI may" boundary is
 * enforced by this table, not by convention.
 */
const ACTIONS: Record<PostStatus, ActionName[]> = {
  draft: ["schedule", "publish", "edit", "delete"],
  scheduled: ["reschedule", "cancel", "edit"],
  publishing: [],
  failed: ["retry", "edit", "delete"],
  partial: ["retry", "edit"],
  published: ["open"],
  cancelled: ["schedule", "edit", "delete"],
};

const NO_UNDO: Record<string, string> = {
  instagram: "no undo: delete it in the Instagram app afterwards",
  tiktok: "public on this account, no undo",
};

function fmtHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PostActions({
  post,
  compact = false,
  onEdit,
  hideOpen = false,
}: {
  post: LinkedPost;
  compact?: boolean;
  onEdit?: () => void;
  /** The caller draws the platform links itself — the Social page puts them
   *  first in a row, beside the "Piece" link. */
  hideOpen?: boolean;
}) {
  const status = useSocialStatus();
  const accounts = useSocialAccounts();
  const update = useUpdateSocialPost();
  const del = useDeleteSocialPost();
  const retry = useRetrySocialPost();

  const [schedulePopoverOpen, setSchedulePopoverOpen] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // The zone the popover's field is LABELLED with, and the one its value is
  // read in. The post's own zone first, then the user's posting default — a
  // real zone either way, because reading the instant in the browser's zone
  // and re-saving it under this label moves the schedule by the offset
  // (`toDatetimeLocal`'s note).
  const zone = post.timezone ?? status.data?.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [scheduledFor, setScheduledFor] = useState(() => toDatetimeLocal(post.scheduledFor, zone));
  const [timezone, setTimezone] = useState(() => zone);
  const [retryAt, setRetryAt] = useState<string | null>(null);

  const requestId = useMemo(() => post.link?.requestId ?? crypto.randomUUID(), [post.link?.requestId]);

  const onRateLimited = (err: unknown) => {
    if (err instanceof SocialApiError) {
      const at = retryAtFor(err);
      if (at) setRetryAt(at);
    }
  };

  const usernameFor = (accountId: string) => accounts.data?.find((a) => a.id === accountId)?.username;
  const btnSize = compact ? "sm" : "default";

  const submitSchedule = () => {
    if (!scheduledFor) return;
    trackEvent("social_post_action", { provider: "zernio", action: "schedule" });
    update.mutate(
      // The BARE wall-clock string the field holds, plus the zone — the one
      // shape measured against the live provider, and the one the composer
      // sends. An ISO `Z` instant alongside `timezone` is a second wire shape
      // nothing has tested (`toDatetimeLocal`'s note).
      { id: post.id, requestId, when: { mode: "schedule", scheduledFor, timezone } },
      { onError: onRateLimited, onSuccess: () => setSchedulePopoverOpen(false) },
    );
  };

  function schedulePopover(label: string, testId: string) {
    return (
      <Popover open={schedulePopoverOpen} onOpenChange={setSchedulePopoverOpen}>
        <PopoverTrigger render={<Button variant="outline" size={btnSize} className="cursor-pointer" data-testid={testId} />}>
          {label}
        </PopoverTrigger>
        <PopoverContent>
          <div className="space-y-2">
            {/* The same picker the composer uses, for the same reason: the
                value is a wall clock in the POST'S zone, which is the one
                thing the browser's native control cannot know. */}
            <SchedulePicker value={scheduledFor} timezone={timezone} idPrefix="reschedule" onChange={setScheduledFor} />
            <Input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Timezone (e.g. Asia/Bangkok)"
            />
            <Button size="sm" className="w-full cursor-pointer" disabled={!scheduledFor || update.isPending} onClick={submitSchedule}>
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  function renderAction(name: ActionName) {
    switch (name) {
      case "schedule":
        return schedulePopover("Schedule…", "post-action-schedule");
      case "reschedule":
        return schedulePopover("Reschedule…", "post-action-reschedule");
      case "cancel":
        return (
          <Button
            variant="outline"
            size={btnSize}
            className="cursor-pointer"
            data-testid="post-action-cancel"
            disabled={update.isPending}
            /* Not "Cancel". This takes the post OFF the schedule and leaves it
               as a draft — nothing is deleted and nothing is lost — but
               "Cancel" beside a Delete button reads as "cancel the post", so
               people stopped using it and deleted instead (QA 2026-09-21).
               The button now says what it does, and the title says where the
               post ends up. */
            title="Takes it off the schedule and keeps it as a draft — schedule it again, publish it, or delete it afterwards."
            onClick={() => {
              trackEvent("social_post_action", { provider: "zernio", action: "cancel" });
              update.mutate({ id: post.id, requestId, when: { mode: "cancel" } }, { onError: onRateLimited });
            }}
          >
            Remove from schedule
          </Button>
        );
      case "publish":
        return (
          <>
            <Button
              variant="outline"
              size={btnSize}
              className="cursor-pointer"
              data-testid="post-action-publish"
              onClick={() => setPublishConfirmOpen(true)}
            >
              Publish now
            </Button>
            <AlertDialog open={publishConfirmOpen} onOpenChange={setPublishConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Publish now?</AlertDialogTitle>
                  {/* `render={<div />}` — a <p> can't legally contain the <ul> below. */}
                  <AlertDialogDescription render={<div />}>
                    <ul className="list-disc space-y-1 pl-4 text-left">
                      {post.targets.map((t) => {
                        const username = usernameFor(t.accountId);
                        return (
                          <li key={`${t.platform}:${t.accountId}`}>
                            {platformLabel(t.platform)} {username ? `@${username}` : ""} — {NO_UNDO[t.platform] ?? "no undo"}
                          </li>
                        );
                      })}
                    </ul>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="cursor-pointer"
                    onClick={() => {
                      trackEvent("social_post_action", { provider: "zernio", action: "publish" });
                      update.mutate(
                        { id: post.id, requestId, when: { mode: "now" } },
                        { onError: onRateLimited, onSuccess: () => setPublishConfirmOpen(false) },
                      );
                    }}
                  >
                    Publish now
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        );
      case "edit":
        // Never reached without an `onEdit` — the render below filters it out.
        if (!onEdit) return null;
        return (
          <Button variant="ghost" size={btnSize} className="cursor-pointer" data-testid="post-action-edit" onClick={onEdit}>
            Edit
          </Button>
        );
      case "delete":
        return (
          <>
            <Button
              variant="ghost"
              size={btnSize}
              className="cursor-pointer text-destructive"
              data-testid="post-action-delete"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              Delete
            </Button>
            <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this draft at Zernio?</AlertDialogTitle>
                  <AlertDialogDescription>The piece and its export stay.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      trackEvent("social_post_action", { provider: "zernio", action: "delete" });
                      del.mutate(post.id, { onError: onRateLimited, onSuccess: () => setDeleteConfirmOpen(false) });
                    }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        );
      case "retry":
        return (
          <Button
            variant="outline"
            size={btnSize}
            className="cursor-pointer"
            data-testid="post-action-retry"
            disabled={retry.isPending}
            onClick={() => {
              trackEvent("social_post_action", { provider: "zernio", action: "retry" });
              retry.mutate(post.id, { onError: onRateLimited });
            }}
          >
            Retry
          </Button>
        );
      case "open":
        return <PlatformOpenLinks targets={post.targets} />;
    }
  }

  return (
    // `min-w-0` + the parent row's `flex-wrap` (post-row.tsx): squeezed next
    // to a flexible text column, these buttons used to be compressed past
    // their own content and overflow ON TOP of it (QA 2026-09-21, finding
    // 10). Now the row wraps them onto their own line first, and `min-w-0`
    // lets THIS container then shrink to the row's width so its own
    // `flex-wrap` can break the buttons across two lines instead of
    // overhanging the card.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {/* "edit" only when someone is listening. The Social page renders these
          rows with no `onEdit` (editing a caption means opening the piece's
          Posting tab, which that page cannot do), and a button wired to
          `onEdit?.()` rendered there did nothing at all when clicked — worse
          than an absent one, because it reads as broken rather than as
          unavailable. */}
      {ACTIONS[post.status]
        .filter((name) => (name !== "edit" || !!onEdit) && (name !== "open" || !hideOpen))
        .map((name) => (
          <Fragment key={name}>{renderAction(name)}</Fragment>
        ))}
      {/* Nothing in libi retries on a timer — this is when the PROVIDER's
          limit lifts, i.e. when the user's own next attempt will be accepted.
          The old copy ("retrying at") promised a retry that never came. */}
      {retryAt && <span className="text-xs text-muted-foreground">Provider rate limit — try again after {fmtHHMM(retryAt)}</span>}
    </div>
  );
}
