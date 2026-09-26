"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectLibiEmptyState } from "@/components/social/connect-libi-empty-state";
import { PostDetailSheet } from "@/components/social/post-detail-sheet";
import { PostListSkeleton } from "@/components/social/social-skeletons";
import { trackEvent } from "@/lib/analytics/client";
import { useProviders } from "@/lib/queries/providers";
import { SocialApiError, retryAtFor, useSocialStatus, useUpdateSocialSettings, type SocialStatusResponse } from "@/lib/queries/social";
import type { SocialProviderId } from "@/lib/social/catalog";
import { AdsTab } from "@/components/social/social-page/ads-tab";
import { PostsTab } from "@/components/social/social-page/posts-tab";
import { ScheduleTab } from "@/components/social/social-page/schedule-tab";
import { SettingsTab } from "@/components/social/social-page/settings-tab";
import { SOCIAL_TABS, type SocialTab, useSocialPageParams } from "@/components/social/social-page/use-social-page-params";

/**
 * Two independent dots on one chip: the AGENT's own Zernio sign-in (read from
 * `useProviders()`, never libi's) and libi's OWN grant for this page. They are
 * deliberately never merged into one status — a user can have either without
 * the other, and the Settings tab explains why.
 */
export function ProviderChip({ name, agentDot, libiDot }: { name: string; agentDot: boolean; libiDot: boolean }) {
  return (
    <div data-testid="social-provider-chip" className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-1.5 text-xs">
      <span className="font-medium">{name}</span>
      <span className="flex items-center gap-1 text-muted-foreground" title="Your agent's own Zernio sign-in">
        <span className={`size-1.5 rounded-full ${agentDot ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
        agent
      </span>
      <span className="flex items-center gap-1 text-muted-foreground" title="libi's own Zernio connection">
        <span className={`size-1.5 rounded-full ${libiDot ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
        libi
      </span>
    </div>
  );
}

/**
 * A data tab's own query error, rendered as ONE banner when it is a 429. The
 * query's own `retry` is off for 401/429 (`lib/queries/social.ts`), so this is
 * the only place a rate limit ever shows up — never a toast storm.
 */
export function RateLimitBanner({ error }: { error: unknown }) {
  if (!(error instanceof SocialApiError) || error.status !== 429) return null;
  const retryAt = retryAtFor(error);
  const when = retryAt
    ? new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "an unknown time";
  return (
    <div
      data-testid="social-rate-limit-banner"
      className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-500"
    >
      Provider rate limit reached (free plan: 60 requests/min). Retrying at {when}.
    </div>
  );
}

/**
 * Shown before any provider is chosen. Picking one saves the whole settings
 * object (the route rejects a partial PUT) with sane defaults — the same
 * radio + explainer the Settings tab's Provider section repeats once a
 * provider is already chosen.
 */
export function ProviderPicker({ catalog }: { catalog: SocialStatusResponse["catalog"] }) {
  const update = useUpdateSocialSettings();
  const [picked, setPicked] = useState<string>(catalog[0]?.id ?? "");
  const pickedName = catalog.find((p) => p.id === picked)?.name ?? "a provider";

  return (
    <div data-testid="social-provider-picker" className="mx-auto max-w-md space-y-4 rounded-lg border border-border bg-card p-5 text-sm">
      <p className="font-medium">Pick a provider</p>
      <div role="radiogroup" aria-label="Social provider" className="space-y-2">
        {catalog.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="social-provider-picker"
              className="cursor-pointer"
              checked={picked === p.id}
              onChange={() => setPicked(p.id)}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
        <li>Pick {pickedName}.</li>
        <li>Add it to your agent on the Providers tab — that&apos;s what lets your agent post.</li>
        <li>Connect libi itself below: a separate, one-time browser sign-in just for this page.</li>
      </ol>
      {/* Said before anyone signs up for anything: libi's part is free, the
          provider's is not necessarily. "Free social posting" with a bill
          from a third party a month later is the thing to avoid. */}
      <p className="text-xs text-muted-foreground" data-testid="social-provider-cost-note">
        libi charges nothing for this. {pickedName} is a separate service with its own plans and may bill
        you — Zernio, for example, charges per connected account after a free allowance. Check its pricing
        before connecting more accounts.
      </p>
      <Button
        className="cursor-pointer"
        disabled={!picked || update.isPending}
        onClick={() =>
          update.mutate({
            providerId: picked as SocialProviderId,
            timezone: null,
            defaults: { instagramType: "reel", aiLabel: true },
            pollSeconds: 30,
          })
        }
      >
        {update.isPending ? "Saving…" : "Continue"}
      </Button>
    </div>
  );
}

export function SocialPage() {
  const { tab, setTab, post, setPost } = useSocialPageParams();
  const status = useSocialStatus();
  const st = status.data;
  const providers = useProviders({ enabled: !!st?.providerId, refetchInterval: false });

  useEffect(() => {
    trackEvent("social_page_viewed", { tab });
  }, [tab]);

  const gate = !st ? "loading" : !st.providerId ? "no-provider" : st.needsReconnect ? "revoked" : !st.connected ? "never" : "ok";
  const agentConnected = !!providers.data?.connected.some((r) => r.providerId === st?.providerId && r.status === "connected");

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Social</h1>
          <p className="text-sm text-muted-foreground">
            Posts and ads on your provider&apos;s servers, shown here. Compose inside a piece: open it and use its Posting tab.
          </p>
        </div>
        {st?.providerId && (
          <ProviderChip
            name={st.catalog.find((c) => c.id === st.providerId)?.name ?? st.providerId}
            agentDot={agentConnected}
            libiDot={st.connected}
          />
        )}
      </header>

      {gate === "no-provider" ? (
        <ProviderPicker catalog={st!.catalog} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as SocialTab)}>
          {/* The editor panel's tab row, exactly (`components/editor/editor-panel.tsx`):
              the default `Tabs` variant inside a `bg-muted` bar with a bottom
              rule. The page used `variant="line"`, which is the only tab row in
              the app that looked like that — two different tab treatments on two
              pages reads as two different products. */}
          <div className="-mx-6 mb-4 flex items-center border-b border-border bg-muted px-6">
            <TabsList className="bg-transparent">
              {SOCIAL_TABS.map((t) => (
                <TabsTrigger key={t} value={t} className="cursor-pointer capitalize">
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {tab === "settings" ? (
            <SettingsTab />
          ) : gate === "loading" ? (
            <PostListSkeleton />
          ) : gate !== "ok" ? (
            <ConnectLibiEmptyState variant={gate} />
          ) : tab === "posts" ? (
            <PostsTab onOpen={setPost} />
          ) : tab === "schedule" ? (
            <ScheduleTab onOpen={setPost} />
          ) : (
            <AdsTab onOpen={setPost} />
          )}
        </Tabs>
      )}

      <PostDetailSheet postId={post} onClose={() => setPost(null)} />
    </div>
  );
}
