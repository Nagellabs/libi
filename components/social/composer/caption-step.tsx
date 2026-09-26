"use client";

import { AskAgentButton } from "@/components/social/ask-agent-button";
import { findSocialProvider } from "@/lib/social/catalog";
import type { SocialPlatform } from "@/lib/social/catalog";
import { fmtInt, postTypeOf, targetLabel, type TargetDraft } from "./types";

export interface CaptionLimit {
  platform: SocialPlatform;
  label: string;
  max: number;
  fold?: number;
}

/** What each chosen target allows, read from the provider catalog. A target
 *  whose post type takes no caption at all (an Instagram Story) has `max: 0`
 *  and is reported as such rather than counted to zero. */
export function captionLimits(targets: TargetDraft[]): CaptionLimit[] {
  const def = findSocialProvider("zernio");
  return targets.map((t) => {
    const postType = postTypeOf(t);
    const lim = def.platforms[t.platform].limits[postType];
    return {
      platform: t.platform,
      label: targetLabel(t.platform, postType),
      max: lim?.captionMax ?? 0,
      fold: lim?.captionFold,
    };
  });
}

/** True when any chosen target would reject this caption's length. */
export function captionOverLimit(caption: string, targets: TargetDraft[]): boolean {
  return captionLimits(targets).some((l) => l.max > 0 && caption.length > l.max);
}

/**
 * Step 3 — one caption, counted per platform. Writing the caption is the
 * agent's job (`Write with agent`); this step is a typed edit and the
 * counters, nothing more.
 */
export function CaptionStep({
  caption,
  targets,
  pieceId,
  pieceName,
  onChange,
}: {
  caption: string;
  targets: TargetDraft[];
  pieceId: string;
  pieceName: string;
  onChange: (next: string) => void;
}) {
  const limits = captionLimits(targets);
  const anyCaptioned = limits.some((l) => l.max > 0);

  return (
    <div className="space-y-3" data-testid="caption-step">
      {anyCaptioned ? (
        <textarea
          data-testid="caption-input"
          aria-label="Caption"
          value={caption}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className="w-full cursor-text rounded-lg border border-border bg-background p-3 text-sm"
          placeholder="Say what this is."
        />
      ) : (
        <p className="text-sm text-muted-foreground">None of the chosen targets takes a caption.</p>
      )}

      <ul className="space-y-1">
        {limits.map((l) => (
          <li key={`${l.platform}:${l.label}`} className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-muted-foreground">{l.label}</span>
            {l.max === 0 ? (
              <span className="text-muted-foreground">Story: no caption</span>
            ) : (
              <span className={caption.length > l.max ? "text-destructive" : "text-muted-foreground"}>
                {l.fold
                  ? `${fmtInt(caption.length)} / ${fmtInt(l.max)} · fold at ${fmtInt(l.fold)}`
                  : `${fmtInt(caption.length)} / ${fmtInt(l.max)}`}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <AskAgentButton
          kind="caption"
          ctx={{ pieceId, pieceName, targets: targets.map((t) => t.platform) }}
          label="Write with agent"
        />
        <span className="text-xs text-muted-foreground">The agent replies in chat; paste the caption here.</span>
      </div>
    </div>
  );
}
