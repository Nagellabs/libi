"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * No Dashboard and no Analytics tab. The Dashboard's one unique job — whether
 * the accounts are connected — is the Settings tab's, and the Analytics tab
 * was a second, thinner list of the same posts: its numbers are now columns
 * of the Posts table, where they can be sorted (QA 2026-09-22). An old
 * `?tab=dashboard` / `?tab=analytics` link reads as junk and lands on Posts.
 */
export const SOCIAL_TABS = ["posts", "schedule", "ads", "settings"] as const;
export type SocialTab = (typeof SOCIAL_TABS)[number];
export const DEFAULT_SOCIAL_TAB: SocialTab = "posts";

export function isSocialTab(v: string | null): v is SocialTab {
  return v !== null && (SOCIAL_TABS as readonly string[]).includes(v);
}

export interface SocialPageParams {
  tab: SocialTab;
  /** `?post=` — deep-links the post detail sheet open on a `providerPostId`, independent of `tab`. */
  post: string | null;
}

/** Pure: the URL's params, defaulted and validated. Junk reads as absent. */
export function parseSocialPageParams(sp: URLSearchParams): SocialPageParams {
  const tab = sp.get("tab");
  return {
    tab: isSocialTab(tab) ? tab : DEFAULT_SOCIAL_TAB,
    post: sp.get("post") || null,
  };
}

/**
 * The page's last URL write, while it may not have landed yet — copied
 * verbatim from `components/agents-page/use-agents-page-params.ts`. Next puts
 * a `router.replace` URL into history only once that navigation commits, so a
 * second write built from `window.location` right after the first would drop
 * what the first one added. Building from this instead means a tab click
 * right after opening a post (or vice versa) keeps both.
 */
let lastWrite: { from: string; fromState: unknown; query: string } | null = null;

function currentParams(): URLSearchParams {
  const pending =
    lastWrite !== null && window.history.state === lastWrite.fromState && window.location.search === lastWrite.from
      ? lastWrite
      : null;
  lastWrite = pending;
  return new URLSearchParams(pending ? pending.query : window.location.search);
}

function replaceParams(router: ReturnType<typeof useRouter>, pathname: string, params: URLSearchParams): void {
  const query = params.toString();
  lastWrite = { from: window.location.search, fromState: window.history.state, query };
  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
}

/**
 * URL ↔ state sync for the Social page's tab and the post-detail deep link.
 * The URL is the source of truth for back/forward and deep links; a tab click
 * writes it back with `router.replace`. `post` is intentionally NOT cleared on
 * a tab switch — the detail sheet renders outside the `<Tabs>` in `SocialPage`
 * and stays open across tabs, the same way a modal would.
 */
export function useSocialPageParams(): SocialPageParams & {
  setTab: (t: SocialTab) => void;
  setPost: (id: string | null) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlParams = parseSocialPageParams(searchParams);
  const [tab, setTabState] = useState<SocialTab>(urlParams.tab);
  const [prevUrlTab, setPrevUrlTab] = useState(urlParams.tab);
  if (urlParams.tab !== prevUrlTab) {
    setPrevUrlTab(urlParams.tab);
    if (urlParams.tab !== tab) setTabState(urlParams.tab);
  }

  const setTab = useCallback(
    (next: SocialTab) => {
      setTabState(next);
      const params = currentParams();
      params.set("tab", next);
      replaceParams(router, pathname, params);
    },
    [pathname, router],
  );

  const setPost = useCallback(
    (id: string | null) => {
      const params = currentParams();
      if (id) params.set("post", id);
      else params.delete("post");
      replaceParams(router, pathname, params);
    },
    [pathname, router],
  );

  return { ...urlParams, tab, setTab, setPost };
}
