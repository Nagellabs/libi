"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import { TemplatePromptButton } from "@/components/templates/template-prompt-button";
import { DetailsHeader, DetailsLayout, DetailsMessage, DetailsPlayer, DetailsRefreshNotice, useDetailsViewed } from "@/components/templates/template-details/details-layout";
import { DetailsSkeleton } from "@/components/templates/template-details/details-skeleton";
import { OverlaysList } from "@/components/templates/template-details/overlays-list";
import { ResourcesList } from "@/components/templates/template-details/resources-list";
import { UsagePanel } from "@/components/templates/template-details/usage-panel";
import { DeleteTemplateDialog } from "@/components/templates/templates-page/delete-template-dialog";
import { NoExample, type InstalledTemplate } from "@/components/templates/templates-page/template-card";
import { TemplateVisibility } from "@/components/templates/templates-page/template-visibility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { cachedTemplateCanvas, TemplatesHttpError, templateAssetUrl, templateMediaUrl, useDeleteTemplate, useTemplate } from "@/lib/queries/templates";
import { useCloudMine } from "@/lib/queries/templates-cloud";
import { lastUsedDayOf, overlayRows, resourceRows, usesInLastDays } from "@/lib/templates/details";

const TEMPLATES_HREF = "/templates";
export const LOCAL_NOT_FOUND = "This template isn't on this machine any more.";

const basename = (p: string) => p.split("/").pop() ?? p;

/**
 * A local template's page (`/templates/<id>`): the example with sound, what
 * it is, Use / Edit / Delete, its use here — and, when the user published it,
 * its catalog numbers and visibility (Hide / Show again, or why moderation
 * removed it and How to dispute) — then its overlays and resources.
 */
export function LocalTemplateDetails({ id }: { id: string }) {
  const q = useTemplate(id);
  // `/mine` spends the creator key against the site: only a template this user published needs it (review M1).
  const mine = useCloudMine({ enabled: q.data?.template.origin === "local" && !!q.data?.template.cloudId });
  const del = useDeleteTemplate();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  useDetailsViewed("local", !!q.data);

  // Gone is final, loaded or not (deleted from elsewhere — the agent, another window).
  const gone = q.isError && q.error instanceof TemplatesHttpError && q.error.status === 404;
  if (gone) return <DetailsMessage backHref={TEMPLATES_HREF} message={LOCAL_NOT_FOUND} />;
  // Otherwise data first: a refetch that fails keeps what was loaded (review I1).
  if (!q.data) {
    if (!q.isError) return <DetailsSkeleton canvas={cachedTemplateCanvas(qc, (t) => t.id === id)} />;
    return (
      <DetailsMessage backHref={TEMPLATES_HREF} message="Couldn't load this template.">
        <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </DetailsMessage>
    );
  }

  const { template: t, scaffold, usage } = q.data;
  const summary = t as InstalledTemplate;
  // Media is cached for a minute: the version and the media revision keep a re-rendered example from being served stale.
  const media = (name: string) => `${templateMediaUrl(id, name)}?v=${t.version}-${t.mediaRev}`;
  const published = t.origin === "local" && t.cloudId ? (mine.data?.templates.find((m) => m.id === t.cloudId) ?? null) : null;
  const overlays = scaffold ? overlayRows(scaffold) : null;
  // `templateAssetUrl`: an asset named poster.jpg is the asset, not the template's poster (review M6).
  const resources = scaffold ? resourceRows(scaffold, (file) => `${templateAssetUrl(id, basename(file))}&v=${t.version}`) : null;

  const remove = () =>
    del.mutate(id, {
      onSuccess: (r) => {
        if (r.note) toast.info(r.note);
        router.push(TEMPLATES_HREF);
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't delete the template."),
    });

  return (
    <DetailsLayout
      backHref={TEMPLATES_HREF}
      player={
        <DetailsPlayer
          exampleUrl={t.hasExample ? media("example.mp4") : null}
          posterUrl={t.hasPoster ? media("poster.jpg") : null}
          canvas={t.canvas}
          empty={<NoExample t={summary} />}
        />
      }
      aside={
        <>
          {q.isError && (
            <DetailsRefreshNotice message="Couldn't refresh this template — showing what was loaded." onRetry={() => void q.refetch()} />
          )}
          <DetailsHeader
            name={t.name}
            byline={
              published && mine.data?.nickname ? (
                <p className="text-xs text-muted-foreground" data-testid="template-details-published-as">
                  Published as{" "}
                  <span className="font-medium text-foreground">
                    <bdi>{mine.data.nickname}</bdi>
                  </span>
                </p>
              ) : null
            }
            description={t.description}
            tags={t.tags}
            canvas={t.canvas}
            duration={t.duration}
            slotCount={t.slotCount}
            hasCode={t.hasCode}
            badge={t.origin === "installed" ? <Badge variant="outline" className="text-[0.65rem]">Installed</Badge> : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            {/* No piece is made here: `apply_template({ newPiece: {} })` makes one, so closing the dialog leaves nothing behind. */}
            <TemplatePromptButton kind="apply" ctx={{ templateId: id, name: t.name, origin: t.origin }} label="Use" variant="default" testId="template-details-use" />
            <TemplatePromptButton kind="edit" ctx={{ templateId: id, name: t.name, origin: t.origin }} label="Ask the agent to edit" testId="template-details-edit" />
            <Button
              variant="ghost"
              size="sm"
              className={`cursor-pointer text-muted-foreground hover:text-destructive ${BUSY_BUTTON_CLASS}`}
              data-testid="template-details-delete"
              focusableWhenDisabled={del.isPending}
              disabled={del.isPending}
              onClick={() => setConfirming(true)}
            >
              {del.isPending ? (
                <BusyLabel>Deleting…</BusyLabel>
              ) : (
                <>
                  <Trash2 data-icon="inline-start" />
                  Delete
                </>
              )}
            </Button>
          </div>
          {published && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">In the catalog:</span>
              <TemplateVisibility template={published} />
            </div>
          )}
          <UsagePanel
            local={usage}
            catalog={
              published
                ? { total: published.usesTotal, d7: published.uses7d, d30: usesInLastDays(published.byDay, 30), lastUsedDay: lastUsedDayOf(published.byDay) }
                : undefined
            }
          />
        </>
      }
    >
      {t.broken || !overlays || !resources ? (
        <p className="text-sm text-amber-500" data-testid="template-details-broken">
          This template is broken: {t.broken ?? "its template.json could not be read"}.
        </p>
      ) : (
        <>
          <OverlaysList rows={overlays} />
          <ResourcesList rows={resources} fontSamples />
        </>
      )}
      <DeleteTemplateDialog name={t.name} published={t.origin === "local" && !!t.cloudId} open={confirming} onOpenChange={setConfirming} onConfirm={remove} />
    </DetailsLayout>
  );
}
