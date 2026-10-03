/** Account music facts (spec §6.3, D8): stored per account, probed when
 *  unknown (and a detected negative re-probed once it is an hour old), and a
 *  user-set TikTok kind is never overwritten by detection. */
import { getAccountMusicFacts, setAccountMusicFacts } from "@/lib/db/settings";
import { isComposablePlatform, type KnownPlatform } from "./catalog";
import type { SocialAdapter } from "./adapter";
import type { AccountMusicFacts, MusicCatalogResult } from "./music-policy";
import { serverLogger as logger } from "@/lib/logger";

export const factsKey = (providerId: string, accountId: string) => `${providerId}:${accountId}`;

export function mergeDetected(stored: AccountMusicFacts, detected: AccountMusicFacts): AccountMusicFacts {
  return {
    ...stored,
    ...(detected.tiktokKind && stored.tiktokKind?.source !== "user" ? { tiktokKind: detected.tiktokKind } : {}),
    ...(detected.instagramFacebookLogin ? { instagramFacebookLogin: detected.instagramFacebookLogin } : {}),
  };
}

/** A detected "no music here" (a personal-lane TikTok, an Instagram-Login
 *  account) is re-checked after this long: the fix is a reconnect in Zernio,
 *  which libi never sees. A catalog read that succeeds (`recordCatalogOutcome`)
 *  does not wait for this. */
export const NEGATIVE_FACT_MAX_AGE_MS = 60 * 60 * 1000;

/** The stored fact for this platform, when it was DETECTED as "no music" (never the user's own choice). */
function detectedNegative(platform: KnownPlatform, f: AccountMusicFacts): { checkedAt: string } | null {
  if (platform === "tiktok" && f.tiktokKind?.source === "detected" && f.tiktokKind.value === "personal") return f.tiktokKind;
  if (platform === "instagram" && f.instagramFacebookLogin?.source === "detected" && f.instagramFacebookLogin.value === false) return f.instagramFacebookLogin;
  return null;
}

function needsProbe(platform: KnownPlatform, f: AccountMusicFacts, opts: ResolveFactsOptions): boolean {
  if (platform === "tiktok" && !f.tiktokKind) return true;
  if (platform === "instagram" && !f.instagramFacebookLogin) return true;
  const negative = detectedNegative(platform, f);
  if (!negative) return false;
  if (opts.recheckNegative) return true;
  const checked = Date.parse(negative.checkedAt);
  // An unreadable timestamp counts as old.
  return !Number.isFinite(checked) || (opts.now ?? new Date()).getTime() - checked > NEGATIVE_FACT_MAX_AGE_MS;
}

export interface ResolveFactsOptions {
  /** Re-probe a detected negative whatever its age — the Social settings read,
   *  so a user who just reconnected sees it on reload. A user-set kind is never re-probed. */
  recheckNegative?: boolean;
  now?: Date;
}

export async function resolveAccountFacts(
  adapter: SocialAdapter,
  providerId: string,
  account: { id: string; platform: KnownPlatform },
  opts: ResolveFactsOptions = {},
): Promise<AccountMusicFacts> {
  const key = factsKey(providerId, account.id);
  const stored = getAccountMusicFacts(key);
  if (!isComposablePlatform(account.platform) || !needsProbe(account.platform, stored, opts)) return stored;
  const detected = await adapter.musicAccountFacts(account.id, account.platform);
  return storeDetected(key, account, stored, detected);
}

/** Merges a detected answer into the stored facts and persists it when it differs. */
function storeDetected(key: string, account: { id: string; platform: KnownPlatform }, stored: AccountMusicFacts, detected: AccountMusicFacts): AccountMusicFacts {
  const merged = mergeDetected(stored, detected);
  if (JSON.stringify(merged) !== JSON.stringify(stored)) {
    setAccountMusicFacts(key, merged);
    // Logged only when the VALUE changes: a re-probe of a negative (every
    // Settings read) that finds the same answer only refreshes `checkedAt`.
    const valueOf = (f: AccountMusicFacts): string | undefined =>
      account.platform === "tiktok"
        ? f.tiktokKind?.value
        : f.instagramFacebookLogin
          ? f.instagramFacebookLogin.value
            ? "facebook_login"
            : "instagram_login"
          : undefined;
    const value = valueOf(merged);
    if (value !== valueOf(stored)) {
      logger.info({ tag: "social-music", op: "account_kind_detected", platform: account.platform, accountId: account.id, value }, "account music facts detected");
    }
  }
  return merged;
}

/** A catalog read the user or agent just made is as good a probe as `musicAccountFacts`
 *  (which is itself one catalog read): a list of tracks proves the account can attach
 *  licensed music, so a cached "no" — the Instagram-Login note a reconnect never cleared —
 *  is replaced at once; a refusal that names the cause records it. Any other failure says
 *  nothing about the account and leaves the fact alone. A user-set TikTok kind is kept. */
export function recordCatalogOutcome(
  providerId: string,
  account: { id: string; platform: KnownPlatform },
  result: MusicCatalogResult,
  now: Date = new Date(),
): void {
  if (!isComposablePlatform(account.platform)) return;
  const checkedAt = now.toISOString();
  let detected: AccountMusicFacts = {};
  if ("tracks" in result) {
    detected =
      account.platform === "tiktok"
        ? { tiktokKind: { value: "business", source: "detected", checkedAt } }
        : { instagramFacebookLogin: { value: true, source: "detected", checkedAt } };
  } else if (account.platform === "instagram" && result.unavailable.reason === "needs_facebook_login") {
    detected = { instagramFacebookLogin: { value: false, source: "detected", checkedAt } };
  } else if (account.platform === "tiktok" && result.unavailable.reason === "not_business") {
    detected = { tiktokKind: { value: "personal", source: "detected", checkedAt } };
  } else return;
  const key = factsKey(providerId, account.id);
  storeDetected(key, account, getAccountMusicFacts(key), detected);
}

export function setUserTikTokKind(providerId: string, accountId: string, value: "business" | "personal"): AccountMusicFacts {
  const key = factsKey(providerId, accountId);
  const next: AccountMusicFacts = { ...getAccountMusicFacts(key), tiktokKind: { value, source: "user", checkedAt: new Date().toISOString() } };
  setAccountMusicFacts(key, next);
  return next;
}
