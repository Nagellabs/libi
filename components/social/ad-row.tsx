"use client";

import { fmtCount } from "@/lib/social/format";
import { platformLabel } from "@/lib/social/catalog";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { PieceAd, SocialAd } from "@/lib/social/types";

/**
 * The ad networks, named. A SEPARATE key space from the posting platforms
 * (`metaads` is not `facebook`), which is why this does not go through
 * `platformLabel` — and why an unknown network renders as its own key rather
 * than being mapped to a platform it is not.
 */
export const NETWORK_LABEL: Record<string, string> = {
  metaads: "Meta Ads",
  googleads: "Google Ads",
  linkedinads: "LinkedIn Ads",
  tiktokads: "TikTok Ads",
  pinterestads: "Pinterest Ads",
  xads: "X Ads",
  openaiads: "OpenAI Ads",
};

/** The posting platform an ad network runs on, for the glyph only. */
export const NETWORK_GLYPH: Record<string, string> = {
  metaads: "facebook",
  tiktokads: "tiktok",
  xads: "twitter",
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400",
  paused: "bg-amber-500/15 text-amber-400",
  archived: "text-muted-foreground line-through",
  deleted: "text-muted-foreground line-through",
};

/** One ad's status, the same chip wherever an ad is drawn. */
export function AdStatusChip({ status }: { status: string }) {
  const s = status.toLowerCase();
  return (
    <span
      data-testid="ad-status-chip"
      data-status={s}
      className={`inline-flex h-5 w-fit shrink-0 items-center rounded-4xl px-2 text-xs font-medium capitalize ${STATUS_STYLE[s] ?? "bg-muted text-muted-foreground"}`}
    >
      {s}
    </span>
  );
}

/** Money, in the ad account's own currency — never converted, never assumed. */
export function money(v: number | undefined, currency: string | undefined): string {
  if (v === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 2 }).format(v);
  } catch {
    // A currency code Intl does not know: show the number and the code as-is
    // rather than dropping either.
    return `${v.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

/**
 * One ad, drawn for the piece it came from.
 *
 * Every metric is rendered only when the provider actually sent it — the ad
 * shape is still unverified against a live ads account
 * (`.superpowers/sdd/zernio-live-shapes.md`), so a missing field must read as
 * missing rather than as a zero the user could act on.
 *
 * Read-only by construction: there is no pause, no budget and no spend control
 * anywhere in this component. libi holds no ads scope, and an affordance the
 * grant cannot honour is worse than none.
 */
export function AdRow({ entry, compact = false }: { entry: PieceAd; compact?: boolean }) {
  const { ad, origin } = entry;
  const m = ad.metrics ?? {};
  const has = (v: number | undefined) => v !== undefined;

  return (
    <div
      data-testid="ad-row"
      data-origin={origin}
      data-status={ad.status}
      className={`rounded-lg border border-border bg-card ${compact ? "p-2.5" : "p-3"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <PlatformIcon platform={NETWORK_GLYPH[ad.network] ?? ad.network} className="size-3" />
        </span>
        <span className="font-medium">{ad.name || "Untitled ad"}</span>
        <span
          data-testid="ad-status-chip"
          className={`rounded-4xl px-2 py-0.5 text-xs ${STATUS_STYLE[ad.status] ?? "bg-muted text-muted-foreground"}`}
        >
          {ad.status}
        </span>
        <span className="rounded-4xl bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="ad-origin-chip">
          {origin === "boosted" ? "boosted post" : "ad only"}
        </span>
        <span className="text-xs text-muted-foreground">{NETWORK_LABEL[ad.network] ?? ad.network}</span>
        {ad.campaignName && <span className="text-xs text-muted-foreground">· {ad.campaignName}</span>}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" data-testid="ad-metrics">
        {has(m.spend) && (
          <Metric label="Spend" value={money(m.spend, ad.currency)} />
        )}
        {has(m.impressions) && <Metric label="Impressions" value={fmtCount(m.impressions)} />}
        {has(m.reach) && <Metric label="Reach" value={fmtCount(m.reach)} />}
        {has(m.clicks) && <Metric label="Clicks" value={fmtCount(m.clicks)} />}
        {has(m.ctr) && <Metric label="CTR" value={`${m.ctr!.toFixed(2)}%`} />}
        {has(m.cpc) && <Metric label="CPC" value={money(m.cpc, ad.currency)} />}
        {has(m.cpm) && <Metric label="CPM" value={money(m.cpm, ad.currency)} />}
        {!Object.values(m).some((v) => v !== undefined) && (
          <span className="text-muted-foreground">No figures reported for this ad yet.</span>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

/** Which posting platform an ad's creative ran on, for a caption. */
export function adPlatformNote(ad: SocialAd): string | null {
  if (ad.effectiveInstagramMediaId) return `Boosting the ${platformLabel("instagram")} post`;
  if (ad.effectiveObjectStoryId) return `Boosting the ${platformLabel("facebook")} post`;
  return null;
}

/** How an ad is named in a list beside the posts: its network and "Ad", the
 *  same "network — type" shape a post gets (`postEntryLabel`). */
export function adEntryLabel(ad: SocialAd): string {
  return `${NETWORK_LABEL[ad.network] ?? ad.network} — Ad`;
}
