"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Film, Image as ImageIcon, Music, Play, Type, type LucideIcon } from "lucide-react";
import { BusyLabel } from "@/components/agents-page/agents-tab/steps/busy-label";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ResourceRow } from "@/lib/templates/details";
import { formatFileSize } from "@/lib/utils/format";
import { playQuietly } from "@/lib/media/play-quietly";

const KIND_ICON: Record<ResourceRow["kind"], LucideIcon> = { image: ImageIcon, video: Film, audio: Music, font: Type };

export const FONT_SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog";

/** The face a local font asset's sample is drawn in: derived from its ref, kept to [a-z0-9-] so it can't break out of the CSS it sits in. */
export function fontFaceName(ref: string): string {
  return `libi-template-font-${ref.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/** A URL for a CSS `url("…")`: only libi's own relative media paths get here, but quote-breaking characters are escaped regardless. */
const cssUrl = (u: string) => u.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);

/**
 * A template's resources — every asset, shown the way its kind plays:
 *  - image: a lazy thumbnail; clicking it opens the full image;
 *  - audio / video file: its own `<audio controls>` / `<video controls>`, loading nothing until played;
 *  - font: with `fontSamples` (a local template, served from libi's own
 *    origin) a sample line in its face; without (a public font: the app's CSP
 *    has no font source but libi itself) its name and size only;
 *  - link-only audio or video with a `stream` (a public template's page): a
 *    Play button that mounts a player on libi's own stream route only when
 *    pressed — nothing is fetched on page load, no autoplay attribute — with
 *    the host and "Open link" kept as the secondary way;
 *  - any other link-only asset: its host and an external "Open link" (the
 *    app's CSP admits media only from itself and the catalog's buckets);
 *  - a file the page may not serve: "Not available".
 * Names are the template author's text: plain, isolated, never markup — and
 * never a control's accessible NAME (a stranger's words would speak for the
 * control). Each control is named by kind and position ("Video 2 of 4") and
 * DESCRIBED by the resource's name (`aria-describedby`).
 */
/**
 * `stream` hooks for a public template's page: `beforePlay` runs when Play is
 * pressed and answers whether to go on (the page re-confirms, on demand, that
 * the template is still listed); `onPlaybackError` runs when a stream fails
 * (the page re-reads, so a template that left the catalog says so).
 */
export interface StreamHooks {
  /** `true` to play; otherwise why not, in the page's words (shown beside the Play button). */
  beforePlay?: () => Promise<true | string>;
  onPlaybackError?: () => void;
}

export function ResourcesList({ rows, fontSamples, stream }: { rows: ResourceRow[]; fontSamples: boolean; stream?: StreamHooks }) {
  const [enlarged, setEnlarged] = useState<ResourceRow | null>(null);
  const faces = fontSamples ? rows.filter((r) => r.kind === "font" && r.source.kind === "file") : [];
  return (
    <section aria-labelledby="template-resources-heading" className="space-y-3">
      <h2 id="template-resources-heading" className="text-sm font-semibold">
        Resources <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>
      </h2>
      {faces.length > 0 && (
        <style>
          {faces
            .map((r) => `@font-face { font-family: "${fontFaceName(r.ref)}"; src: url("${cssUrl((r.source as { url: string }).url)}"); font-display: swap; }`)
            .join("\n")}
        </style>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No resources.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((r, i) => (
            <ResourceCard key={r.ref} row={r} position={`${i + 1} of ${rows.length}`} fontSample={fontSamples} stream={stream} onEnlarge={() => setEnlarged(r)} />
          ))}
        </ul>
      )}
      <Dialog open={enlarged !== null} onOpenChange={(open) => !open && setEnlarged(null)}>
        <DialogContent className="max-h-[90vh] sm:max-w-3xl">
          <DialogTitle className="truncate pr-8">
            <bdi>{enlarged?.name}</bdi>
          </DialogTitle>
          {enlarged && enlarged.source.kind === "file" && (
            // eslint-disable-next-line @next/next/no-img-element -- libi's own media route or a catalog bucket object
            <img
              data-testid="resource-image-full"
              src={enlarged.source.url}
              alt=""
              referrerPolicy="no-referrer"
              className="max-h-[75vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Said when a streamed resource can't play here. */
export const STREAM_FAILED = "Couldn\u2019t play it here — open the link instead.";

const KIND_WORD: Record<ResourceRow["kind"], string> = { image: "Image", video: "Video", audio: "Audio", font: "Font" };

function ResourceCard({ row: r, position, fontSample, stream, onEnlarge }: { row: ResourceRow; position: string; fontSample: boolean; stream?: StreamHooks; onEnlarge: () => void }) {
  const Icon = KIND_ICON[r.kind];
  const nameId = useId();
  return (
    <li data-testid="resource-card" data-ref={r.ref} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-28 items-center justify-center bg-muted/60 p-2">
        <ResourcePreview r={r} label={`${KIND_WORD[r.kind]} ${position}`} nameId={nameId} fontSample={fontSample} stream={stream} onEnlarge={onEnlarge} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate" id={nameId}>
            <bdi>{r.name}</bdi>
          </span>
        </p>
        <p className="flex min-w-0 gap-2 text-[0.7rem] text-muted-foreground">
          <span className="truncate font-mono">{r.ref}</span>
          {r.bytes !== null && <span className="shrink-0 tabular-nums">{formatFileSize(r.bytes)}</span>}
        </p>
      </div>
    </li>
  );
}

function OpenLink({ href, testId }: { href: string; testId: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" data-testid={testId} className="cursor-pointer text-xs text-foreground underline underline-offset-2">
      Open link
      <OpensOutside />
    </a>
  );
}

/**
 * A link-only audio or video, played through libi's stream route — but only
 * once the user presses Play: until then there is no media element, so
 * nothing is fetched. Pressing it mounts the player (`preload="none"`, no
 * `autoplay`) and starts it inside that gesture.
 */
function StreamedMedia({
  r,
  stream,
  host,
  url,
  label,
  nameId,
  hooks,
}: {
  r: ResourceRow;
  stream: string;
  host: string;
  url: string;
  label: string;
  nameId: string;
  hooks?: StreamHooks;
}) {
  const [started, setStarted] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Why it isn't playing, when it isn't: the page's reason, or the generic one after a stream error. */
  const [failed, setFailed] = useState<string | null>(null);
  const press = async () => {
    if (checking) return;
    if (hooks?.beforePlay) {
      setChecking(true);
      let go: true | string = STREAM_FAILED;
      try {
        go = await hooks.beforePlay();
      } finally {
        setChecking(false);
      }
      if (go !== true) {
        setFailed(go);
        return;
      }
    }
    setFailed(null);
    setStarted(true);
  };
  const broke = () => {
    setFailed(STREAM_FAILED);
    hooks?.onPlaybackError?.();
  };
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    if (!started) return;
    media.current?.focus();
    void playQuietly(media.current);
  }, [started]);
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-1.5 text-center">
      {!started ? (
        <button
          type="button"
          data-testid={`resource-play-${r.ref}`}
          aria-label={`Play ${label.toLowerCase()}`}
          aria-describedby={nameId}
          aria-disabled={checking || undefined}
          onClick={() => void press()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background hover:bg-foreground/85 aria-disabled:opacity-70"
        >
          {checking ? (
            <BusyLabel>Checking…</BusyLabel>
          ) : (
            <>
              <Play className="size-3.5 fill-current" aria-hidden="true" />
              Play
            </>
          )}
        </button>
      ) : r.kind === "audio" ? (
        <audio
          ref={media as React.RefObject<HTMLAudioElement | null>}
          data-testid={`resource-audio-${r.ref}`}
          controls
          preload="none"
          src={stream}
          aria-label={label}
          aria-describedby={nameId}
          onError={broke}
          className="w-full"
        />
      ) : (
        <video
          ref={media as React.RefObject<HTMLVideoElement | null>}
          data-testid={`resource-video-${r.ref}`}
          controls
          playsInline
          preload="none"
          src={stream}
          aria-label={label}
          aria-describedby={nameId}
          onError={broke}
          className="max-h-40 w-full rounded bg-black"
        />
      )}
      {failed && (
        <span className="text-[0.7rem] text-amber-500" data-testid={`resource-stream-failed-${r.ref}`} role="status">
          {failed}
        </span>
      )}
      <span className="flex max-w-full items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{host}</span>
        <OpenLink href={url} testId={`resource-link-${r.ref}`} />
      </span>
    </div>
  );
}

function ResourcePreview({
  r,
  label,
  nameId,
  fontSample,
  stream,
  onEnlarge,
}: {
  r: ResourceRow;
  label: string;
  nameId: string;
  fontSample: boolean;
  stream?: StreamHooks;
  onEnlarge: () => void;
}) {
  const s = r.source;
  if (s.kind === "unavailable") return <span className="text-xs text-muted-foreground">Not available</span>;
  if (s.kind === "link") {
    if (s.stream && (r.kind === "audio" || r.kind === "video")) return <StreamedMedia r={r} stream={s.stream} host={s.host} url={s.url} label={label} nameId={nameId} hooks={stream} />;
    return (
      <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
        <span className="max-w-full truncate text-xs text-muted-foreground">{s.host}</span>
        <OpenLink href={s.url} testId={`resource-link-${r.ref}`} />
      </div>
    );
  }
  switch (r.kind) {
    case "image":
      return (
        <button
          type="button"
          data-testid={`resource-image-open-${r.ref}`}
          aria-label={`Show ${label.toLowerCase()} full size`}
          aria-describedby={nameId}
          onClick={onEnlarge}
          className="flex h-28 w-full cursor-zoom-in items-center justify-center"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- libi's own media route or a catalog bucket object */}
          <img
            data-testid={`resource-image-${r.ref}`}
            src={s.url}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full rounded object-contain"
          />
        </button>
      );
    case "audio":
      return <audio data-testid={`resource-audio-${r.ref}`} controls preload="none" src={s.url} aria-label={label} aria-describedby={nameId} className="w-full" />;
    case "video":
      return (
        <video
          data-testid={`resource-video-${r.ref}`}
          controls
          playsInline
          preload="none"
          src={s.url}
          aria-label={label}
          aria-describedby={nameId}
          className="max-h-40 w-full rounded bg-black"
        />
      );
    case "font":
      return fontSample ? (
        <p data-testid={`resource-font-sample-${r.ref}`} className="line-clamp-3 text-center text-base leading-snug" style={{ fontFamily: `"${fontFaceName(r.ref)}", sans-serif` }}>
          {FONT_SAMPLE_TEXT}
        </p>
      ) : (
        <Type className="size-8 text-muted-foreground" aria-hidden="true" />
      );
  }
}
