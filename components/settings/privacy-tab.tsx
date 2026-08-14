"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import { setClientAnalyticsEnabled, trackEvent } from "@/lib/analytics/client";
import { useAnalyticsSettings, useSetAnalyticsEnabled } from "@/lib/queries/analytics-settings";
import { useCrashReportSettings, useSetCrashReportsEnabled } from "@/lib/queries/crash-report-settings";
import { LEGAL_LINKS } from "@/lib/legal-links";

/** Placeholder occupying one switch's slot while only THAT query is in flight. */
function SwitchSkeleton() {
  return <Skeleton className="h-6 w-11 shrink-0 rounded-full" />;
}

/**
 * Shown under one setting's description when its query failed. The switch next
 * to it stays rendered and operable against the shipped default — a failed read
 * must never remove the user's ability to opt out.
 *
 * The copy deliberately does NOT promise the change will be saved. This state
 * fires precisely when the settings DB is degraded (libi has a documented
 * migration-failed mode), which is the same condition that makes the PUT fail —
 * so a "changing it will still be saved" reassurance would be a false guarantee
 * about exercising a right, made exactly when it is least likely to hold. If
 * the write does fail, `SettingSaveError` below says so.
 */
function SettingLoadError() {
  return (
    <p className="text-sm text-destructive mt-1">
      We couldn&apos;t load your current setting, so the switch shows the default.
    </p>
  );
}

/**
 * Shown when the PUT failed. Without it the switch just snaps back to the
 * server value with no explanation, and a user who believes they opted out
 * would be wrong — the one outcome this tab must never produce silently.
 */
function SettingSaveError() {
  return (
    <p className="text-sm text-destructive mt-1">
      We couldn&apos;t save your choice — please try again.
    </p>
  );
}

export function PrivacyTab() {
  const { data, isLoading, isError } = useAnalyticsSettings();
  const setEnabled = useSetAnalyticsEnabled();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const {
    data: crashReportData,
    isLoading: crashReportLoading,
    isError: crashReportError,
  } = useCrashReportSettings();
  const setCrashReportsEnabled = useSetCrashReportsEnabled();

  // Each toggle gets its OWN loading/error state. Do NOT AND-couple them into
  // one all-or-nothing skeleton: on query *error* both `isLoading` and `data`
  // are falsy, so a shared gate renders a PERMANENT skeleton and the user can
  // exercise NEITHER opt-out. That is reachable — libi has a documented
  // degraded/migration-failed DB mode — and a crash-report query failure must
  // never disable the pre-existing analytics opt-out (or vice versa).
  const onToggle = (next: boolean) => {
    if (!next) {
      setConfirmOpen(true); // opening opt-out requires confirmation
      return;
    }
    setClientAnalyticsEnabled(true); // re-arm the client transport (no reload)
    setEnabled.mutate(true); // re-enabling is immediate; server logs opt_in
  };

  const confirmOptOut = () => {
    // Record the opt-out on the client transport BEFORE tearing it down, then
    // stop the browser emitting any further events (no reload needed).
    trackEvent("analytics_opt_out", { opted_out_at: Date.now() });
    setClientAnalyticsEnabled(false);
    setEnabled.mutate(false);
    setConfirmOpen(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Privacy</h2>
        <p className="text-sm text-muted-foreground mt-1">
          libi sends two kinds of telemetry, each with its own switch below:
          anonymous usage analytics, so we know which features matter, and
          automatic crash reports, so we can fix what breaks.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="analytics-enabled" className="font-medium">
            Share anonymous usage analytics
          </Label>
          <p className="text-sm text-muted-foreground mt-1">
            We collect anonymous, aggregate usage data — which features are used
            and how often — tied to a random ID. No name, email, or content is
            ever sent. This helps us decide what to improve.
          </p>
          {isError && <SettingLoadError />}
          {setEnabled.isError && <SettingSaveError />}
        </div>
        {isLoading ? (
          <SwitchSkeleton />
        ) : (
          <Switch
            id="analytics-enabled"
            // `?? true` is the shipped default, used only when the query failed
            // (see the per-toggle comment above): the switch stays OPERABLE so
            // the user can still opt out, which is the whole point of this tab.
            checked={data?.enabled ?? true}
            onCheckedChange={onToggle}
            className="cursor-pointer"
          />
        )}
      </div>

      {/* Crash reports are a different kind of signal from analytics above —
          analytics is what you do, crash reports are what broke. No
          confirmation dialog here: objecting to this processing is a right,
          and putting friction in front of exercising a right is a dark
          pattern. Don't copy the AlertDialog from the analytics toggle. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="crash-reports-enabled" className="font-medium">
            Send crash reports
          </Label>
          {/* Keep this honest about what the scrubber actually does. It
              REWRITES paths rather than dropping them
              (lib/sentry/scrub.ts#redactPaths:
              /Users/jane/dev/libi/lib/x.ts → /Users/[user]/dev/libi/lib/x.ts),
              so "file paths are stripped" would contradict the privacy policy
              one click away, which says the surrounding path structure can
              still be revealing. */}
          <p className="text-sm text-muted-foreground mt-1">
            libi sends automatic crash reports so we can fix bugs — what broke, not
            what you did. They carry no account or identity, and your OS user name
            and your media file names are removed from the file paths in them.
          </p>
          {crashReportError && <SettingLoadError />}
          {setCrashReportsEnabled.isError && <SettingSaveError />}
        </div>
        {crashReportLoading ? (
          <SwitchSkeleton />
        ) : (
          <Switch
            id="crash-reports-enabled"
            // Same fallback rationale as the analytics switch above: `"unset"`
            // is the shipped default (reporting on), and an unreadable
            // preference must not take the opt-out away from the user.
            checked={(crashReportData?.choice ?? "unset") !== "off"}
            onCheckedChange={(next) => setCrashReportsEnabled.mutate(next)}
            className="cursor-pointer"
          />
        )}
      </div>

      {/* The policies live on the website so they can be corrected on their own
          schedule — never bundled into an app release. Always link out. */}
      <div className="border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          Full details are in our{" "}
          <a
            href={LEGAL_LINKS.privacy}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer font-medium text-primary hover:underline"
          >
            Privacy Policy
          </a>
          ,{" "}
          <a
            href={LEGAL_LINKS.terms}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer font-medium text-primary hover:underline"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href={LEGAL_LINKS.license}
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer font-medium text-primary hover:underline"
          >
            licence
          </a>
          . libi is free and open source under GPL-3.0-only.
        </p>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off usage analytics?</AlertDialogTitle>
            <AlertDialogDescription>
              These analytics are anonymous (just a random ID — no name, email,
              or content) and are used solely to improve libi. Turning them off
              means we lose visibility into which features matter to you. Are you
              sure?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Keep analytics on</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" onClick={confirmOptOut}>
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
