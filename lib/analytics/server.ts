// lib/analytics/server.ts
// Server-side GA4 transport via the Measurement Protocol (the only official
// server path — a plain HTTPS POST). Used by the Next server + (via the
// /api/analytics/event route) the MCP process. Fire-and-forget; never throws.
//
// SERVER-ONLY: this module is server-bound by construction — it imports
// `@/lib/db/settings` (better-sqlite3) and the pino server logger, neither of
// which can run in a browser bundle. We deliberately do NOT add the
// `server-only` package import: it is not resolvable under this repo's vitest
// setup (the unit test imports `buildMpPayload`/`trackServerEvent` directly), and
// the DB import already prevents any accidental client-bundle inclusion.

import { ANALYTICS_DEBUG, ANALYTICS_ENABLED, GA4_API_SECRET, MEASUREMENT_ID } from "./config";
import { sanitizeParams } from "./events";
import { getAnalyticsSettings, getOrCreateAnalyticsUserId } from "@/lib/db/settings";
import type { AnalyticsSettings } from "@/lib/analytics/settings-logic";
import { isTestMode } from "@/lib/test-mode";
import { serverLogger as logger } from "@/lib/logger";

export interface MpPayload {
  client_id: string;
  user_id: string;
  events: { name: string; params: Record<string, unknown> }[];
}

export function buildMpPayload(
  userId: string,
  name: string,
  params: Record<string, unknown> | undefined,
  debug: boolean,
): MpPayload {
  const clean = sanitizeParams(params);
  return {
    client_id: userId,
    user_id: userId,
    events: [{ name, params: debug ? { ...clean, debug_mode: true } : clean }],
  };
}

interface Deps {
  fetchImpl?: typeof fetch;
  getSettings?: () => AnalyticsSettings;
  apiSecret?: string;
  enabled?: boolean;
  debug?: boolean;
}

let warnedNoSecret = false;

/** Send one GA4 event server-side. Honors config + opt-out. Never throws. */
export async function trackServerEvent(
  name: string,
  params?: Record<string, unknown>,
  deps: Deps = {},
): Promise<void> {
  const enabled = deps.enabled ?? ANALYTICS_ENABLED;
  const debug = deps.debug ?? ANALYTICS_DEBUG;
  const apiSecret = deps.apiSecret ?? GA4_API_SECRET;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getSettings = deps.getSettings ?? getAnalyticsSettings;

  if (!enabled || isTestMode()) return;
  if (!apiSecret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      logger.warn({ tag: "analytics", op: "no_api_secret" }, "GA4 api_secret unset — server events disabled");
    }
    return;
  }

  let userId: string;
  try {
    const s = getSettings();
    if (!s.enabled) return;
    userId = s.userId ?? getOrCreateAnalyticsUserId();
  } catch {
    return;
  }

  const path = debug ? "debug/mp/collect" : "mp/collect";
  const url = `https://www.google-analytics.com/${path}?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildMpPayload(userId, name, params, debug)),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Fire-and-forget — network failures must never affect callers.
  }
}
