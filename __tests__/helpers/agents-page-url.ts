/**
 * The Agents page's URL writers build from `window.location` at write time,
 * not from the render's `useSearchParams()`. Tests serve the URL through a
 * `search` string in their `next/navigation` mock; `followSearch` points the
 * address bar at that string, the way it reads once a navigation has landed,
 * and `freshAgentsUrl` starts a test on a history entry of its own, so no write
 * from an earlier test is taken as one still on its way.
 *
 * `followSearch` only calls `replaceState` — and so only mints a new
 * `history.state` object — when the search string actually changes; real Next
 * writes a fresh state object on every commit, even to an unchanged URL. That
 * gap doesn't matter for today's tests, where the pending query always equals
 * the URL's, but a future test that needs a landed write at the SAME address
 * should not read this helper as a faithful model of Next's behaviour there.
 */
export function followSearch(search: string): void {
  const want = search ? `?${search}` : "";
  if (window.location.pathname !== "/agents" || window.location.search !== want) {
    window.history.replaceState({}, "", `/agents${want}`);
  }
}

export function freshAgentsUrl(): void {
  window.history.replaceState({}, "", "/agents");
}
