"use client";

import { useEffect, useRef } from "react";

import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useTikTokCreatorInfo } from "@/lib/queries/social";
import type { TikTokCreatorInfo, TikTokOptions } from "@/lib/social/types";
import { mmss, type TikTokConsent } from "./types";

/**
 * TikTok's own words for the privacy levels it returned. An unmapped value is
 * shown RAW — never dropped, never renamed: the list comes from the account's
 * creator info and this account really does offer only `PUBLIC_TO_EVERYONE`.
 */
const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Public",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

const INTERACTIONS: Array<{ key: keyof TikTokCreatorInfo["interactions"]; label: string; field: "allowComment" | "allowDuet" | "allowStitch" }> = [
  { key: "allow_comment", label: "Comments", field: "allowComment" },
  { key: "allow_duet", label: "Duet", field: "allowDuet" },
  { key: "allow_stitch", label: "Stitch", field: "allowStitch" },
];

const COMMERCIAL: Array<{ value: TikTokOptions["commercialContentType"]; label: string }> = [
  { value: "none", label: "None" },
  { value: "brand_organic", label: "Brand organic" },
  { value: "brand_content", label: "Branded content" },
];

/**
 * Step 2, TikTok half. Everything here is rendered FROM the account's live
 * creator info — the privacy levels, the interaction defaults, whether the
 * account may post at all. Nothing is hardcoded, because this account's real
 * answer (one privacy level, all three interactions required and off) is not
 * the list TikTok's docs describe.
 */
export function TargetTikTok({
  accountId,
  options,
  consent,
  durationSeconds,
  onChange,
  onConsentChange,
  onInfo,
}: {
  accountId: string;
  options: TikTokOptions;
  consent: TikTokConsent;
  durationSeconds?: number;
  onChange: (next: TikTokOptions) => void;
  onConsentChange: (next: TikTokConsent) => void;
  onInfo?: (info: TikTokCreatorInfo) => void;
}) {
  const info = useTikTokCreatorInfo(accountId);
  const data = info.data;

  // Lifted so the composer can gate Next on what TikTok answered
  // (`canPostMore`) without a second copy of this query's plumbing. In an
  // effect, never in render: a parent setState during a child's render is a
  // React error, not a style preference. The callback is held in a ref so an
  // inline arrow from the parent cannot re-fire this on every render — which
  // is an infinite loop when the parent reacts by setting state.
  const onInfoRef = useRef(onInfo);
  useEffect(() => {
    onInfoRef.current = onInfo;
  }, [onInfo]);
  useEffect(() => {
    if (data) onInfoRef.current?.(data);
  }, [data]);

  if (info.isLoading || !data) {
    if (info.error) {
      return (
        <p className="text-sm text-destructive" data-testid="tiktok-creator-info-error">
          TikTok&apos;s posting options for this account could not be read, so libi can&apos;t offer them.
        </p>
      );
    }
    return (
      <div className="space-y-2" data-testid="tiktok-creator-info-skeleton">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  const blocked = data.canPostMore === false;
  const tooLong = durationSeconds !== undefined && durationSeconds > data.maxVideoSeconds;

  return (
    <div className="space-y-3" data-testid="target-tiktok">
      {blocked && (
        <p className="text-sm text-destructive" data-testid="tiktok-cannot-post">
          TikTok says this account can&apos;t post more right now
        </p>
      )}

      <div role="radiogroup" aria-label="Who can see this" className="space-y-1">
        {data.privacyLevels.map((level) => (
          <label key={level} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name={`tiktok-privacy-${accountId}`}
              className="cursor-pointer"
              value={level}
              disabled={blocked}
              checked={options.privacyLevel === level}
              onChange={() => onChange({ ...options, privacyLevel: level })}
            />
            {PRIVACY_LABEL[level] ?? level}
          </label>
        ))}
      </div>

      <div className="space-y-2">
        {INTERACTIONS.map((i) => {
          // `enabled: false` is the account not being ALLOWED this interaction.
          // `required` is about the field having to be present in the request
          // body and says nothing the user can act on — it used to render as
          // "(required by TikTok)" beside a switch that was off, which read as
          // TikTok forcing something it was not.
          const allowed = data.interactions[i.key]?.enabled !== false;
          return (
            <label key={i.key} className="flex items-center gap-2 text-sm">
              <Switch
                data-testid={`tiktok-${i.key}`}
                disabled={blocked || !allowed}
                checked={allowed && options[i.field]}
                onCheckedChange={(v: boolean) => onChange({ ...options, [i.field]: v })}
              />
              {i.label}
              {!allowed && <span className="text-xs text-muted-foreground">(not available on this account)</span>}
            </label>
          );
        })}
      </div>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Commercial content</span>
        <div className="flex overflow-hidden rounded-lg border border-border">
          {COMMERCIAL.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={blocked}
              aria-pressed={options.commercialContentType === c.value}
              data-testid={`tiktok-commercial-${c.value}`}
              onClick={() => onChange({ ...options, commercialContentType: c.value })}
              className={`cursor-pointer px-3 py-1 text-xs ${
                options.commercialContentType === c.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Switch
          data-testid="tiktok-ai-label"
          disabled={blocked}
          checked={options.madeWithAi === true}
          onCheckedChange={(v: boolean) => onChange({ ...options, madeWithAi: v })}
        />
        AI-generated label
      </label>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 cursor-pointer"
            data-testid="tiktok-consent-preview"
            disabled={blocked}
            checked={consent.preview}
            onChange={(e) => onConsentChange({ ...consent, preview: e.target.checked })}
          />
          {/* The wire fields behind these two are `content_preview_confirmed`
              and `express_consent_given`; TikTok requires both, and the
              MEANING is what has to reach the user — the identifiers used to
              be printed underneath, which is developer vocabulary in a
              consent block (QA 2026-09-21, finding 8). */}
          <span>
            I have previewed this post and confirm it is what I want to publish.
            <span className="ml-1 block text-[0.7rem] text-muted-foreground">
              TikTok requires this before anything is published from another app.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 cursor-pointer"
            data-testid="tiktok-consent-express"
            disabled={blocked}
            checked={consent.express}
            onChange={(e) => onConsentChange({ ...consent, express: e.target.checked })}
          />
          <span>
            I agree to TikTok&apos;s Music Usage Confirmation and consent to this post being published.
            <span className="ml-1 block text-[0.7rem] text-muted-foreground">
              Your explicit consent, which TikTok requires for a post made outside its own app.
            </span>
          </span>
        </label>
      </div>

      {tooLong && (
        <p className="text-sm text-destructive" data-testid="tiktok-too-long">
          TikTok caps this account at {mmss(data.maxVideoSeconds)}; this export is {mmss(durationSeconds!)}.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Publishing to TikTok is public on this account. A Zernio draft reaches TikTok only when you publish it here.
      </p>
    </div>
  );
}
