"use client";

import {
  Crown,
  UsersRound,
  DatabaseBackup,
  Gauge,
  TrendingUp,
  CalendarClock,
  Sparkles,
} from "lucide-react";
import { WaitlistCard } from "@/components/premium/waitlist-card";

/**
 * A single optional membership — for one person or a team. The editor itself
 * stays free and open source (GPL-3.0-only); everything below is a cloud
 * service layered on top and is never required to use libi.
 */

interface Feature {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  description: string;
}

const INCLUDED: Feature[] = [
  {
    icon: UsersRound,
    name: "Team sharing",
    description:
      "Share pieces, assets, characters, and items across your teammates instead of passing files around.",
  },
  {
    icon: DatabaseBackup,
    name: "Cloud backup",
    description:
      "Your work backed up off-machine and restorable from anywhere — including a machine you haven't set up yet.",
  },
  {
    icon: Gauge,
    name: "In app AI coding and generation model",
    description:
      "Opt in to libi's hosted models for both the coding chat and generation instead of wiring up your own API keys, with usage tracking and per-member limits you control.",
  },
];

const COMING_LATER: Feature[] = [
  {
    icon: TrendingUp,
    name: "Viral DB",
    description:
      "A continuously-updated database of trending videos with structured analyses your agent can search by topic, hook, or format.",
  },
  {
    icon: CalendarClock,
    name: "Posting scheduler & analytics",
    description:
      "Auto-publish to TikTok, Instagram, YouTube Shorts, X, and Reddit on a schedule, then feed engagement data back so the agent can iterate.",
  },
];

export function PremiumTab() {
  return (
    <div className="space-y-6">
      {/* No standalone free/open-source blurb here — the tab header in
       * app/(app)/settings/page.tsx already says it, and two paragraphs making
       * the same promise back to back read as a sales pitch rather than a fact. */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Crown className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">libi Pro</h3>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Coming soon
              </span>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              One membership, whether you work solo or with a team.
            </p>
          </div>
        </div>

        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What&rsquo;s included
        </h4>
        <ul className="mb-6 space-y-3">
          {INCLUDED.map((feature) => {
            const Icon = feature.icon;
            return (
              <li key={feature.name} className="flex gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{feature.name}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        <h4 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3" />
          Joining later
        </h4>
        <ul className="mb-6 space-y-3">
          {COMING_LATER.map((feature) => {
            const Icon = feature.icon;
            return (
              <li key={feature.name} className="flex gap-3 opacity-75">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{feature.name}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          More joins the membership over time. The editor stays free regardless.
        </p>

        <WaitlistCard
          featureKey="pro"
          featureName="libi Pro"
          blurb="Drop your email to hear when libi Pro opens up, and to be considered for the early-access cohort."
          compact
        />
      </div>
    </div>
  );
}
