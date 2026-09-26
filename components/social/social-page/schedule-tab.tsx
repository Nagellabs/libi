"use client";

import { useMemo } from "react";
import { PostListSkeleton } from "@/components/social/social-skeletons";
import { PostRow } from "@/components/social/post-row";
import { RateLimitBanner } from "@/components/social/social-page/social-page";
import { useSocialPosts, useSocialStatus, type LinkedPost } from "@/lib/queries/social";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A day-grouping key that is stable across formatting locales — the Schedule tab's
 *  grouping, so every day agrees on what "the same day" means in the
 *  account's timezone. */
export function dayKey(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz ?? undefined }).format(
    new Date(iso),
  );
}

function dayLabel(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: tz ?? undefined }).format(
    new Date(iso),
  );
}

export interface DayGroup {
  key: string;
  label: string;
  posts: LinkedPost[];
}

/** Groups posts by local day using `dateOf`, sorted chronologically. Posts
 *  with no usable date from `dateOf` are dropped rather than grouped under a
 *  meaningless bucket. */
export function groupByDay(posts: LinkedPost[], tz: string | null, dateOf: (p: LinkedPost) => string | undefined): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const p of posts) {
    const iso = dateOf(p);
    if (!iso) continue;
    const key = dayKey(iso, tz);
    const g = groups.get(key);
    if (g) g.posts.push(p);
    else groups.set(key, { key, label: dayLabel(iso, tz), posts: [p] });
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * `PostRow` already renders `<PostActions compact>` for every status,
 * including `reschedule`/`cancel` for a scheduled post — nothing extra to add
 * here beyond the day grouping.
 */
export function ScheduleTab({ onOpen }: { onOpen: (id: string) => void }) {
  const status = useSocialStatus();
  const tz = status.data?.settings.timezone ?? null;
  // Fixed once per mount: a `from`/`to` rebuilt from `new Date()` on every render changes the
  // query key every render and refetches forever.
  const { fromIso, toIso } = useMemo(() => {
    const now = new Date();
    return { fromIso: now.toISOString(), toIso: new Date(now.getTime() + 14 * DAY_MS).toISOString() };
  }, []);

  const posts = useSocialPosts({ status: ["scheduled"], from: fromIso, to: toIso, limit: 100 });
  const groups = groupByDay(posts.data?.posts ?? [], tz, (p) => p.scheduledFor);

  return (
    <div className="space-y-4 pt-4">
      <RateLimitBanner error={posts.error} />

      {posts.isLoading ? (
        <PostListSkeleton />
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing scheduled in the next 14 days.</p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key}>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{g.label}</p>
              <ul className="space-y-2">
                {g.posts.map((p) => (
                  <PostRow key={p.id} post={p} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Zernio can also drip posts from a per-profile queue — ask the agent to set that up (later phase).
      </p>
    </div>
  );
}
