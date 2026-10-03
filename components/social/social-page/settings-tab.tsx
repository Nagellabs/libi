"use client";

import { useState } from "react";
import Link from "next/link";
import { AccountsStrip } from "@/components/social/social-page/accounts-strip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ConnectLibiEmptyState } from "@/components/social/connect-libi-empty-state";
import { PlatformSupport } from "@/components/social/platform-support";
import { SETUP_AGENTS } from "@/lib/agents/setup/registry";
import { useProviders } from "@/lib/queries/providers";
import {
  useConnectLibi,
  useDisconnectLibi,
  useReindexLinks,
  useSocialAccounts,
  useSocialStatus,
  useUpdateSocialSettings,
} from "@/lib/queries/social";
import type { SocialSettings } from "@/lib/db/settings";
import type { InstagramPostType, SocialProviderId } from "@/lib/social/catalog";

const AGENT_KEY: Record<string, "claude" | "codex"> = { "claude-code": "claude", codex: "codex" };
const TOKEN_WHERE_LABEL: Record<"keychain" | "file", string> = {
  keychain: "Kept in your keychain",
  file: "Kept in a private file in your libi home",
};
const INSTAGRAM_TYPES: InstagramPostType[] = ["reel", "feed", "story"];
const INSTAGRAM_TYPE_LABEL: Record<InstagramPostType, string> = { reel: "Reel", feed: "Feed", story: "Story" };

export function SettingsTab({ focusAccountId = null }: { focusAccountId?: string | null } = {}) {
  const status = useSocialStatus();
  const providers = useProviders();
  const update = useUpdateSocialSettings();
  const disconnect = useDisconnectLibi();
  const reconnect = useConnectLibi();
  const reindex = useReindexLinks();
  const accountsCheck = useSocialAccounts(false);

  const [timezoneDraft, setTimezoneDraft] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const st = status.data;

  // The previous-value-compare-during-render pattern: a provider switch (or
  // any other write elsewhere) invalidates `status`, and the incoming server
  // timezone should win over a draft that was never actually edited further.
  const [prevServerTimezone, setPrevServerTimezone] = useState<string | null | undefined>(st?.settings.timezone);
  if (st && st.settings.timezone !== prevServerTimezone) {
    setPrevServerTimezone(st.settings.timezone);
    setTimezoneDraft(null);
  }

  if (!st) {
    return (
      <div className="space-y-6 pt-4" data-testid="social-settings-skeleton">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const timezone = timezoneDraft ?? st.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const saveSettings = (patch: Partial<SocialSettings>) => update.mutate({ ...st.settings, ...patch });

  const dashboardUrl = st.catalog.find((c) => c.id === st.providerId)?.dashboardUrl;

  return (
    <div className="space-y-6 pt-4">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Provider</h2>
        <div role="radiogroup" aria-label="Social provider" className="space-y-1.5">
          {st.catalog.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="social-provider-settings"
                className="cursor-pointer"
                checked={st.settings.providerId === p.id}
                onChange={() => saveSettings({ providerId: p.id as SocialProviderId })}
              />
              {p.name}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Switching keeps each provider&apos;s post links; posts live on the provider you made them with.
        </p>
      </section>

      <PlatformSupport />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Agent connection</h2>
        <p className="text-xs text-muted-foreground">
          Your agent signs in to Zernio itself (browser). It posts, drafts and runs ads with the accounts you
          connected there. libi never sees that sign-in. New chats pick it up.
        </p>
        <div className="space-y-1.5">
          {SETUP_AGENTS.map((agent) => {
            const row = providers.data?.connected.find((r) => r.agent === AGENT_KEY[agent.id] && r.providerId === st.providerId);
            const connected = row?.status === "connected";
            const label = connected ? "Connected" : row ? "Added · sign in to use" : "Not added";
            const cta = connected ? "Manage on Providers" : row ? "Sign in" : "Add";
            const href = `/agents?tab=providers&provider=${st.providerId}&setupAgent=${agent.id}`;
            return (
              <div
                key={agent.id}
                data-testid={`agent-connection-row-${agent.id}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span>{agent.name}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">{label} ·</span>
                  <Link href={href} className="cursor-pointer text-primary hover:underline">
                    {cta}
                  </Link>
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-2" data-testid="libi-connection-section">
        <h2 className="text-sm font-medium">libi&apos;s connection</h2>
        {!st.connected ? (
          <ConnectLibiEmptyState variant={st.needsReconnect ? "revoked" : "never"} />
        ) : (
          <div className="space-y-2.5 rounded-lg border border-border p-3 text-sm">
            <p>
              Connected as <span className="font-medium">{st.catalog.find((c) => c.id === st.providerId)?.name ?? st.providerId}</span>
              {st.connectedAt ? ` since ${new Date(st.connectedAt).toLocaleDateString()}` : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {st.scopes.map((s) => (
                <span key={s} className="inline-flex items-center rounded-4xl bg-muted px-2 py-0.5 text-xs">
                  {s}
                </span>
              ))}
            </div>
            {st.lastVerifiedAt && (
              <p className="text-xs text-muted-foreground">Last verified {new Date(st.lastVerifiedAt).toLocaleString()}</p>
            )}
            {st.tokenWhere && <p className="text-xs text-muted-foreground">{TOKEN_WHERE_LABEL[st.tokenWhere]}.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={accountsCheck.isFetching}
                onClick={() => void accountsCheck.refetch()}
              >
                {accountsCheck.isFetching ? "Verifying…" : "Verify"}
              </Button>
              {accountsCheck.data && (
                <span className="text-xs text-muted-foreground">
                  {accountsCheck.data.length} account{accountsCheck.data.length === 1 ? "" : "s"}
                </span>
              )}
              {/* Reconnect WHILE CONNECTED. There was no way to do this from
                  the UI — Connect/Reconnect renders only when libi is
                  disconnected — so a grant that still says "connected" but has
                  lost a scope, or a sign-in that needs redoing for any other
                  reason, had no route but Disconnect first (QA 2026-09-21,
                  finding 11). Starting a sign-in invalidates nothing: the
                  current grant stays live and is replaced only when a new one
                  completes, so this is not a destructive button. */}
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                data-testid="social-reconnect"
                disabled={reconnect.isPending}
                onClick={() => {
                  void reconnect.mutateAsync().then(({ url }) => window.open(url, "_blank", "noopener"));
                }}
              >
                {reconnect.isPending ? "Opening your browser…" : "Reconnect"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer text-destructive"
                onClick={() => setDisconnectOpen(true)}
              >
                Disconnect
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Reconnect signs in again in your browser and replaces this grant only once it finishes — your current
              connection keeps working until then.
            </p>
            <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect libi from Zernio?</AlertDialogTitle>
                  <AlertDialogDescription render={<div />}>
                    <span>Your agent&apos;s connection stays. To revoke at Zernio as well, open your </span>
                    <a
                      href={dashboardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cursor-pointer text-primary underline"
                    >
                      Zernio dashboard ↗
                    </a>
                    <span>.</span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      disconnect.mutate();
                      setDisconnectOpen(false);
                    }}
                  >
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </section>

      {/* The connected accounts, each with its own health — moved here from
          the retired Dashboard tab, so "is everything connected?" has ONE
          answer in one place (QA 2026-09-22). */}
      {st.connected && (
        <section className="space-y-2" data-testid="social-accounts-section">
          <h2 className="text-sm font-medium">Connected accounts</h2>
          <AccountsStrip focusAccountId={focusAccountId} />
        </section>
      )}

      <section className="space-y-3" data-testid="social-defaults">
        <h2 className="text-sm font-medium">Defaults</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="social-timezone" className="w-32 shrink-0 text-sm text-muted-foreground">
            Timezone
          </label>
          <Input
            id="social-timezone"
            value={timezone}
            onChange={(e) => setTimezoneDraft(e.target.value)}
            onBlur={() => {
              if (timezoneDraft !== null && timezoneDraft !== st.settings.timezone) {
                saveSettings({ timezone: timezoneDraft || null });
              }
            }}
            className="max-w-64"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-sm text-muted-foreground">Instagram type</span>
          <div role="radiogroup" aria-label="Default Instagram post type" className="flex overflow-hidden rounded-lg border border-border">
            {INSTAGRAM_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={st.settings.defaults.instagramType === t}
                onClick={() => saveSettings({ defaults: { ...st.settings.defaults, instagramType: t } })}
                className={`cursor-pointer px-3 py-1 text-xs ${
                  st.settings.defaults.instagramType === t
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {INSTAGRAM_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span id="social-ai-label" className="w-32 shrink-0 text-sm text-muted-foreground">
            AI label
          </span>
          <Switch
            aria-labelledby="social-ai-label"
            checked={st.settings.defaults.aiLabel}
            onCheckedChange={(checked: boolean) => saveSettings({ defaults: { ...st.settings.defaults, aiLabel: checked } })}
          />
          <span className="text-xs text-muted-foreground">Label AI-generated content</span>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Maintenance</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="cursor-pointer" disabled={reindex.isPending} onClick={() => reindex.mutate()}>
            {reindex.isPending ? "Re-indexing…" : "Re-index posts from provider"}
          </Button>
          {reindex.data && (
            <span className="text-xs text-muted-foreground" data-testid="reindex-result">
              Scanned {reindex.data.scanned} · linked {reindex.data.linked}
              {reindex.data.orphans.length > 0 ? ` · ${reindex.data.orphans.length} orphan${reindex.data.orphans.length === 1 ? "" : "s"}` : ""}
              {reindex.data.truncated ? " (stopped early — run it again to finish)" : ""}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Refresh while page is visible: every 30 s.</p>
        <p className="text-xs text-muted-foreground">
          libi stores only: the chosen provider, these settings, and a piece ↔ post link table. Posts, media and
          metrics stay on the provider.
        </p>
      </section>
    </div>
  );
}
