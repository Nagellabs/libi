"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, Code2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import { TemplatePromptButton } from "@/components/templates/template-prompt-button";
import { CardExamplePlayer, onCardBodyClick } from "@/components/templates/templates-page/card-play";
import { DeleteTemplateDialog } from "@/components/templates/templates-page/delete-template-dialog";
import { TemplateVisibility } from "@/components/templates/templates-page/template-visibility";
import { useExampleHoverPlay } from "@/components/templates/templates-page/use-example-hover-play";
import { useExampleInlinePlay } from "@/components/templates/templates-page/use-example-inline-play";
import { templateMediaUrl, useDeleteTemplate, useRenderExample, useRenderingExamples } from "@/lib/queries/templates";
import type { MineTemplate } from "@/lib/templates/cloud/client";
import type { TemplateSummary } from "@/lib/templates/types";

/** An installed template — the only kind the grid renders today. A catalog
 *  row with no local `id` arrives with sub-project 3. */
export type InstalledTemplate = TemplateSummary & { id: string };

/** The media box's accessible name when it is a focus stop — never the template's own name. */
export const TEMPLATE_PREVIEW_LABEL = "Template preview";

/** Media is cached `private, max-age=60`, so every URL carries the template's
 *  version and its media revision: a re-extracted poster, or an example
 *  rendered since (no version bump), must not be served from the old response. */
export function mediaUrl(t: InstalledTemplate, name: string): string {
  return `${templateMediaUrl(t.id, name)}?v=${t.version}-${t.mediaRev}`;
}

/** Said on a local card with no example whose source piece was deleted. */
export const SOURCE_GONE_NOTE = "No preview — the source piece is gone.";

/**
 * "Render preview" renders the source piece AS IT IS NOW — which may have
 * changed since the template was made, so the preview could show something
 * the template doesn't make (D2–D4 review M6). It asks first, naming the
 * piece. (Rendering the template itself would mean applying it to a scratch
 * piece and filling its slots with something; the piece is the honest source.)
 */
export function RenderPreviewDialog({
  pieceName,
  open,
  onOpenChange,
  onConfirm,
}: {
  pieceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="template-render-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Render a preview?</AlertDialogTitle>
          <AlertDialogDescription>
            The preview renders from &ldquo;<bdi>{pieceName}</bdi>&rdquo; as it is now. If you changed that piece after
            making this template, the preview shows those changes too.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer" data-testid="template-render-confirm-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="cursor-pointer"
            data-testid="template-render-confirm-go"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
              onOpenChange(false);
            }}
          >
            Render preview
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A local template with no example yet: "Render preview" (the
 * `template_example` job, after the confirm above), its wait named on the
 * button while it runs — the agent's create starts one too — and why the
 * last render failed, if it did (review M1); or, with the source piece gone,
 * a note. Installed templates keep their author's example and show neither.
 */
export function NoExample({ t }: { t: InstalledTemplate }) {
  const renderExample = useRenderExample();
  const rendering = useRenderingExamples();
  const [confirming, setConfirming] = useState(false);
  if (t.origin !== "local") return null;
  // `null`, not falsy: a piece may be named "" and still exist (fix-round review N9).
  if (!t.canRenderExample || t.sourcePieceName === null)
    return (
      <p className="text-[0.65rem] text-muted-foreground" data-testid="template-card-source-gone">
        {SOURCE_GONE_NOTE}
      </p>
    );
  const busy = renderExample.isPending || (rendering.data?.templateIds.includes(t.id) ?? false);
  const failure = busy ? null : (rendering.data?.failed?.find((f) => f.templateId === t.id)?.error ?? null);
  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        variant="outline"
        size="xs"
        className={`cursor-pointer bg-background/80 ${BUSY_BUTTON_CLASS}`}
        data-testid="template-card-render"
        focusableWhenDisabled={busy}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {busy ? (
          <BusyLabel>Rendering preview…</BusyLabel>
        ) : (
          <>
            <Clapperboard data-icon="inline-start" />
            Render preview
          </>
        )}
      </Button>
      {failure && (
        <p
          role="status"
          className="line-clamp-2 max-w-full rounded bg-background/80 px-1.5 text-[0.65rem] break-words text-destructive"
          title={failure}
          data-testid="template-card-render-failed"
        >
          Preview failed: {failure}
        </p>
      )}
      <RenderPreviewDialog
        pieceName={t.sourcePieceName}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() =>
          renderExample.mutate(t.id, { onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't render the preview.") })
        }
      />
    </div>
  );
}

/**
 * Beside a moderated template, under its catalog status (which names the
 * reason, the takedown date and How to dispute — `TemplateVisibility`). The
 * catalog refuses any listing edit or new version of it, but the user's OWN
 * copy here is untouched by moderation and stays editable — so the note says
 * where an edit lands, not that none can.
 */
export const MODERATED_EDIT_NOTE = "Edits stay on this machine: the catalog won't take a new version of a moderated template.";

/** A local template's own page (`app/(app)/templates/[id]/page.tsx`). */
export function templatePageHref(id: string): string {
  return `/templates/${encodeURIComponent(id)}`;
}

/**
 * One template. The example video (when the template has one) plays muted on
 * hover/focus and stops on leave, one card at a time (`useExampleHoverPlay`);
 * the play button plays it inline WITH sound and controls, also one card at a
 * time (`useExampleInlinePlay`). A click on the card's body — anything that is
 * not a control — opens the template's page; the name is a link to it too.
 *
 * `published`: this template's own `/mine` entry, when the user published it.
 * The card then shows where it stands in the catalog, with the same controls
 * as "Your templates"' List view — Hide, Show again, or, when moderation
 * removed it, the reason, the takedown date and How to dispute
 * (`TemplateVisibility`, final review F10) — so Hide is where the delete
 * dialog says it is. A moderated template's listing can't be edited (the
 * site answers 403 `moderated`); "Ask the agent to edit" changes only the
 * local template, so the edit stays on and the card says where it lands.
 */
export function TemplateCard({
  t,
  highlighted,
  published = null,
}: {
  t: InstalledTemplate;
  highlighted: boolean;
  published?: MineTemplate | null;
}) {
  const moderated = published?.moderated === true;
  const id = t.id;
  const moderatedNoteId = useId();
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteTemplate();
  const router = useRouter();
  const href = templatePageHref(id);
  const exampleUrl = t.hasExample ? mediaUrl(t, "example.mp4") : null;
  const { videoRef, hovering, videoSrc, play, stop } = useExampleHoverPlay(exampleUrl);
  const inline = useExampleInlinePlay(exampleUrl);
  // While the card plays inline, hovering it does nothing: the muted preview would sit under the player.
  const hoverPlay = () => {
    if (!inline.playing) play();
  };
  const startInline = () => {
    stop();
    inline.start();
  };
  const aspect = `${t.canvas.width} / ${t.canvas.height}`;

  return (
    <li
      data-testid="template-card"
      data-template-id={id}
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card shadow-sm ${highlighted ? "border-foreground" : "border-border"}`}
      onMouseEnter={hoverPlay}
      onMouseLeave={stop}
      onClick={(e) => onCardBodyClick(e, () => router.push(href))}
    >
      <div className="relative w-full bg-muted" style={{ aspectRatio: aspect, maxHeight: "18rem" }}>
        {/* The preview image: the poster, and the example playing muted on
            hover or focus. Focus handlers sit here, not on the card: on the
            card they fire for every button inside it, so tabbing from Use to
            Delete restarted the clip. A focus stop is an image with a FIXED
            name — an installed template's name is a stranger's words, and
            stays plain text in the card below rather than becoming what a
            screen reader announces for the control. Only pictures inside it:
            `role="img"` makes its children presentational, so every control
            sits beside it (review I3) — and focusing one (the play button)
            doesn't start the preview. */}
        <div
          className="absolute inset-0"
          tabIndex={t.hasExample ? 0 : undefined}
          role={t.hasExample ? "img" : undefined}
          aria-label={t.hasExample ? TEMPLATE_PREVIEW_LABEL : undefined}
          onFocus={hoverPlay}
          onBlur={stop}
        >
          {t.hasPoster ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by our own media route
            <img src={mediaUrl(t, "poster.jpg")} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground" data-testid="template-card-no-poster">
              {t.canvas.width}×{t.canvas.height}
            </div>
          )}
          {t.hasExample && (
            <video
              ref={videoRef}
              data-testid="template-card-video"
              muted
              playsInline
              loop
              preload="none"
              aria-hidden="true"
              src={videoSrc ?? undefined}
              // Hidden again on leave, so the poster comes back rather than the
              // video's last painted frame sitting on top of it.
              className={`absolute inset-0 h-full w-full object-cover ${hovering ? "" : "hidden"}`}
            />
          )}
        </div>
        {!t.hasExample && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center px-2 text-center">
            <NoExample t={t} />
          </div>
        )}
        {exampleUrl && (
          <CardExamplePlayer
            src={exampleUrl}
            playing={inline.playing}
            onPlay={startInline}
            onStop={inline.stop}
            videoRef={inline.videoRef}
            playButtonRef={inline.playButtonRef}
            playerRef={inline.playerRef}
            onPlayerKeyDown={inline.onPlayerKeyDown}
            ids={{ play: "template-card-play", video: "template-card-inline-video", stop: "template-card-inline-stop" }}
          />
        )}
        {t.broken && (
          <span
            className="absolute top-2 left-2 rounded bg-destructive px-1.5 py-0.5 text-[0.65rem] text-destructive-foreground"
            title={t.broken}
            data-testid="template-card-broken"
          >
            broken
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium" data-testid="template-card-name">
            <Link href={href} className="cursor-pointer hover:underline">
              <bdi>{t.name}</bdi>
            </Link>
          </p>
          {t.hasCode && (
            <Badge variant="outline" className="shrink-0 gap-1 text-[0.65rem]" data-testid="template-card-has-code">
              <Code2 className="size-3" /> code
            </Badge>
          )}
        </div>
        {/* An installed template's text is a stranger's: isolated, so RTL text can't reorder the card. */}
        <p dir="auto" className="line-clamp-2 text-xs break-words text-muted-foreground [unicode-bidi:isolate]">
          {t.description}
        </p>
        {t.tags.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {t.tags.map((tag) => (
              <span key={tag} className="rounded-full border border-border px-1.5 text-[0.65rem] text-muted-foreground">
                <bdi>{tag}</bdi>
              </span>
            ))}
          </p>
        )}
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums" data-testid="template-card-uses">
          <span>{t.uses7d} this week</span>
          <span>{t.usesTotal} total</span>
          <span>
            {t.slots.length} {t.slots.length === 1 ? "slot" : "slots"}
          </span>
        </p>
        {published && (
          <div className="flex flex-col gap-1" data-testid="template-card-catalog">
            <TemplateVisibility template={published} className="flex-wrap" />
            {moderated && (
              <p id={moderatedNoteId} className="text-xs text-amber-500" data-testid="template-card-moderated">
                {MODERATED_EDIT_NOTE}
              </p>
            )}
          </div>
        )}
        <div className="mt-auto flex items-center gap-1 pt-1">
          {/* No piece is made here: `apply_template({ newPiece: {} })` makes
              one, so closing the dialog leaves nothing behind. */}
          <TemplatePromptButton kind="apply" ctx={{ templateId: id, name: t.name, origin: t.origin }} label="Use" variant="default" testId="template-use" />
          <TemplatePromptButton
            kind="edit"
            ctx={{ templateId: id, name: t.name, origin: t.origin }}
            label="Ask the agent to edit"
            icon={Pencil}
            testId="template-edit"
            describedBy={moderated ? moderatedNoteId : undefined}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer text-muted-foreground hover:text-destructive"
            aria-label="Delete template"
            data-testid="template-delete"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <DeleteTemplateDialog
        name={t.name}
        published={t.origin === "local" && !!t.cloudId}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => del.mutate(id, { onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't delete the template.") })}
      />
    </li>
  );
}
