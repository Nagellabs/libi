"use client";

import { useGlobalRefreshQuerySubscription } from "@/hooks/use-global-refresh-query-subscription";

/**
 * Mount-point for the layout-level refresh_query subscriber. Returns
 * null — it exists purely so the (app) server-component layout can
 * call a client hook without flipping the whole tree to a client
 * boundary.
 */
export function GlobalRefreshMount() {
  useGlobalRefreshQuerySubscription();
  return null;
}
