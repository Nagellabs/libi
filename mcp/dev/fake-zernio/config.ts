import { readFileSync } from "node:fs";
import { mcpLogger as logger } from "@/lib/logger";

/**
 * Per-scenario overrides for the fake Zernio server, written by the skill-eval
 * harness and pointed at by `LIBI_FAKE_ZERNIO_CONFIG` (the same mechanism as
 * `LIBI_FAKE_FAL_CONFIG`).
 *
 * Every knob here makes the fake do something the LIVE server does in a state
 * the tester cannot reach on demand — a rate limit, a target that refuses, an
 * account with an ads tree. None of them make it more permissive: the recorded
 * schemas, the curated `tools/list` and the `{result: "<repr>"}` envelope are
 * not configurable, because those are what the fake exists to enforce.
 */
export interface FakeZernioConfig {
  /** This platform's target fails on publish, with this provider message. */
  failTarget?: { platform: "instagram" | "tiktok"; errorMessage: string };
  /** The first write answers 429, the next one succeeds. */
  rateLimitOnce?: boolean;
  /**
   * `"qa"` fills the store with a worked example: one post per supported
   * content type, one per status the UI draws differently, posts on the three
   * platforms libi's own composer does not build for, and three ads — two
   * boosting a post and one that never was a post. For looking at the UI, not
   * for assertions.
   */
  seed?: "qa";
  /** The piece id the QA fixture stamps into `metadata.libi.pieceId`. */
  seedPieceId?: string;
  /**
   * Per Instagram story MEDIA id, what `instagram_get_instagram_story_insights`
   * answers. `"unavailable"` is the expired-and-never-captured state; an
   * object is returned as-is. Anything not named here answers `live` zeros.
   */
  storyInsights?: Record<string, "unavailable" | { source: "live" | "cached"; metrics: Record<string, number> }>;
  /** How many `analytics_get_analytics` calls answer "still syncing" first (default 1). */
  analyticsPendingCalls?: number;
  /** The second `posts_create_post` is rejected as duplicate content (409). */
  duplicateOnSecondCreate?: boolean;
  /** A second Instagram account, so a write with no `account_id` is ambiguous. */
  twoInstagramAccounts?: boolean;
  /**
   * A second TikTok privacy level (`MUTUAL_FOLLOW_FRIENDS`), so a scenario can exercise a
   * privacy picker. The live account (`.superpowers/sdd/zernio-live-shapes.md`) offers
   * exactly one — `PUBLIC_TO_EVERYONE` — which is the fake's default; this knob is the only
   * sanctioned way to see a second.
   */
  multiLevelTikTokPrivacy?: boolean;
  /** The Instagram account has a linked ads tree, instead of the live 422. */
  adsEnabled?: boolean;
}

/** Read the per-scenario override config. Unset/invalid → null. */
export function loadScenarioConfig(): FakeZernioConfig | null {
  const p = process.env.LIBI_FAKE_ZERNIO_CONFIG;
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FakeZernioConfig;
  } catch (err) {
    logger.warn({ err, path: p, tag: "fake-zernio", op: "config_unreadable" }, "failed to read LIBI_FAKE_ZERNIO_CONFIG; using defaults");
    return null;
  }
}
