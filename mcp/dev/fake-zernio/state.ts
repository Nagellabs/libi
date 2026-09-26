import { randomUUID } from "node:crypto";
import type { FakeZernioConfig } from "./config";
import { applyQaSeed } from "./qa-seed";

export type Row = Record<string, unknown>;

/**
 * The two connected accounts, in the LIVE row shape (`fixtures/account.json`,
 * read off the user's own account on 2026-09-20): `_id`, `profileId` as an
 * OBJECT, `tokenExpiresAt` and `needsReconnection` present, `isActive`.
 *
 * `profileId` being an object here and a STRING on the analytics endpoint is
 * Zernio's, not a slip — both spellings are exercised by this fake on purpose.
 */
export const IG_ACCOUNT: Row = {
  _id: "6aae6b468d284ffb211ade1e",
  platform: "instagram",
  username: "nagellabs",
  displayName: "Nagel Labs",
  profilePicture: "https://cdn.example/ig-avatar.jpg",
  profileUrl: "https://www.instagram.com/nagellabs/",
  isActive: true,
  enabled: true,
  needsReconnection: false,
  permissions: ["instagram_content_publish", "instagram_manage_insights"],
  platformStatus: "active",
  platformStatusReason: null,
  platformUserId: "17841400000000001",
  tokenExpiresAt: "2026-11-18T11:00:22.425Z",
  followersCount: 4218,
  externalPostCount: 137,
  adsStatus: "connected",
  rateLimitCount: 0,
  profileId: { _id: "6aae6a1e8d284ffb211adc02", name: "Nagel Labs" },
  metadata: { profileData: { extraData: { accountType: "BUSINESS" } } },
};

export const TT_ACCOUNT: Row = {
  _id: "6aae6ba98d284ffb211ae03a",
  platform: "tiktok",
  username: "nagellabs",
  displayName: "Nagel Labs",
  profilePicture: "https://cdn.example/tt-avatar.jpg",
  profileUrl: "https://www.tiktok.com/@nagellabs",
  isActive: true,
  enabled: true,
  needsReconnection: false,
  permissions: ["video.publish", "video.list"],
  platformStatus: "active",
  platformStatusReason: null,
  platformUserId: "tt_user_0001",
  tokenExpiresAt: "2026-11-02T08:15:00.000Z",
  followersCount: 1190,
  externalPostCount: 22,
  adsStatus: "not_connected",
  rateLimitCount: 0,
  profileId: { _id: "6aae6a1e8d284ffb211adc02", name: "Nagel Labs" },
};

/** A SECOND Instagram account, so a write with no `account_id` is ambiguous. */
export const IG_ACCOUNT_2: Row = {
  ...IG_ACCOUNT,
  _id: "6aae6b468d284ffb211ade1f",
  username: "nagellabs.studio",
  displayName: "Nagel Labs Studio",
  profileUrl: "https://www.instagram.com/nagellabs.studio/",
};

export interface FakeState {
  cfg: FakeZernioConfig;
  accounts: Row[];
  posts: Map<string, Row>;
  /** Ad campaigns, keyed by id. Only reachable when `cfg.adsEnabled`. */
  campaigns: Map<string, Row>;
  /** Individual ads, keyed by id — what `ad_campaigns_list_ads` serves. */
  ads: Map<string, Row>;
  adAccounts: Map<string, Row>;
  /** Presigned upload key → the bytes a PUT actually delivered. */
  uploads: Map<string, Buffer>;
  /** post id → how many times analytics has been asked for it. */
  analyticsCalls: Map<string, number>;
  rateLimited: boolean;
  createCount: number;
}

export function createFakeState(cfg: FakeZernioConfig | null = null): FakeState {
  const config = cfg ?? {};
  const accounts: Row[] = [IG_ACCOUNT, TT_ACCOUNT, ...(config.twoInstagramAccounts ? [IG_ACCOUNT_2] : [])];
  // Field shapes here are NOT live-verified — no ad account is connected to
  // the user's Zernio workspace, so `ad_accounts_list_ad_accounts` has only
  // ever answered the `linked_account_required` 422. They follow the brief's
  // spelling and `fixtures/campaigns.json`; treat them as a placeholder that
  // exercises the seam, not as recorded truth.
  const adAccounts = new Map<string, Row>([
    ["act_1234", { _id: "act_1234", network: "meta", name: "Nagel Labs ads", currency: "USD", isActive: true }],
  ]);
  const campaigns = new Map<string, Row>([
    ["camp_1", {
      _id: "camp_1", adAccountId: "act_1234", network: "meta", name: "Desk setup — launch",
      status: "ACTIVE", reviewStatus: "approved", objective: "OUTCOME_ENGAGEMENT",
      budgetAmount: 10, budgetType: "daily", currency: "USD", startDate: "2026-09-15", endDate: "2026-09-30",
      metrics: { spend: 88.4, impressions: 41000, clicks: 940, ctr: 2.3, cpc: 0.19, cpm: 2.1 },
    }],
    ["camp_2", {
      _id: "camp_2", adAccountId: "act_1234", network: "meta", name: "Retarget — watchers",
      status: "PAUSED", reviewStatus: "rejected",
      budgetAmount: 50, budgetType: "lifetime", currency: "USD",
      metrics: { spend: 0, impressions: 0, clicks: 0 },
    }],
  ]);
  const state: FakeState = {
    cfg: config,
    accounts,
    posts: new Map(),
    campaigns,
    ads: new Map(),
    adAccounts,
    uploads: new Map(),
    analyticsCalls: new Map(),
    rateLimited: false,
    createCount: 0,
  };
  // The QA fixture: a piece that has done everything on social, for looking at
  // the UI with real-shaped data instead of one lonely post.
  if (config.seed === "qa") applyQaSeed(state, config.seedPieceId ?? "qa-piece");
  return state;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * The account row for an id, or `null`. Used to expand a write body's STRING
 * `accountId` into the OBJECT the posts endpoints answer with — the live
 * asymmetry `toPost` exists to absorb.
 */
export function accountById(state: FakeState, id: unknown): Row | null {
  return state.accounts.find((a) => a._id === id) ?? null;
}

/** The short account object a post's `platforms[].accountId` carries live. */
export function accountRef(account: Row): Row {
  return {
    _id: account._id,
    platform: account.platform,
    username: account.username,
    displayName: account.displayName,
    profilePicture: account.profilePicture,
    profileId: (account.profileId as Row)?._id,
    isActive: account.isActive,
  };
}
