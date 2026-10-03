"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { trackEvent } from "@/lib/analytics/client";

/**
 * The Templates page's two tabs. `public` is a placeholder until the catalog
 * of sub-project 3 exists — it renders its own coming-soon state rather than
 * an empty grid, so "no public templates" never reads as a failure.
 *
 * `?template=` is a deep link from `libi.show({ target: "templates" })`; the grid scrolls
 * that card into view once. `?review=` is the chat's "Review and publish"
 * link: the publish request's review panel is scrolled to and outlined.
 */
export const TEMPLATES_TABS = ["mine", "public"] as const;
export type TemplatesTab = (typeof TEMPLATES_TABS)[number];
export const DEFAULT_TEMPLATES_TAB: TemplatesTab = "mine";

export function isTemplatesTab(v: string | null): v is TemplatesTab {
  return v !== null && (TEMPLATES_TABS as readonly string[]).includes(v);
}

/**
 * How a tab lists its templates: `cards` (the grid) or `list` (a table). One
 * value for both tabs. The URL's `?view=` wins; without one the last choice
 * this browser made (localStorage) applies; else cards.
 */
export const TEMPLATES_VIEWS = ["cards", "list"] as const;
export type TemplatesView = (typeof TEMPLATES_VIEWS)[number];
export const DEFAULT_TEMPLATES_VIEW: TemplatesView = "cards";
/** Under the `libi:` prefix, so Settings' reset-preferences sweep clears it. */
export const VIEW_STORAGE_KEY = "libi:templates-view";

export function isTemplatesView(v: string | null): v is TemplatesView {
  return v !== null && (TEMPLATES_VIEWS as readonly string[]).includes(v);
}

/** Pure: the URL's view, else a valid stored one, else cards. */
export function resolveView(urlView: TemplatesView | null, stored: string | null): TemplatesView {
  if (urlView) return urlView;
  return isTemplatesView(stored) ? stored : DEFAULT_TEMPLATES_VIEW;
}

export interface TemplatesPageParams {
  tab: TemplatesTab;
  /** `?template=` — the card to highlight and scroll to, independent of `tab`. */
  template: string | null;
  /** `?review=` — the publish request whose review panel to scroll to. */
  review: string | null;
  /** `?view=` — null when the URL names none (the stored choice then applies). */
  view: TemplatesView | null;
}

/** Pure: the URL's params, defaulted and validated. Junk reads as absent. */
export function parseTemplatesPageParams(sp: URLSearchParams): TemplatesPageParams {
  const tab = sp.get("tab");
  const view = sp.get("view");
  return {
    tab: isTemplatesTab(tab) ? tab : DEFAULT_TEMPLATES_TAB,
    template: sp.get("template") || null,
    review: sp.get("review") || null,
    view: isTemplatesView(view) ? view : null,
  };
}

/**
 * The page's last URL write, while it may not have landed yet — copied
 * verbatim from `components/social/social-page/use-social-page-params.ts`.
 * Next puts a `router.replace` URL into history only once that navigation
 * commits, so a second write built from `window.location` right after the
 * first would drop what the first one added. Building from this instead means
 * two quick writes keep both.
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
 * The stored view, as an external store: read on the client only (the server
 * snapshot is `undefined` — "not read yet" — so hydration renders the same
 * markup as the server, and the page shows a neutral skeleton rather than
 * commit to Cards and flip to a stored List a frame later), and
 * re-read by every subscriber when `setView` writes it. Storage may be
 * missing or throw (a private window, blocked site data): it then reads as
 * nothing stored, and a write is dropped — the switch still works for the page.
 */
const viewListeners = new Set<() => void>();
function readStoredView(): string | null {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeStoredView(v: TemplatesView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // Not remembered; the URL still carries it.
  }
  for (const l of viewListeners) l();
}
function subscribeStoredView(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

/**
 * URL ↔ state sync for the Templates page's tab and the `?template=` deep
 * link. The URL is the source of truth for back/forward and for what
 * `libi.show({ target: "templates" })` pushes; a tab click writes it back with
 * `router.replace`.
 */
export function useTemplatesPageParams(): Omit<TemplatesPageParams, "view"> & {
  setTab: (t: TemplatesTab) => void;
  /** The view in effect: the URL's, else the stored one, else cards. */
  view: TemplatesView;
  /**
   * True only while the stored choice can't be read yet (the server render and
   * hydration) and nothing else names the view: `view` is then a guess, and
   * the page shows a skeleton that commits to neither layout.
   */
  viewPending: boolean;
  setView: (v: TemplatesView) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlParams = parseTemplatesPageParams(searchParams);
  const [tab, setTabState] = useState<TemplatesTab>(urlParams.tab);
  const [prevUrlTab, setPrevUrlTab] = useState(urlParams.tab);
  if (urlParams.tab !== prevUrlTab) {
    setPrevUrlTab(urlParams.tab);
    if (urlParams.tab !== tab) setTabState(urlParams.tab);
  }
  const stored = useSyncExternalStore<string | null | undefined>(subscribeStoredView, readStoredView, () => undefined);
  // As with the tab: a switch shows at once, before its `router.replace` lands;
  // a later URL change (back/forward) takes over again.
  const [viewOverride, setViewOverride] = useState<TemplatesView | null>(null);
  const [prevUrlView, setPrevUrlView] = useState(urlParams.view);
  if (urlParams.view !== prevUrlView) {
    setPrevUrlView(urlParams.view);
    setViewOverride(null);
  }
  const view = viewOverride ?? resolveView(urlParams.view, stored ?? null);
  const viewPending = stored === undefined && urlParams.view === null && viewOverride === null;

  const setTab = useCallback(
    (next: TemplatesTab) => {
      setTabState(next);
      const params = currentParams();
      params.set("tab", next);
      replaceParams(router, pathname, params);
    },
    [pathname, router, setTabState],
  );

  const setView = useCallback(
    (next: TemplatesView) => {
      setViewOverride(next);
      writeStoredView(next);
      trackEvent("templates_view_switched", { view: next });
      const params = currentParams();
      params.set("view", next);
      replaceParams(router, pathname, params);
    },
    [pathname, router, setViewOverride],
  );

  return { ...urlParams, tab, setTab, view, viewPending, setView };
}
