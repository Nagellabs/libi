"use client";

import { PLATFORM_CATALOG, platformLabel } from "@/lib/social/catalog";
import { PlatformBadge } from "@/components/social/platform-icon";
import type { SocialAccount } from "@/lib/social/types";

/**
 * What libi says about a platform its own UI does not compose for yet.
 *
 * The distinction this copy has to carry: the PROVIDER reaches Facebook, X
 * and YouTube today, and the agent posts to them through its MCP — it is
 * libi's composer that hasn't grown the per-platform options those need
 * (`catalog.platforms` has no entry for them, so there is nothing to fit-check
 * and nothing to collect). Saying "not supported" would be wrong in the way
 * that costs the user a working path; saying nothing would leave a connected
 * account looking broken.
 */
export const AGENT_ONLY_BLURB =
  "Your agent posts to these through the provider's MCP today. libi's own composer doesn't build them yet — the posts it makes still show up here, in Posts, Schedule and Analytics.";

/**
 * The composer's Targets step, for accounts it cannot offer a checkbox for.
 * They are LISTED rather than hidden: the account is connected, the user can
 * see it on the dashboard, and an account that silently disappears at the one
 * step that is about choosing accounts reads as a bug.
 */
export function AgentOnlyTargets({ accounts }: { accounts: SocialAccount[] }) {
  if (accounts.length === 0) return null;
  return (
    <div data-testid="agent-only-targets" className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-medium text-muted-foreground">Ask your agent for these</p>
      <ul className="space-y-1.5">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <PlatformBadge platform={a.platform} />
            <span>
              {platformLabel(a.platform)} @{a.username}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{AGENT_ONLY_BLURB}</p>
    </div>
  );
}

/**
 * Settings → Platforms: the whole catalog, with what libi can do for each.
 * The only place the five platforms are named to the user as a set, so it is
 * also the answer to "can I post to X from here yet?".
 */
export function PlatformSupport() {
  return (
    <section className="space-y-2" data-testid="platform-support">
      <h2 className="text-sm font-medium">Platforms</h2>
      <ul className="space-y-1.5">
        {PLATFORM_CATALOG.map((p) => (
          <li
            key={p.id}
            data-testid={`platform-support-${p.id}`}
            data-ui={p.ui ? "yes" : "no"}
            className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2.5">
              <PlatformBadge platform={p.id} />
              {p.label}
            </span>
            <span className={`text-xs ${p.ui ? "text-emerald-500" : "text-muted-foreground"}`}>
              {p.ui ? "Post from libi" : "Agent only · libi UI coming"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{AGENT_ONLY_BLURB}</p>
      <p className="text-xs text-muted-foreground">
        Connecting an account is always done at your provider — libi never asks for a platform password.
      </p>
    </section>
  );
}
