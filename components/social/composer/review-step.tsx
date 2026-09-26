"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useTikTokDryRun, useValidateSocialPost } from "@/lib/queries/social";
import type { CreatePostInput, SocialAccount } from "@/lib/social/types";
import { PLATFORM_LABEL, postTypeOf, targetLabel, type TargetDraft } from "./types";
import type { WhenDraft } from "./when-step";

const NO_UNDO: Record<string, string> = {
  instagram: "no undo from libi — you would have to delete it in the Instagram app",
  tiktok: "public on this account, no undo from libi",
};

const PRIMARY_LABEL: Record<WhenDraft["mode"], string> = {
  draft: "Save draft",
  schedule: "Schedule",
  now: "Publish now",
};

function whenSummary(when: WhenDraft): string {
  if (when.mode === "draft") return "Saved as a draft at Zernio — it reaches no platform until you publish it.";
  if (when.mode === "schedule") return `Scheduled for ${when.scheduledFor || "—"} (${when.timezone})`;
  return "Published immediately.";
}

/**
 * Step 5 — what will happen, checked with the provider before it does.
 *
 * `/api/social/validate` runs for every mode, not just publish: Instagram
 * refuses to SCHEDULE a post with no media, so a schedule that skipped this
 * would fail at the provider instead of here
 * (`.superpowers/sdd/zernio-live-shapes.md`).
 */
export function ReviewStep({
  body,
  targets,
  when,
  accounts,
  uploading,
  uploadPercent,
  uploadError,
  submitting,
  lastError,
  targetsReady,
  needsConfirmation,
  perTargetErrors,
  onSubmit,
  onRetry,
}: {
  /** The exact create body — `null` while the media upload is still running. */
  body: CreatePostInput | null;
  targets: TargetDraft[];
  when: WhenDraft;
  accounts: SocialAccount[];
  uploading: boolean;
  uploadPercent: number;
  uploadError: string | null;
  submitting: boolean;
  lastError: string | null;
  /** Every target has what its platform requires — TikTok's two consents
   *  above all. The rail can walk back to Targets and undo them after this
   *  step was reached, so the gate is re-read HERE rather than trusted from
   *  whenever Next was last enabled. */
  targetsReady: boolean;
  /** Set only after a PUBLISH NOW whose outcome libi could not confirm. */
  needsConfirmation: boolean;
  perTargetErrors: Array<{ platform: string; accountId: string; error: string }>;
  onSubmit: (republishConfirmedByUser?: true) => void;
  onRetry: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkedNothingPosted, setCheckedNothingPosted] = useState(false);

  const wantsDryRun = when.mode !== "draft" && targets.some((t) => t.platform === "tiktok");
  const validate = useValidateSocialPost(body);
  const dry = useTikTokDryRun(body, wantsDryRun);

  const verdicts = Array.isArray(validate.data) ? validate.data : null;
  const validateError = validate.isError ? (validate.error instanceof Error ? validate.error.message : String(validate.error)) : null;
  // A pre-flight that could not run is not a verdict — say nothing rather
  // than claim TikTok approved or refused.
  const dryRun = typeof dry.data?.canPublish === "boolean" ? dry.data : null;

  const username = (accountId: string) => accounts.find((a) => a.id === accountId)?.username;
  // NO verdict is not a passing verdict. `verdicts === null` covers both
  // "still loading" and "the check itself failed", and treating either as
  // "nothing failed" left Publish/Schedule enabled with nothing checked at all.
  const noVerdict = !verdicts?.length;
  const failedVerdict = (verdicts ?? []).some((v) => !v.ok);
  // A draft reaches no platform, so its problems are shown but not a gate. A
  // schedule and a publish BOTH go through the provider for real, and
  // Instagram refuses a scheduled post the validator already rejected — so
  // the same gate holds for both.
  const gateFailed = noVerdict || failedVerdict || (wantsDryRun && dryRun?.canPublish === false);
  const blocked =
    !body ||
    !targetsReady ||
    !!uploadError ||
    (when.mode !== "draft" && gateFailed) ||
    (when.mode === "schedule" && !when.scheduledFor);

  return (
    <div className="space-y-4" data-testid="review-step">
      <ul className="space-y-1 text-sm">
        {targets.map((t) => (
          <li key={`${t.platform}:${t.accountId}`}>
            {targetLabel(t.platform, postTypeOf(t))} {username(t.accountId) ? `@${username(t.accountId)}` : ""}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{whenSummary(when)}</p>
      {body?.content ? (
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-card p-3 text-sm">{body.content}</p>
      ) : null}

      {uploading && (
        <p className="text-sm text-muted-foreground" data-testid="review-uploading">
          Uploading {uploadPercent}% — the media has to be at Zernio before it can check this post.
        </p>
      )}
      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

      {!uploading && !uploadError && validate.isLoading && (
        <div className="space-y-2" data-testid="validate-skeleton">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-44" />
        </div>
      )}

      {validateError && (
        <p className="text-sm text-destructive" data-testid="validate-error">
          {validateError}
        </p>
      )}

      <ul className="space-y-1 text-sm">
        {(verdicts ?? []).map((v) => (
          <li key={v.platform}>
            {v.ok ? (
              <span className="text-emerald-400" data-testid={`validate-ok-${v.platform}`}>
                ✓ {PLATFORM_LABEL[v.platform as keyof typeof PLATFORM_LABEL] ?? v.platform}
              </span>
            ) : (
              <div className="space-y-1" data-testid={`validate-bad-${v.platform}`}>
                <span className="text-destructive">✗ {PLATFORM_LABEL[v.platform as keyof typeof PLATFORM_LABEL] ?? v.platform}</span>
                {v.errors.map((e) => (
                  <p key={e} className="text-destructive">
                    {e}
                  </p>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {wantsDryRun && dryRun && (
        <p className={`text-sm ${dryRun.canPublish ? "text-muted-foreground" : "text-destructive"}`} data-testid="tiktok-dry-run">
          TikTok pre-check: {dryRun.canPublish ? "this account can publish it" : dryRun.perAccount.map((a) => a.reason).filter(Boolean).join("; ") || "TikTok refused it"}
        </p>
      )}

      {perTargetErrors.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="per-target-errors">
          {perTargetErrors.map((e) => (
            <li key={`${e.platform}:${e.accountId}`} className="text-destructive">
              {PLATFORM_LABEL[e.platform as keyof typeof PLATFORM_LABEL] ?? e.platform}: {e.error}
            </li>
          ))}
        </ul>
      )}

      {/* A publish-now whose outcome libi could not read NEVER retries on its
          own: the provider has no atomic dedupe, so a second attempt can
          double-post. A human looks, and a human says so. */}
      {needsConfirmation ? (
        <div className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3" data-testid="composer-needs-confirmation">
          <p className="text-sm text-destructive">{lastError}</p>
          <p className="text-sm">
            libi could not confirm what Zernio did with this publish. It may already be live. Open the account and look
            before trying again — libi will not retry a publish by itself.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="cursor-pointer"
              data-testid="composer-checked-nothing-posted"
              checked={checkedNothingPosted}
              onChange={(e) => setCheckedNothingPosted(e.target.checked)}
            />
            I checked the account — nothing was posted.
          </label>
          <Button
            variant="destructive"
            className="cursor-pointer"
            data-testid="composer-publish-again"
            disabled={!checkedNothingPosted || submitting}
            onClick={() => onSubmit(true)}
          >
            {submitting ? "Publishing…" : "Publish again"}
          </Button>
        </div>
      ) : (
        lastError && (
          <div className="space-y-2" data-testid="composer-error">
            <p className="text-sm text-destructive">{lastError}</p>
            {/* Disabled WHILE it runs: two fast clicks used to dispatch two
                creates, which on a schedule is two posts. */}
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              data-testid="composer-retry"
              disabled={submitting}
              onClick={onRetry}
            >
              {submitting ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )
      )}

      {!needsConfirmation && (
        <Button
          className="cursor-pointer"
          data-testid="composer-submit"
          disabled={blocked || submitting || uploading}
          onClick={() => (when.mode === "now" ? setConfirmOpen(true) : onSubmit())}
        >
          {submitting ? `${PRIMARY_LABEL[when.mode]}…` : PRIMARY_LABEL[when.mode]}
        </Button>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish now?</AlertDialogTitle>
            {/* `render={<div />}` — a <p> can't legally contain a <ul>. */}
            <AlertDialogDescription render={<div />}>
              <ul className="list-disc space-y-1 pl-4 text-left">
                {targets.map((t) => (
                  <li key={`${t.platform}:${t.accountId}`}>
                    {PLATFORM_LABEL[t.platform]} {username(t.accountId) ? `@${username(t.accountId)}` : ""} —{" "}
                    {NO_UNDO[t.platform] ?? "no undo"}
                  </li>
                ))}
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              data-testid="publish-now-confirm"
              onClick={() => {
                setConfirmOpen(false);
                onSubmit();
              }}
            >
              Publish now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
