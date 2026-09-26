"use client";

import { Input } from "@/components/ui/input";
import { SchedulePicker } from "@/components/social/schedule-picker";
import type { CreatePostInput } from "@/lib/social/types";
import { PLATFORM_LABEL, type TargetDraft } from "./types";

export type WhenDraft = CreatePostInput["when"];

/**
 * Step 4 — draft, schedule, or publish now.
 *
 * Draft is the default on purpose: a Zernio draft reaches no platform, and
 * scheduling and cancelling are the SAME provider call, so a draft is always
 * recoverable. Publish now is not — which is why this step says so in the
 * user's own terms rather than hiding it behind a confirm alone.
 */
export function WhenStep({
  when,
  timezone,
  targets,
  onChange,
}: {
  when: WhenDraft;
  timezone: string;
  targets: TargetDraft[];
  onChange: (next: WhenDraft) => void;
}) {
  const platforms = Array.from(new Set(targets.map((t) => PLATFORM_LABEL[t.platform])));
  const scheduledFor = when.mode === "schedule" ? when.scheduledFor : "";
  const tz = when.mode === "schedule" ? when.timezone : timezone;

  return (
    <div className="space-y-4" data-testid="when-step">
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          name="composer-when"
          className="mt-1 cursor-pointer"
          data-testid="when-draft"
          checked={when.mode === "draft"}
          onChange={() => onChange({ mode: "draft" })}
        />
        <span>
          Save as draft
          <span className="block text-xs text-muted-foreground">
            stays at Zernio; approve later from the Posting tab or Social
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          name="composer-when"
          className="mt-1 cursor-pointer"
          data-testid="when-schedule"
          checked={when.mode === "schedule"}
          onChange={() => onChange({ mode: "schedule", scheduledFor, timezone: tz })}
        />
        <span>Schedule</span>
      </label>
      <div className="ml-6 space-y-2">
        <SchedulePicker
          value={scheduledFor}
          timezone={tz}
          disabled={when.mode !== "schedule"}
          idPrefix="when-schedule"
          onChange={(v) => onChange({ mode: "schedule", scheduledFor: v, timezone: tz })}
        />
        <Input
          type="text"
          aria-label="Timezone"
          data-testid="when-schedule-tz"
          className="max-w-64"
          value={tz}
          disabled={when.mode !== "schedule"}
          placeholder="Timezone (e.g. Asia/Bangkok)"
          onChange={(e) => onChange({ mode: "schedule", scheduledFor, timezone: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          The uploaded media URL lives 7 days — a date beyond that needs a re-upload before it runs.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          name="composer-when"
          className="mt-1 cursor-pointer"
          data-testid="when-now"
          checked={when.mode === "now"}
          onChange={() => onChange({ mode: "now" })}
        />
        <span>Publish now</span>
      </label>
      {when.mode === "now" && (
        <p className="ml-6 text-sm text-destructive" data-testid="publish-now-note">
          {/* One string, not text around an expression: JSX ate the space after
              the platform list and shipped "TikTokstraight away". */}
          {`This posts to ${platforms.join(" and ")} straight away and can't be undone from libi — on Instagram and TikTok you would have to delete it in their own app. You'll confirm each target first.`}
        </p>
      )}
    </div>
  );
}
