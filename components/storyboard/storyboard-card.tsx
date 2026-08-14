"use client";

import { useState } from "react";
import { isOnTimeline } from "@/lib/storyboard/take-view";
import { isClipStale } from "@/lib/storyboard/stale";
import type { StoryboardCard as Card, GenParamValue } from "@/lib/storyboard/types";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";
import type { SchemasMap } from "@/lib/queries/storyboard";
import { useSelectTake, useHideTake, useUpdateGenParam, useSetReference, useSetSketchImage } from "@/lib/queries/storyboard";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCardOptionsShown } from "@/hooks/storyboard/use-card-options";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GeneratedTakesRow } from "./card/generated-takes-row";
import { SketchesRow } from "./card/sketches-row";
import { ReferenceVideosRow } from "./card/reference-videos-row";
import { AudioRow } from "./card/audio-row";
import { AddAssetMenu } from "./card/add-asset-menu";
import { GenerationOptions } from "./card/generation-options";

// Plain-language tooltips for the production-jargon values, shown on hover of the
// value itself — so the card reads cleanly but the meaning is one hover away.
const SHOT_TIP: Record<string, string> = {
  "extreme-wide": "Extreme wide — the subject is tiny in frame; establishes the whole environment.",
  wide: "Wide — the full subject plus their surroundings.",
  medium: "Medium — the subject from roughly the waist up.",
  close: "Close-up — the subject's face or a single detail fills the frame.",
  "extreme-close": "Extreme close-up — one small detail fills the frame.",
};
const MOTION_TIP: Record<string, string> = {
  static: "Static — locked-off camera, no movement.",
  "push-in": "Push-in — the camera moves toward the subject.",
  "pull-out": "Pull-out — the camera moves away from the subject.",
  "pan-left": "Pan left — the camera rotates to the left.",
  "pan-right": "Pan right — the camera rotates to the right.",
  "tilt-up": "Tilt up — the camera angles upward.",
  "tilt-down": "Tilt down — the camera angles downward.",
  handheld: "Handheld — loose, organic camera movement.",
  orbit: "Orbit — the camera arcs around the subject.",
};

/** One labeled detail as a small stat (label over value); the value carries a
 *  hover tooltip explaining the term. */
function Detail({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="w-fit cursor-default text-[11px] text-foreground/90 underline decoration-dotted decoration-muted-foreground/30 underline-offset-2" />
          }
        >
          {value}
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

interface StoryboardCardProps {
  pieceId: string;
  card: Card;
  index: number;
  schemas?: SchemasMap;
  onPrefill?: (text: string) => void;
  orderByCardId?: Record<string, number>;
}

export function StoryboardCard({
  pieceId,
  card,
  index,
  schemas = {},
  onPrefill,
  orderByCardId = {},
}: StoryboardCardProps) {
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  // General options (params, prompt, detail labels, voiceover) are hidden by
  // default — the card shows only its assets until the user opts in. Persisted
  // per piece+card so each card keeps its own state across board reopens.
  const [optionsShown, toggleOptions] = useCardOptionsShown(pieceId, card.id);
  const selectTake = useSelectTake(pieceId);
  const hideTake = useHideTake(pieceId);
  const updateGenParam = useUpdateGenParam(pieceId);
  const setReference = useSetReference(pieceId);
  const setSketchImage = useSetSketchImage(pieceId);

  const onTimeline = isOnTimeline(card);
  const stale = isClipStale(card);

  // Inline edit: persist one clip param, surfacing a 422 validation issue inline.
  const handleEditParam = (key: string, value: GenParamValue | null) => {
    updateGenParam.mutate(
      { cardId: card.id, tier: "clip", paramKey: key, value },
      {
        onError: (e) =>
          setParamErrors((p) => ({
            ...p,
            [key]: (e as { issues?: { message: string }[] }).issues?.[0]?.message ?? "invalid",
          })),
        onSuccess: () =>
          setParamErrors((p) => {
            const n = { ...p };
            delete n[key];
            return n;
          }),
      },
    );
  };

  const handleSetReference = (key: string, fromCardId: string | null) => {
    setReference.mutate({ cardId: card.id, paramKey: key, fromCardId });
  };

  // Other cards (by scene number) the user can inherit a reference video from.
  const otherCards = Object.entries(orderByCardId)
    .filter(([id]) => id !== card.id)
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => ({ cardId: id, label: `Scene ${String(n + 1).padStart(2, "0")}` }));

  // Resolve the clip schema from the schemas map using "apiUrl::model" key.
  const clipSchema: ModelSchema | undefined = card.clipGen
    ? schemas[`${card.clipGen.apiUrl}::${card.clipGen.model}`]?.lookup.schema
    : undefined;

  // Prefer the clipGen prompt param when present, fall back to promptFragment.
  const promptText: string | undefined =
    (card.clipGen?.params?.["prompt"] as string | undefined) || card.promptFragment;

  const sceneNum = String(index + 1).padStart(2, "0");
  const shot = card.camera.shot;
  const motion = card.camera.motion;

  return (
    <>
      {/* shrink-0: in the List view the card is a flex-column item; without this
          flexbox compresses it below its content height and the overflow-hidden
          clips the bottom (the prompt). */}
      <div className="shrink-0 rounded-lg border border-border bg-card/40 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-foreground shrink-0">
              Scene {sceneNum}
            </span>
            {card.title && (
              <>
                <span className="text-muted-foreground text-xs">·</span>
                <span className="text-xs font-medium text-foreground truncate">{card.title}</span>
              </>
            )}
          </div>
          <div className="shrink-0">
            {onTimeline ? (
              <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                on timeline
              </span>
            ) : (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                not on timeline
              </span>
            )}
          </div>
        </div>

        {/* Generation rows — in order */}
        <div className="flex flex-col gap-4 px-3 py-3">
          <GeneratedTakesRow
            pieceId={pieceId}
            card={card}
            onSelectTake={(takeId) => selectTake.mutate({ cardId: card.id, takeId })}
            onHideTake={(takeId) => hideTake.mutate({ cardId: card.id, takeId })}
            onPrefill={onPrefill}
          />

          <SketchesRow
            pieceId={pieceId}
            card={card}
            onEditParam={handleEditParam}
          />

          <ReferenceVideosRow
            card={card}
            orderByCardId={orderByCardId}
            onEditParam={handleEditParam}
            onSetReference={handleSetReference}
          />

          <AudioRow
            card={card}
            orderByCardId={orderByCardId}
            onEditParam={handleEditParam}
          />

          {/* Unified add/import entry point — one button for keyframes, sketches,
              and references. Schema-aware so it only offers what the model supports;
              each opens a popup to pick an existing piece asset or upload one. */}
          {card.clipGen && (
            <AddAssetMenu
              pieceId={pieceId}
              card={card}
              schema={clipSchema}
              onSetParam={(key, fileId) => handleEditParam(key, fileId)}
              onSetSketchImage={(slotId, fileId) =>
                setSketchImage.mutate({ cardId: card.id, slotId, imageFileId: fileId })
              }
              onSetReference={(key, fromCardId) => handleSetReference(key, fromCardId)}
              otherCards={otherCards}
            />
          )}

          {/* Options toggle — general options (params, prompt, labels, voiceover)
              are hidden by default; only the assets above show until opened. */}
          <button
            type="button"
            onClick={toggleOptions}
            className="cursor-pointer flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={optionsShown}
          >
            {optionsShown ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            {optionsShown ? "Hide options" : "Show options"}
          </button>

          {optionsShown && (
            <>
              <GenerationOptions
                card={card}
                schema={clipSchema}
                onEditParam={handleEditParam}
                errors={paramErrors}
                onPrefill={onPrefill}
              />

              {/* Prompt block */}
              {promptText && (
                <div className="rounded bg-muted/50 px-2 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Prompt
                  </span>
                  <p className="mt-0.5 text-xs text-foreground/80 leading-relaxed">
                    {promptText}
                  </p>
                </div>
              )}
            </>
          )}

          {/* Stale hint — params edited since the shown take was generated. */}
          {stale && (
            <div className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400">
              <span className="size-1.5 rounded-full bg-amber-400" />
              params changed · regenerate to apply
            </div>
          )}

          {/* Regenerate button */}
          {onPrefill && (
            <button
              type="button"
              className={cn(
                "cursor-pointer w-full rounded border px-2 py-1 text-[11px] transition-colors",
                stale
                  ? "border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
                  : "border-border text-foreground hover:bg-muted",
              )}
              onClick={() =>
                onPrefill(
                  `Regenerate the clip for scene "${card.title}" (card ${card.id}).`,
                )
              }
            >
              Regenerate clip
            </button>
          )}
        </div>

        {/* Details + Voiceover — part of the general options, hidden by default. */}
        {optionsShown && (
          <>
            <TooltipProvider delay={150}>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-border/40 px-3 py-2.5">
                <Detail
                  label="Role"
                  value={card.role}
                  tip="The scene's narrative role in the video (e.g. hook, reveal, b-roll)."
                />
                <Detail label="Shot" value={shot} tip={SHOT_TIP[shot] ?? "Camera shot size."} />
                {motion && (
                  <Detail label="Motion" value={motion} tip={MOTION_TIP[motion] ?? "Camera movement."} />
                )}
                <Detail
                  label="Duration"
                  value={`${card.durationSec}s`}
                  tip="How long this scene plays, in seconds."
                />
              </div>
            </TooltipProvider>

            {/* Voiceover */}
            {card.voiceover && (
              <div className={cn("px-3 pb-3")}>
                <div className="rounded bg-muted/60 px-2 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Voiceover
                  </span>
                  <p className="mt-0.5 text-xs text-foreground/80 leading-relaxed">
                    {card.voiceover.line}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
