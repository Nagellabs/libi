import type { PostAnalytics, SocialPost, SocialTarget, StoryInsights } from "@/lib/social/types";
import { platformLabel } from "@/lib/social/catalog";

/** The first non-blank line of a caption, folded to a row-friendly length. */
export function captionFirstLine(s: string): string {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > 80 ? `${l.slice(0, 79)}…` : l;
}

/** Compact follower/like/view counts: 1234 -> "1.2k", 2_500_000 -> "2.5M". */
export function fmtCount(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * The time a row shows: a scheduled post's slot, a published/partial post's
 * publish time. NEVER a draft's — a draft's per-target rows carry a
 * meaningless placeholder `scheduledFor` (verified live,
 * `.superpowers/sdd/zernio-live-shapes.md`), and `SocialPost.scheduledFor`
 * itself is only ever set while `status === "scheduled"`.
 */
export function whenLabel(post: SocialPost, tz: string | null): string | null {
  const iso =
    post.status === "scheduled"
      ? post.scheduledFor
      : post.status === "published" || post.status === "partial"
        ? (post.publishedAt ?? post.scheduledFor)
        : null;
  if (!iso) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz ?? post.timezone ?? undefined,
  }).format(new Date(iso));
}

/**
 * A `datetime-local` value for an ISO instant, read IN A GIVEN ZONE.
 *
 * The browser's own zone is the wrong one here: the field is labelled with the
 * post's `timezone`, and Zernio stores the instant plus that zone. Reading
 * 09:00 Asia/Bangkok on a machine in Europe showed 04:00 under a "Asia/Bangkok"
 * label — and re-saving that would have MOVED the schedule by the offset.
 *
 * The value this returns is also the value that goes back on the wire: Zernio
 * takes a bare wall-clock `scheduled_for` plus `timezone` and converts it
 * itself (verified live, `.superpowers/sdd/zernio-live-shapes.md`). Do NOT
 * send `new Date(v).toISOString()` — a `Z` instant alongside a
 * `timezone: "Asia/Bangkok"` is a second, untested wire shape, and combined
 * with a browser-local read it moves the schedule twice.
 */
export function toDatetimeLocal(iso: string | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const at = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    const [y, mo, da, h, mi] = [at("year"), at("month"), at("day"), at("hour"), at("minute")];
    if (y && mo && da && h && mi) return `${y}-${mo}-${da}T${h}:${mi}`;
  } catch {
    // A zone Intl does not know (the provider's value is free text) — fall
    // through to the browser's, which is at least a real time.
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Content types, named. `ad` is not a post type at all — it is the Posting
 * tab's own filter value for an ad, which has no post behind it.
 */
export const CONTENT_TYPE_LABEL: Record<string, string> = {
  reel: "Reel",
  feed: "Feed",
  story: "Story",
  video: "Video",
  ad: "Ad",
};

/**
 * The content type ONE target carries — Instagram's chosen one, TikTok's only
 * one. `null` for a platform whose options the composer does not build
 * (facebook, twitter, youtube): the agent posted it and the provider did not
 * tell us what shape it took, and a guessed "Video" under a YouTube post
 * would be a label we invented.
 */
export function targetType(t: SocialTarget): string | null {
  if (t.options?.platform === "instagram") return t.options.instagram.contentType;
  if (t.platform === "tiktok") return "video";
  return null;
}

/** Every distinct content type a post targets, for the type filter. */
export function postTypes(post: SocialPost): string[] {
  return [...new Set(post.targets.map(targetType).filter((x): x is string => !!x))];
}

/**
 * How a post is named in a list of its siblings: the network and the type,
 * which is what tells two of a piece's posts apart at a glance — the caption
 * is usually the same on all of them. A multi-target post is named by its
 * first target plus a count, never by a joined list that would not fit.
 */
export function postEntryLabel(post: SocialPost): string {
  const first = post.targets[0];
  if (!first) return "Post";
  const type = targetType(first);
  const base = type ? `${platformLabel(first.platform)} — ${CONTENT_TYPE_LABEL[type] ?? type}` : platformLabel(first.platform);
  return post.targets.length > 1 ? `${base} +${post.targets.length - 1}` : base;
}

/** A post's headline numbers, summed across every network it went to. */
export interface PostMetricSummary {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, b) => a + b, 0);
}

/**
 * One row of numbers for a post that went to several networks: each figure is
 * the SUM of what the networks reported, and absent — never 0 — when none of
 * them reported it. Views fall back to impressions per network, the same
 * priority `AnalyticsPanel` leads with. A Story's numbers arrive through their
 * own endpoint (`stories`), so they are counted in as well; a network still
 * syncing contributes nothing rather than a zero.
 */
export function summarizeAnalytics(
  a: (PostAnalytics & { stories?: Array<{ insights: StoryInsights }> }) | undefined,
): PostMetricSummary {
  if (!a) return {};
  const targets = a.syncStatus === "ready" ? a.perTarget : [];
  const stories = (a.stories ?? []).filter((s) => s.insights.source !== "unavailable").map((s) => s.insights.metrics);
  return {
    views: sum([...targets.map((t) => t.views ?? t.impressions), ...stories.map((m) => m.views)]),
    reach: sum([...targets.map((t) => t.reach), ...stories.map((m) => m.reach)]),
    likes: sum(targets.map((t) => t.likes)),
    comments: sum([...targets.map((t) => t.comments), ...stories.map((m) => m.replies)]),
    shares: sum([...targets.map((t) => t.shares), ...stories.map((m) => m.shares)]),
  };
}

/** True only when every target is an Instagram story — Zernio requires no
 *  caption for a story, so the row shows a placeholder instead of an empty line. */
export function isStoryOnly(post: SocialPost): boolean {
  return (
    post.targets.length > 0 &&
    post.targets.every((t) => t.platform === "instagram" && t.options?.platform === "instagram" && t.options.instagram.contentType === "story")
  );
}
