"use client";

import { AccountsStripSkeleton } from "@/components/social/social-skeletons";
import { AGENT_ONLY_BLURB } from "@/components/social/platform-support";
import { useSocialAccounts, useSocialStatus } from "@/lib/queries/social";
import { useSocialMusicFacts, useSetTikTokKind } from "@/lib/queries/social-music";
import { isComposablePlatform, platformLabel } from "@/lib/social/catalog";
import { PlatformBadge } from "@/components/social/platform-icon";
import type { SocialAccount } from "@/lib/social/types";
import type { AccountMusicFacts } from "@/lib/social/music-policy";

/**
 * Deliberately NO expiry countdown anywhere in this card. TikTok's token
 * legitimately expires daily and Zernio refreshes it silently; Instagram's
 * lasts ~59 days — a "expires in N days" line would just be background noise
 * for a token that was never actually at risk. Reconnect is shown ONLY from
 * an OBSERVED `needsReconnection` (`health.status === "reconnect"`,
 * synthesized in `normalize.ts#accountHealthFromRow` from that exact field),
 * never derived from how close `tokenExpiresAt` is.
 */
export function AccountsStrip() {
  const accounts = useSocialAccounts();
  const status = useSocialStatus();
  const musicFacts = useSocialMusicFacts();
  const setKind = useSetTikTokKind();

  if (accounts.isLoading) return <AccountsStripSkeleton />;

  const list = accounts.data ?? [];
  const dashboardUrl = status.data?.catalog.find((c) => c.id === status.data?.providerId)?.dashboardUrl;

  return (
    <div data-testid="accounts-strip" className="flex flex-wrap gap-3">
      {list.map((a) => (
        <div key={a.id} data-testid="account-card" className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-3 text-sm">
          <PlatformBadge platform={a.platform} />
          <div>
            <p className="font-medium leading-tight">@{a.username}</p>
            {/* Zernio only connects Instagram Business/Creator accounts (the
                Graph API requires one to post) — "Business" here is that
                platform fact, not a per-account field the provider echoes.
                Every other platform is named from the catalog: the old
                two-way ternary labelled a connected Facebook or YouTube
                account "TikTok". */}
            <p className="text-xs leading-tight text-muted-foreground">
              {a.platform === "instagram" ? "Instagram · Business" : platformLabel(a.platform)}
              {!isComposablePlatform(a.platform) && (
                <span data-testid="agent-only-account" title={AGENT_ONLY_BLURB} className="ml-1.5 cursor-default rounded-4xl bg-muted px-1.5 py-0.5">
                  agent only
                </span>
              )}
            </p>
            {a.health?.status === "reconnect" ? (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-block cursor-pointer text-xs text-amber-500 hover:underline"
              >
                Reconnect at Zernio ↗
              </a>
            ) : a.health?.status === "healthy" ? (
              <span className="mt-0.5 inline-block text-xs text-emerald-500">ok</span>
            ) : null}
            {(a.platform === "tiktok" || a.platform === "instagram") && (
              <AccountMusicLine account={a} facts={musicFacts.data?.facts[a.id]} dashboardUrl={dashboardUrl} onKind={(v) => setKind.mutate({ accountId: a.id, tiktokKind: v })} />
            )}
          </div>
        </div>
      ))}
      {list.length >= 2 && (
        <a
          href={dashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="connect-another-account"
          className="flex cursor-pointer flex-col items-start justify-center gap-0.5 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground hover:border-primary hover:text-primary"
        >
          <span>+ Connect another at Zernio ↗</span>
          <span className="text-xs">Free plan: 2 of 2 used</span>
        </a>
      )}
    </div>
  );
}

function AccountMusicLine({
  account,
  facts,
  dashboardUrl,
  onKind,
}: {
  account: SocialAccount;
  facts: AccountMusicFacts | undefined;
  dashboardUrl: string | undefined;
  onKind: (v: "business" | "personal") => void;
}) {
  if (account.platform === "tiktok") {
    const k = facts?.tiktokKind;
    const text = k ? `TikTok · ${k.value === "business" ? "Business" : "Personal"}${k.source === "detected" ? " (detected)" : ""}` : "TikTok · type unknown";
    return (
      <p data-testid={`account-music-${account.id}`} className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {text}
        <select
          data-testid={`tiktok-kind-${account.id}`}
          aria-label="TikTok account type"
          value={k?.value ?? ""}
          onChange={(e) => onKind(e.target.value as "business" | "personal")}
          className="cursor-pointer rounded border border-border bg-background px-1 py-0.5 text-xs"
        >
          {!k && <option value="">Choose…</option>}
          <option value="business">Business</option>
          <option value="personal">Personal</option>
        </select>
      </p>
    );
  }
  const fb = facts?.instagramFacebookLogin;
  return (
    <p data-testid={`account-music-${account.id}`} className="mt-0.5 text-xs text-muted-foreground">
      {fb?.value === true ? (
        "Music: available"
      ) : fb?.value === false ? (
        <>
          Music needs Facebook Login —{" "}
          <a href={dashboardUrl} target="_blank" rel="noopener noreferrer" className="cursor-pointer text-amber-500 hover:underline">
            Reconnect at Zernio
          </a>{" "}
          and choose Facebook
        </>
      ) : null}
    </p>
  );
}
