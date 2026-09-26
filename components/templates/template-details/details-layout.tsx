"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { trackEvent } from "@/lib/analytics/client";
import Link from "next/link";
import { ArrowLeft, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/templates/details";

/** Back to the Templates page — to the Public tab from a public template's page. */
export function BackToTemplates({ href }: { href: string }) {
  return (
    <Link
      href={href}
      data-testid="template-details-back"
      className="inline-flex w-fit cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Templates
    </Link>
  );
}

/**
 * A template's page: the back link; two columns from `md` — the player on the
 * left; the header, actions and usage on the right — then, full width, the
 * Overlays table and the Resources grid (`children`).
 */
export function DetailsLayout({ backHref, player, children, aside }: { backHref: string; player: ReactNode; aside: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6" data-testid="template-details">
      <BackToTemplates href={backHref} />
      <div className="mt-4 grid items-start gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">{player}</div>
        <div className="flex min-w-0 flex-col gap-4">{aside}</div>
      </div>
      {children && <div className="mt-10 space-y-10">{children}</div>}
    </div>
  );
}

/** A page that has nothing to show: why, and the way back. */
export function DetailsMessage({ backHref, message, children }: { backHref: string; message: string; children?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      <BackToTemplates href={backHref} />
      <div className="mt-10 flex flex-col items-start gap-3">
        <p className="text-sm" role="status" data-testid="template-details-message">
          {message}
        </p>
        {children}
      </div>
    </div>
  );
}

/**
 * The example player, in the canvas's aspect ratio and never taller than 70%
 * of the window: `<video controls>` with sound (never muted), the poster
 * first. No example: the poster alone; no poster either: the card's empty box
 * (the canvas size), with `empty` inside it (a local template's Render preview).
 */
export function DetailsPlayer({
  exampleUrl,
  posterUrl,
  canvas,
  empty,
}: {
  exampleUrl: string | null;
  posterUrl: string | null;
  canvas: { width: number; height: number };
  empty?: ReactNode;
}) {
  const ratio = canvas.width / canvas.height;
  const played = useRef(false);
  const onFirstPlay = () => {
    if (played.current) return;
    played.current = true;
    trackEvent("template_example_played", { where: "details" });
  };
  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl border border-border bg-muted"
      style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, maxHeight: "70vh", maxWidth: `calc(70vh * ${ratio})` }}
    >
      {exampleUrl ? (
        <video
          data-testid="template-details-video"
          aria-label="Template example"
          onPlay={onFirstPlay}
          controls
          playsInline
          preload="metadata"
          poster={posterUrl ?? undefined}
          src={exampleUrl}
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />
      ) : posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- libi's own media route or a catalog bucket object
        <img data-testid="template-details-poster" src={posterUrl} alt="Template poster" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-contain" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-muted-foreground" data-testid="template-details-no-poster">
          {canvas.width}×{canvas.height}
          {empty}
        </div>
      )}
    </div>
  );
}

/**
 * Name, byline, description, tags and the facts (canvas, duration, slots,
 * code). Every string but the facts is the author's text — for an installed
 * or public template a stranger's — so it renders as plain text only,
 * direction-isolated so right-to-left text can't reorder the page.
 */
export function DetailsHeader({
  name,
  byline,
  description,
  tags,
  canvas,
  duration,
  slotCount,
  hasCode,
  badge,
}: {
  name: string;
  byline?: ReactNode;
  description: string;
  tags: string[];
  canvas: { width: number; height: number };
  duration: number;
  slotCount: number;
  hasCode: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h1 dir="auto" className="text-2xl font-semibold break-words [unicode-bidi:isolate]">
        {name}
      </h1>
      {byline}
      {description ? (
        <p dir="auto" className="text-sm break-words whitespace-pre-line text-muted-foreground [unicode-bidi:isolate]">
          {description}
        </p>
      ) : null}
      {tags.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-[0.7rem] text-muted-foreground">
              <bdi>{tag}</bdi>
            </span>
          ))}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span data-testid="template-details-canvas">
          {canvas.width}×{canvas.height}
        </span>
        <span data-testid="template-details-duration">{formatDuration(duration)}</span>
        <span>
          {slotCount} {slotCount === 1 ? "slot" : "slots"}
        </span>
        {hasCode && (
          <Badge variant="outline" className="gap-1 text-[0.65rem]" data-testid="template-details-has-code">
            <Code2 className="size-3" /> Has code
          </Badge>
        )}
        {badge}
      </p>
    </div>
  );
}

/**
 * A refresh that failed while the page HAS its template: the page stays (a
 * background re-read must never take away what the user is looking at, nor
 * close a dialog they opened — D5–D6 review I1), with this line and, unless
 * the catalog asked libi to wait, a retry.
 */
export function DetailsRefreshNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="status"
      data-testid="template-details-refresh-failed"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500"
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="cursor-pointer font-medium underline underline-offset-2" data-testid="template-details-refresh-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Counts one view of a template's page, once its template has loaded (`scope`: whose page it is). */
export function useDetailsViewed(scope: "local" | "public", loaded: boolean): void {
  const sent = useRef(false);
  useEffect(() => {
    if (!loaded || sent.current) return;
    sent.current = true;
    trackEvent("template_details_viewed", { scope });
  }, [loaded, scope]);
}
