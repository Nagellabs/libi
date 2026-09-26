"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Code2 } from "lucide-react";
import { CardExamplePlayer, onCardBodyClick } from "@/components/templates/templates-page/card-play";
import { PublicUseButton } from "@/components/templates/templates-page/public-use-button";
import { ReportMenu } from "@/components/templates/templates-page/report-menu";
import { TEMPLATE_PREVIEW_LABEL } from "@/components/templates/templates-page/template-card";
import { useExampleHoverPlay } from "@/components/templates/templates-page/use-example-hover-play";
import { useExampleInlinePlay } from "@/components/templates/templates-page/use-example-inline-play";
import { Badge } from "@/components/ui/badge";
import type { TemplateSummary } from "@/lib/templates/types";

/** A catalog entry that is not installed here: `cloudId` set, no local `id`. */
export type PublicTemplate = TemplateSummary & { cloudId: string };

/** The most tags a card shows; the catalog allows ten. */
const TAGS_SHOWN = 4;

/**
 * A poster or example URL, only when it is what the catalog cache produced:
 * under this environment's bucket base (`base`, from the catalog route — https
 * in production and dev, the studio's own loopback fixture in test mode),
 * inside THIS template's folder, with nothing that could step out of it.
 * Anything else renders no media at all. Never built from the entry's text.
 */
export function catalogMediaUrl(url: string | null, base: string | null, cloudId: string): string | null {
  if (!url || !base || !url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  if (!rest.startsWith(`templates/${cloudId}/`) || /(^|\/)\.\.?(\/|$)|%|\\|\?|#/.test(rest)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const loopback = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !loopback) return null;
  if (parsed.username || parsed.password) return null;
  return url;
}

/** A catalog entry's own page (`app/(app)/templates/public/[cloudId]/page.tsx`). */
export function publicTemplatePageHref(cloudId: string): string {
  return `/templates/public/${encodeURIComponent(cloudId)}`;
}

/**
 * A public catalog entry: poster first; the example plays muted on hover or
 * focus and stops on leave (loaded only then), or inline with sound from the
 * play button, one card at a time. The card's body opens the entry's page. Use
 * (`PublicUseButton`) installs the version on the card, then hands the agent
 * an apply prompt naming the template by its id alone. Everything the author
 * wrote renders as plain text, bidi-isolated and clamped.
 */
export function PublicTemplateCard({ entry, mediaBase }: { entry: PublicTemplate; mediaBase: string | null }) {
  const poster = catalogMediaUrl(entry.poster, mediaBase, entry.cloudId);
  const example = catalogMediaUrl(entry.video, mediaBase, entry.cloudId);
  const { videoRef, hovering, videoSrc, play, stop } = useExampleHoverPlay(example);
  const inline = useExampleInlinePlay(example);
  const router = useRouter();
  const href = publicTemplatePageHref(entry.cloudId);
  const hoverPlay = () => {
    if (!inline.playing) play();
  };
  const startInline = () => {
    stop();
    inline.start();
  };
  const aspect = `${entry.canvas.width} / ${entry.canvas.height}`;

  return (
    <li
      data-testid="public-card"
      data-cloud-id={entry.cloudId}
      className="group flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      onMouseEnter={hoverPlay}
      onMouseLeave={stop}
      onClick={(e) => onCardBodyClick(e, () => router.push(href))}
    >
      <div className="relative w-full bg-muted" style={{ aspectRatio: aspect, maxHeight: "18rem" }}>
        {/* A focus stop that plays the example muted: an image with a fixed
            name, never the listing's. Pictures only — the player's controls
            sit beside it, since `role="img"` hides its children (review I3). */}
        <div
          className="absolute inset-0"
          tabIndex={example ? 0 : undefined}
          role={example ? "img" : undefined}
          aria-label={example ? TEMPLATE_PREVIEW_LABEL : undefined}
          onFocus={hoverPlay}
          onBlur={stop}
        >
          {poster ? (
            // eslint-disable-next-line @next/next/no-img-element -- a catalog bucket object; next/image would proxy it
            <img
              data-testid="public-card-poster"
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          {example ? (
            <video
              ref={videoRef}
              data-testid="public-card-video"
              muted
              playsInline
              loop
              preload="none"
              disablePictureInPicture
              aria-hidden="true"
              src={videoSrc ?? undefined}
              className={`absolute inset-0 h-full w-full object-cover ${hovering ? "" : "hidden"}`}
            />
          ) : null}
        </div>
        {example && (
          <CardExamplePlayer
            src={example}
            playing={inline.playing}
            onPlay={startInline}
            onStop={inline.stop}
            videoRef={inline.videoRef}
            playButtonRef={inline.playButtonRef}
            playerRef={inline.playerRef}
            onPlayerKeyDown={inline.onPlayerKeyDown}
            ids={{ play: "public-card-play", video: "public-card-inline-video", stop: "public-card-inline-stop" }}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium" data-testid="public-card-name">
            <Link href={href} className="cursor-pointer hover:underline">
              <bdi>{entry.name}</bdi>
            </Link>
          </p>
          {entry.hasCode && (
            <Badge variant="outline" className="shrink-0 gap-1 text-[0.65rem]">
              <Code2 className="size-3" /> code
            </Badge>
          )}
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground" data-testid="public-card-nickname">
          by{" "}
          <span className="font-medium text-foreground">
            <bdi>{entry.nickname ?? "someone"}</bdi>
          </span>
        </p>
        {entry.description ? (
          <p dir="auto" className="line-clamp-2 text-xs break-words text-muted-foreground [unicode-bidi:isolate]">
            {entry.description}
          </p>
        ) : null}
        {entry.tags.length > 0 && (
          <p className="flex min-w-0 flex-wrap gap-1">
            {entry.tags.slice(0, TAGS_SHOWN).map((tag) => (
              <span key={tag} className="max-w-full truncate rounded-full border border-border px-1.5 text-[0.65rem] text-muted-foreground">
                <bdi>{tag}</bdi>
              </span>
            ))}
            {entry.tags.length > TAGS_SHOWN && <span className="text-[0.65rem] text-muted-foreground">+{entry.tags.length - TAGS_SHOWN}</span>}
          </p>
        )}
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums" data-testid="public-card-uses">
          <span>
            {entry.uses7d} this week · {entry.usesTotal} total
          </span>
          <span>
            {entry.slotCount} {entry.slotCount === 1 ? "slot" : "slots"}
          </span>
        </p>
        <div className="mt-auto flex items-center justify-between gap-1 pt-1">
          <PublicUseButton cloudId={entry.cloudId} version={entry.version} testId="public-card-use" />
          <ReportMenu cloudId={entry.cloudId} />
        </div>
      </div>
    </li>
  );
}
