"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { DetailsHeader, DetailsLayout, DetailsMessage, DetailsPlayer, DetailsRefreshNotice, useDetailsViewed } from "@/components/templates/template-details/details-layout";
import { DetailsSkeleton } from "@/components/templates/template-details/details-skeleton";
import { MusicLinks } from "@/components/templates/template-details/music-links";
import { OverlaysList } from "@/components/templates/template-details/overlays-list";
import { ResourcesList, STREAM_FAILED } from "@/components/templates/template-details/resources-list";
import { UsagePanel } from "@/components/templates/template-details/usage-panel";
import { catalogMediaUrl } from "@/components/templates/templates-page/public-template-card";
import { PublicUseButton } from "@/components/templates/templates-page/public-use-button";
import { ReportMenu } from "@/components/templates/templates-page/report-menu";
import { templatePageHref } from "@/components/templates/templates-page/template-card";
import { Button } from "@/components/ui/button";
import { cachedTemplateCanvas } from "@/lib/queries/templates";
import { CloudRouteError, PUBLIC_DETAIL_RATE_LIMITED, usePublicTemplateDetail } from "@/lib/queries/templates-cloud";
import { assetStreamUrl, musicLinkRows, overlayRows, resourceRows } from "@/lib/templates/details";

const PUBLIC_TAB_HREF = "/templates?tab=public";
export const PUBLIC_NOT_FOUND = "This template is no longer in the catalog.";
export const PUBLIC_INVALID_ID = "This isn't the address of a catalog template.";
/** Older than this, a Play first re-reads the page: under the stream route's 15-minute listing window. */
const RECONFIRM_BEFORE_PLAY_MS = 10 * 60_000;

/**
 * A public catalog entry's page (`/templates/public/<cloudId>`), read WITHOUT
 * installing it: the example with sound, the listing by its author, Use
 * (install, then the apply prompt — the card's flow) and Report, the catalog's
 * numbers, and its overlays and resources. A local copy links to its own page.
 *
 * Every string from the listing and the scaffold is a stranger's: plain text,
 * direction-isolated, never HTML or markdown. Media comes only from this
 * template's own folder in the catalog bucket (`catalogMediaUrl`); anything
 * else renders nothing. A link-only audio or video plays through libi's own
 * stream route (lib/templates/cloud/asset-stream.ts) once the user presses
 * Play; any other link-only asset shows its host and "Open link".
 */
export function PublicTemplateDetails({ cloudId }: { cloudId: string }) {
  const q = usePublicTemplateDetail(cloudId);
  const qc = useQueryClient();
  useDetailsViewed("public", !!q.data);

  // Gone is final, loaded or not: a refetch that says the template left the catalog replaces the
  // page — its players (and their streams) stop with it (fix-round review N4).
  const gone = q.isError && q.error instanceof CloudRouteError && q.error.status === 404;
  if (gone) return <DetailsMessage backHref={PUBLIC_TAB_HREF} message={PUBLIC_NOT_FOUND} />;
  // A malformed address is not a template that left (final review F11).
  const invalid = q.isError && q.error instanceof CloudRouteError && q.error.status === 400;
  if (invalid) return <DetailsMessage backHref={PUBLIC_TAB_HREF} message={PUBLIC_INVALID_ID} />;
  // Otherwise data first: a background refetch that fails (the catalog's rate limit after an
  // install, a blip) keeps the page — and the apply dialog Use just opened — on screen (review I1).
  if (!q.data) {
    if (!q.isError) return <DetailsSkeleton canvas={cachedTemplateCanvas(qc, (t) => t.cloudId === cloudId)} />;
    const limited = q.error instanceof CloudRouteError && q.error.status === 429;
    return (
      <DetailsMessage backHref={PUBLIC_TAB_HREF} message={q.error.message}>
        {!limited && (
          <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void q.refetch()}>
            Try again
          </Button>
        )}
      </DetailsMessage>
    );
  }

  const { template: t, scaffold, mediaBase, installedTemplateId, installedOrigin, droppedAssets } = q.data;
  const inFolder = (url: string) => catalogMediaUrl(url, t.base, cloudId);
  const posterUrl = inFolder(t.base + t.poster);
  const exampleUrl = inFolder(t.base + t.video);
  const limited = q.isError && q.error instanceof CloudRouteError && q.error.status === 429;

  return (
    <DetailsLayout
      backHref={PUBLIC_TAB_HREF}
      player={<DetailsPlayer exampleUrl={exampleUrl} posterUrl={posterUrl} canvas={t.canvas} />}
      aside={
        <>
          {q.isError && (
            <DetailsRefreshNotice
              message={limited ? `${PUBLIC_DETAIL_RATE_LIMITED} Showing what was loaded.` : "Couldn't refresh this template — showing what was loaded."}
              onRetry={limited ? undefined : () => void q.refetch()}
            />
          )}
          <DetailsHeader
            name={t.name}
            byline={
              <p className="text-xs text-muted-foreground" data-testid="template-details-author">
                by{" "}
                <span className="font-medium text-foreground">
                  <bdi>{t.nickname ?? "someone"}</bdi>
                </span>
              </p>
            }
            description={t.description}
            tags={t.tags}
            canvas={t.canvas}
            duration={t.duration}
            slotCount={t.slotCount}
            hasCode={t.hasCode}
          />
          <div className="flex flex-wrap items-center gap-2">
            {/* The card's flow: install the version shown, then the apply prompt naming the installed id alone. */}
            <PublicUseButton cloudId={cloudId} version={t.version} testId="template-details-use" />
            <ReportMenu cloudId={cloudId} />
            {installedTemplateId && (
              <Link
                href={templatePageHref(installedTemplateId)}
                data-testid="template-details-installed-link"
                className="cursor-pointer text-xs text-foreground underline underline-offset-2"
              >
                {/* The author's own published template is theirs, not an installed copy (review M2). */}
                {installedOrigin === "local" ? "Open your template" : "Open your installed copy"}
              </Link>
            )}
          </div>
          <UsagePanel catalog={{ total: t.usesTotal, d7: t.uses7d, d30: t.uses30d ?? null, lastUsedDay: t.lastUsedDay ?? null }} />
        </>
      }
    >
      <OverlaysList rows={overlayRows(scaffold)} />
      <MusicLinks rows={musicLinkRows(scaffold)} />
      <ResourcesList
        rows={resourceRows(
          scaffold,
          (file) => inFolder(mediaBase + file),
          (url) => assetStreamUrl(cloudId, url),
        )}
        fontSamples={false}
        stream={{
          // The stream route streams only while the catalog confirmed the template listed within
          // 15 minutes, and re-asks on demand past that; a page left open re-reads first, so a
          // template that left the catalog meanwhile shows as gone (confirmation review C1).
          beforePlay: async () => {
            if (Date.now() - q.dataUpdatedAt < RECONFIRM_BEFORE_PLAY_MS) return true;
            const r = await q.refetch();
            if (!r.isError) return true;
            // The catalog's limit says so in its own words (final review F11); gone replaces the page anyway.
            return r.error instanceof CloudRouteError && r.error.status === 429 ? PUBLIC_DETAIL_RATE_LIMITED : STREAM_FAILED;
          },
          onPlaybackError: () => void q.refetch(),
        }}
      />
      {droppedAssets > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="template-details-dropped-assets">
          {droppedAssets === 1
            ? "1 resource isn't shown: it doesn't pass libi's checks for a public template (installing this template would be refused)."
            : `${droppedAssets} resources aren't shown: they don't pass libi's checks for a public template (installing this template would be refused).`}
        </p>
      )}
    </DetailsLayout>
  );
}
