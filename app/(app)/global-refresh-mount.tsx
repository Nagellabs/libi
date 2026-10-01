"use client";

import { useGlobalRefreshQuerySubscription } from "@/hooks/use-global-refresh-query-subscription";
import { useExportFinishToasts } from "@/hooks/exports/use-export-finish-toasts";

/**
 * Mount-point for the layout-level refresh_query subscriber and the export finish toasts. Returns
 * null — it exists purely so the (app) server-component layout can
 * call a client hook without flipping the whole tree to a client
 * boundary.
 */
export function GlobalRefreshMount() {
  useGlobalRefreshQuerySubscription();
  useExportFinishToasts();
  return null;
}
