"use client";

import { useEffect, useId, useState } from "react";
import { Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { BUSY_BUTTON_CLASS, BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { legalLinksFor } from "@/lib/legal-links";
import { useLegalLinks } from "@/lib/queries/templates-catalog";
import { CreatorGatePrompt } from "@/components/templates/templates-page/creator-status";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";
import { CloudRouteError, useConfirmPublishRequest, useCreatorStatus, useDiscardPublishRequest, usePublishRequests } from "@/lib/queries/templates-cloud";
import { PUBLISH_PUBLIC_WARNING, RIGHTS_CONFIRMATION_LABEL } from "@/lib/templates/cloud/constants";
import type { PublishRequestView } from "@/lib/templates/types";

/** What makes a review a new one to look at: the request, its state and its confirm code (which rotates on every claim). */
function reviewKey(r: PublishRequestView): string {
  return `${r.id}:${r.state}:${r.confirmCode ?? ""}`;
}

/** Where the example was made from, in the user's words. */
function exampleOrigin(r: PublishRequestView): string {
  const ex = r.example;
  if (ex.kind === "file") return `Made from ${ex.filename}${ex.pieceName ? ` in "${ex.pieceName}"` : ""}.`;
  if (ex.kind === "path") return `Made from ${ex.fileName}, a video on this computer.`;
  return `Exported from the piece${ex.pieceName ? ` "${ex.pieceName}"` : ""}.`;
}

/**
 * The example video and poster exactly as they would be published: the
 * request's own copies, made when the agent prepared it — not the source,
 * which may have changed since.
 */
function ExamplePreview({ r }: { r: PublishRequestView }) {
  if (!r.media) {
    return (
      <div data-testid="publish-review-example" className="flex min-h-28 items-center justify-center rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
        The example video prepared for this publish is gone.
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <video
        data-testid="publish-review-example"
        src={r.media.videoUrl}
        poster={r.media.posterUrl}
        controls
        muted
        preload="metadata"
        className="max-h-56 w-full rounded-md bg-black object-contain"
      />
      <div className="mt-2 flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img data-testid="publish-review-poster" src={r.media.posterUrl} alt="Poster frame" className="h-12 w-auto rounded border border-border object-contain" />
        <p className="text-xs text-muted-foreground">
          The poster frame. {exampleOrigin(r)}
        </p>
      </div>
    </div>
  );
}

/**
 * How long Publish stays disabled after a panel appears, after its request
 * changes in place (a failure landing, a rotated confirm code), and after the
 * list of reviews around it changes. The panel is the one human gate on a
 * public publish. An agent that prepares again swaps a panel under the user's
 * cursor, and because the list is oldest-first the new request moves to the
 * bottom and every panel below the old one slides up — a click aimed at one
 * review must not publish another.
 */
export const PUBLISH_ARM_DELAY_MS = 1500;

/** Beside a Publish button held back only by the unticked rights box: why it can't be clicked yet. */
export const RIGHTS_HINT = "Confirm you hold the rights to publish";

/**
 * One publish an agent prepared, for the user to publish or not. Nothing is
 * public until "Publish publicly": that click is the only way a template
 * reaches the catalog (lib/templates/cloud/publish-confirm.ts). Publishing is
 * invite-only: while the creator isn't approved, the panel offers "Apply to
 * publish" (or says where the application stands) in Publish's place. An
 * unknown status (the catalog didn't answer, or still loading) keeps Publish:
 * the site is the real gate, and the job reports a refusal plainly. Once
 * approved, Publish also needs the rights box ticked, for this request: a
 * re-prepare (a new id) asks again.
 * `reprepared`: this request replaced one the page was already showing.
 * `listKey`: the whole list's review keys, in order — any change to it moves or
 * resizes the panels, so every panel settles again.
 */
export function PublishReviewPanel({
  r,
  highlighted,
  reprepared = false,
  listKey = "",
}: {
  r: PublishRequestView;
  highlighted: boolean;
  reprepared?: boolean;
  listKey?: string;
}) {
  const confirm = useConfirmPublishRequest();
  const discard = useDiscardPublishRequest();
  const creator = useCreatorStatus();
  // The Terms of the catalog this request publishes to: a development site's own, else the page's.
  const pageLinks = useLegalLinks();
  const links = r.catalog.kind === "development" && r.catalog.origin ? legalLinksFor(r.catalog.origin) : pageLinks;
  const gate = creator.data?.status;
  const creatorGate = gate === "none" || gate === "pending" || gate === "rejected" ? gate : null;
  const [refusal, setRefusal] = useState<string | null>(null);
  // The rights box, ticked for one request id: a new id reads unticked with no effect to reset it.
  const [rightsFor, setRightsFor] = useState<string | null>(null);
  const rights = rightsFor === r.id;
  // Armed once this review, where it now sits in the list, has been on screen for the delay.
  const armKey = `${reviewKey(r)}|${listKey}`;
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setArmedKey(armKey), PUBLISH_ARM_DELAY_MS);
    return () => clearTimeout(t);
  }, [armKey]);
  const armed = armedKey === armKey;
  // Busy from the click until the list says how it went: a confirm that just
  // succeeded reads "awaiting" until the refetch lands.
  const publishing = r.state === "publishing" || confirm.isPending || (confirm.isSuccess && r.state === "awaiting");
  const publishable = (r.state === "awaiting" || r.state === "failed") && !!r.confirmCode;
  const canPublish = armed && rights && !publishing && !discard.isPending && publishable;
  // Only the rights box holds Publish back: say so beside it, and tie it to the button for a screen reader.
  const needsRights = !creatorGate && !rights && !publishing && publishable;
  const rightsHintId = useId();
  // The last attempt's reason stays visible under a refusal of this click (a stale code, say).
  const lastAttempt = r.state === "failed" && r.error ? `The last attempt didn't publish: ${r.error}` : null;
  const errorLines = refusal ? [refusal, lastAttempt] : [lastAttempt ?? r.error];
  const error = errorLines.filter(Boolean).join("\n");

  const onPublish = () => {
    // The button is aria-disabled while it settles; refuse here too rather than
    // trust the component library alone to swallow the click.
    if (!canPublish || !r.confirmCode) return;
    setRefusal(null);
    confirm.mutate({ id: r.id, confirmCode: r.confirmCode, rightsConfirmed: rights }, { onError: (e) => setRefusal(e instanceof CloudRouteError ? e.message : "Couldn't start the publish. Try again.") });
  };
  const onDiscard = () => {
    setRefusal(null);
    discard.mutate(r.id, { onError: (e) => setRefusal(e.message) });
  };

  return (
    <li
      data-testid={`publish-review-${r.id}`}
      data-publish-request-id={r.id}
      data-state={r.state}
      className={`rounded-xl border bg-card p-4 ${highlighted ? "border-primary ring-2 ring-primary/40" : "border-border"}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {r.republish ? "Ready to publish an update" : "Ready to publish"}
          </p>
          <h2 className="truncate text-base font-semibold" data-testid="publish-review-name">
            {r.name}
          </h2>
          {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
        </div>
        <Badge variant="outline" className="shrink-0">
          Prepared by the agent
        </Badge>
      </div>
      {r.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {r.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </div>
      )}
      {reprepared && (
        <p data-testid="publish-review-reprepared" role="status" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
          The agent prepared this again. Look it over before you publish.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ExamplePreview r={r} />
        <div className="min-w-0">
          <p className="mb-1 text-sm font-medium">What becomes public</p>
          <ul data-testid="publish-review-public-items" className="space-y-1 text-sm">
            {r.publicItems.map((item) => (
              <li key={item.label} className="flex gap-2">
                <Globe aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  {item.label}
                  {item.detail && <span className="text-muted-foreground"> — {item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          {r.nickname.isNew && (
            <p data-testid="publish-review-nickname-note" className="mt-2 text-xs text-muted-foreground">
              {r.nickname.replaces
                ? `Your nickname becomes "${r.nickname.value}" — it replaces "${r.nickname.replaces}" on every template you have published.`
                : `Your templates will show the nickname "${r.nickname.value}".`}
            </p>
          )}
          {r.republish && (
            <p className="mt-2 text-xs text-muted-foreground">This updates your template in the catalog.</p>
          )}
        </div>
      </div>
      {!creatorGate && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox
            data-testid="publish-review-rights"
            className="mt-0.5 cursor-pointer"
            checked={rights}
            onCheckedChange={(v) => setRightsFor(v === true ? r.id : null)}
            disabled={publishing}
          />
          <span>{RIGHTS_CONFIRMATION_LABEL}</span>
        </label>
      )}
      <p data-testid="publish-review-warning" className={`${creatorGate ? "mt-4" : "mt-2"} text-sm`}>
        {PUBLISH_PUBLIC_WARNING}
      </p>
      {/* Which catalog this goes to — the request's own, so the line is always there (a dev build can publish to either). */}
      <p data-testid="publish-review-catalog" className="mt-1 text-xs text-muted-foreground">
        {r.catalog.kind === "test-mode" ? (
          "Publishes to the test-mode catalog."
        ) : (
          <>
            Publishes to the {r.catalog.kind === "development" ? "development" : "public"} catalog at{" "}
            <span className="font-medium text-foreground">{r.catalog.host}</span>.
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        By publishing you agree to the{" "}
        <a
          href={links.templatesCatalogTerms}
          target="_blank"
          rel="noreferrer"
          data-testid="publish-review-terms"
          className="cursor-pointer font-medium text-primary hover:underline"
        >
          Terms
          <OpensOutside />
        </a>
        .
      </p>
      {error && (
        <p data-testid="publish-review-error" role="alert" className="mt-3 whitespace-pre-line text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {creatorGate ? (
          <CreatorGatePrompt status={creatorGate} />
        ) : (
          <Button
            data-testid="publish-review-publish"
            // Busy reads as busy (the shared style); settling reads as disabled.
            className={`cursor-pointer ${publishing ? BUSY_BUTTON_CLASS : "aria-disabled:pointer-events-none aria-disabled:opacity-50"}`}
            disabled={!canPublish}
            // Focusable while busy, settling or waiting for the rights box, so a keyboard user can reach it and hear why.
            focusableWhenDisabled={publishing || !armed || needsRights}
            aria-describedby={needsRights ? rightsHintId : undefined}
            onClick={onPublish}
          >
            {publishing ? <BusyLabel>Publishing…</BusyLabel> : r.state === "failed" ? "Try again: publish publicly" : "Publish publicly"}
          </Button>
        )}
        {needsRights && (
          <span id={rightsHintId} data-testid="publish-review-rights-hint" className="text-xs text-muted-foreground">
            {RIGHTS_HINT}
          </span>
        )}
        <Button
          data-testid="publish-review-discard"
          variant="outline"
          className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
          disabled={publishing || discard.isPending}
          focusableWhenDisabled={discard.isPending}
          onClick={onDiscard}
        >
          {discard.isPending ? <BusyLabel>Discarding…</BusyLabel> : "Don't publish"}
        </Button>
      </div>
    </li>
  );
}

const NO_REQUESTS: PublishRequestView[] = [];

/**
 * The requests that replaced one the page was showing for the same template
 * (a re-prepare deletes the old row and inserts a new id, in one transaction),
 * kept for as long as each stands. Derived while rendering from the previous
 * list; a template whose request went (published, discarded) and later came
 * back is a fresh prepare, not a re-prepare.
 */
function useRepreparedIds(requests: PublishRequestView[]): ReadonlySet<string> {
  const [seen, setSeen] = useState<{ requests: PublishRequestView[]; reprepared: ReadonlySet<string> }>(() => ({ requests, reprepared: new Set() }));
  if (seen.requests === requests) return seen.reprepared;
  const before = new Map(seen.requests.map((r) => [r.templateId, r.id]));
  const live = new Set(requests.map((r) => r.id));
  const reprepared = new Set([...seen.reprepared].filter((id) => live.has(id)));
  for (const r of requests) {
    const prev = before.get(r.templateId);
    if (prev !== undefined && prev !== r.id) reprepared.add(r.id);
  }
  setSeen({ requests, reprepared });
  return reprepared;
}

/**
 * Every publish waiting for the user, above the tabs, so it is seen whichever
 * tab is open. Renders nothing when there is none (the usual case), and
 * nothing while the first read is in flight — an empty region needs no
 * skeleton. `?review=<id>` (the chat card's link) scrolls to that panel.
 */
export function PublishReviews({ highlightId }: { highlightId: string | null }) {
  const q = usePublishRequests();
  const requests = q.data ?? NO_REQUESTS;
  const reprepared = useRepreparedIds(requests);
  const listKey = requests.map(reviewKey).join(",");
  const has = requests.some((r) => r.id === highlightId);
  useEffect(() => {
    if (!highlightId || !has) return;
    document.querySelector(`[data-publish-request-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightId, has]);
  if (requests.length === 0) return null;
  return (
    <section data-testid="publish-reviews" aria-label="Waiting for you to publish" className="mb-6">
      <ul className="space-y-4">
        {requests.map((r) => (
          <PublishReviewPanel key={r.id} r={r} highlighted={r.id === highlightId} reprepared={reprepared.has(r.id)} listKey={listKey} />
        ))}
      </ul>
    </section>
  );
}
