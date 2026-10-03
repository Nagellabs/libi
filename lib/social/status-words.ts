/**
 * libi's words for what happened to a post, in one place — provider-neutral.
 *
 * A provider's status vocabulary is not the user's: Zernio answers `published`
 * (and `PUBLIC_TO_EVERYONE`) for a video that only reached a TikTok INBOX, and
 * a draft is "a draft" only in libi and at the provider, never in TikTok or
 * Instagram. The adapter marks what the provider said (`SocialTarget.delivery`);
 * everything that talks to a user or an agent — the Posting tab's chips, the
 * post results — reads these functions instead of echoing the raw status.
 */
import { platformLabel } from "./catalog";
import type { PostStatus, SocialPost, SocialTarget, TargetStatus } from "./types";

type PostLike = Pick<SocialPost, "status" | "targets">;

const POST_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TARGET_LABEL: Record<TargetStatus, string> = {
  pending: "Pending",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A target whose video is in the platform's inbox, not published. */
export function isInboxTarget(t: SocialTarget): boolean {
  return t.status === "published" && t.delivery === "inbox";
}

/** Every published target of the post is an inbox upload (and at least one is published). */
function allPublishedAreInbox(post: PostLike): boolean {
  const published = post.targets.filter((t) => t.status === "published");
  return published.length > 0 && published.every(isInboxTarget);
}

/** The chip word for one target. */
export function targetStatusLabel(t: SocialTarget): string {
  return isInboxTarget(t) ? "Sent to inbox" : TARGET_LABEL[t.status];
}

/** The chip word for a whole post: "Published" never covers an inbox-only upload. */
export function postStatusLabel(post: PostLike): string {
  if (post.status === "published" && allPublishedAreInbox(post)) return "Sent to inbox";
  return POST_LABEL[post.status];
}

/** The post's status for style lookups: an inbox-only upload is not styled as published. */
export function postStatusTone(post: PostLike): PostStatus | "inbox" {
  return post.status === "published" && allPublishedAreInbox(post) ? "inbox" : post.status;
}

/**
 * One sentence the user (or the agent relaying it) can read: where the post is
 * and what is left to do. Never says published for an inbox upload.
 */
export function postStatusSentence(post: PostLike): string {
  const inbox = post.targets.filter(isInboxTarget);
  const live = post.targets.filter((t) => t.status === "published" && !isInboxTarget(t));
  const parts: string[] = [];
  if (inbox.length > 0) {
    const names = [...new Set(inbox.map((t) => platformLabel(t.platform)))];
    const app = names.length === 1 ? `the ${names[0]} app's` : "each app's";
    parts.push(`Sent to your ${names.join(" and ")} inbox — open ${app} notification to finish. Nothing is public yet.`);
  }
  if (live.length > 0) parts.push(`Published on ${[...new Set(live.map((t) => platformLabel(t.platform)))].join(" and ")}.`);
  if (parts.length > 0) return parts.join(" ");
  switch (post.status) {
    case "draft":
      return "Draft: saved in libi's Posting tab and at the provider. Nothing appears in TikTok or Instagram until the user sends it.";
    case "scheduled":
      return "Scheduled at the provider; it posts itself at the set time.";
    case "publishing":
      return "Being published now.";
    case "failed":
      return "Failed: nothing was posted.";
    case "cancelled":
      return "Cancelled.";
    default:
      return POST_LABEL[post.status];
  }
}
