"use client";

import { useCallback, useState } from "react";
import { Smartphone } from "lucide-react";
import { toast } from "sonner";
import { AspectRatioDialog } from "@/components/preview/aspect-ratio-dialog";
import { DispatchToAgentDialog } from "@/components/agent/dispatch-to-agent-dialog";
import { useDispatchToAgent } from "@/hooks/agent/use-dispatch-to-agent";
import { buildAspectChangePrompt } from "@/lib/composition/aspect-prompt";
import {
  describeRatio,
  dimensionsFor,
  orientationOf,
  type AspectRatioOption,
} from "@/lib/composition/aspect-ratio";
import { trackEvent } from "@/lib/analytics/client";

/**
 * The aspect-ratio toggle in the Preview row.
 *
 * The ratio LABEL sits beside the two buttons because there are three
 * orientations, not two: a square piece highlights neither button, and the
 * agent can set a ratio the catalog does not contain. Without the label both
 * of those read as "nothing selected", which looks broken.
 *
 * Routing: an empty piece is written directly — nothing exists to reflow, so
 * an agent round-trip would add a chat message and a wait for a change that
 * cannot go wrong. A piece with overlays goes to the agent, because the
 * resize alone would strand every overlay outside the new frame.
 */
export function AspectRatioControl({
  pieceId,
  pieceName,
  width,
  height,
  overlayCount,
}: {
  pieceId: string;
  pieceName: string;
  width: number;
  height: number;
  overlayCount: number;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dispatch = useDispatchToAgent();
  // The ratio the open dispatch dialog is FOR — needed because trackEvent
  // fires from the dialog's send/copy handlers below, decoupled in time from
  // the `target` that was in scope when askAgent() opened it.
  const [pendingRatioId, setPendingRatioId] = useState<string | null>(null);

  const orientation = orientationOf(width, height);
  const label = describeRatio(width, height);

  const applyDirect = async (target: AspectRatioOption) => {
    const dims = dimensionsFor(target.id);
    if (!dims) return;
    setBusy(true);
    try {
      // The canvas re-renders from the SSE invalidation the route emits, not
      // from this response — but a failed request still has to be reported:
      // otherwise the dialog closes and analytics records a change that
      // never happened, while the piece keeps its old dimensions.
      let res: Response;
      try {
        res = await fetch(`/api/pieces/${pieceId}/composition/dimensions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dims),
        });
      } catch {
        toast.error("Couldn't change the aspect ratio");
        return;
      }
      if (!res.ok) {
        toast.error("Couldn't change the aspect ratio");
        return;
      }
      trackEvent("aspect_ratio_changed", { ratio: target.id, mode: "direct" });
      setPickerOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const askAgent = (target: AspectRatioOption) => {
    const dims = dimensionsFor(target.id);
    if (!dims) return;
    const prompt = buildAspectChangePrompt({
      pieceId,
      pieceName,
      currentWidth: width,
      currentHeight: height,
      target,
      targetWidth: dims.width,
      targetHeight: dims.height,
      overlayCount,
    });
    setPendingRatioId(target.id);
    setPickerOpen(false);
    dispatch.openWith(prompt);
  };

  const onConfirm = (target: AspectRatioOption) => {
    if (overlayCount > 0) askAgent(target);
    else void applyDirect(target);
  };

  // Cancelling the dispatch dialog must NOT record a change — only an actual
  // send or copy does. `dispatch.send`/`dispatch.copy` report whether the
  // prompt actually reached the agent / clipboard (see
  // hooks/agent/use-dispatch-to-agent.ts); that's the signal these key off,
  // not the dialog opening.
  const handleDispatchSend = useCallback(async () => {
    const sent = await dispatch.send();
    if (sent && pendingRatioId) {
      trackEvent("aspect_ratio_changed", { ratio: pendingRatioId, mode: "dispatched" });
    }
  }, [dispatch, pendingRatioId]);

  const handleDispatchCopy = useCallback(async () => {
    const copied = await dispatch.copy();
    if (copied && pendingRatioId) {
      trackEvent("aspect_ratio_changed", { ratio: pendingRatioId, mode: "dispatched" });
    }
  }, [dispatch, pendingRatioId]);

  const btn = (active: boolean) =>
    `flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors ${
      active
        ? "bg-primary/15 text-primary"
        : "text-muted-foreground hover:bg-accent hover:text-foreground"
    }`;

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          type="button"
          title="Portrait"
          aria-label="Portrait"
          aria-pressed={orientation === "portrait"}
          data-testid="orientation-portrait"
          onClick={() => setPickerOpen(true)}
          className={btn(orientation === "portrait")}
        >
          <Smartphone className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Landscape"
          aria-label="Landscape"
          aria-pressed={orientation === "landscape"}
          data-testid="orientation-landscape"
          onClick={() => setPickerOpen(true)}
          className={btn(orientation === "landscape")}
        >
          <Smartphone className="h-3.5 w-3.5 rotate-90" />
        </button>
        <span
          data-testid="aspect-ratio-label"
          className="ml-0.5 text-[11px] tabular-nums text-muted-foreground"
        >
          {label}
        </span>
      </div>

      <AspectRatioDialog
        open={pickerOpen}
        setOpen={setPickerOpen}
        currentWidth={width}
        currentHeight={height}
        overlayCount={overlayCount}
        onConfirm={onConfirm}
        busy={busy}
      />

      <DispatchToAgentDialog
        open={dispatch.open}
        setOpen={dispatch.setOpen}
        prompt={dispatch.prompt}
        send={handleDispatchSend}
        copy={handleDispatchCopy}
        sending={dispatch.sending}
        title="Change the aspect ratio"
      />
    </>
  );
}
