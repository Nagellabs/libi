"use client";

import { Switch } from "@/components/ui/switch";
import type { InstagramOptions } from "@/lib/social/types";
import type { InstagramPostType } from "@/lib/social/catalog";
import { IG_TYPE_LABEL } from "./types";

const TYPES: InstagramPostType[] = ["reel", "feed", "story"];

/** 2% tolerance, the same one the fit check uses. */
function isPortrait(probe: { width: number; height: number } | null): boolean {
  if (!probe) return false;
  const r = probe.width / probe.height;
  return Math.abs(r - 9 / 16) / (9 / 16) <= 0.02;
}

/** Step 2, Instagram half — the options Instagram itself takes. */
export function TargetInstagram({
  options,
  probe,
  onChange,
}: {
  options: InstagramOptions;
  probe: { width: number; height: number } | null;
  onChange: (next: InstagramOptions) => void;
}) {
  const note =
    options.contentType === "story"
      ? "No caption, 60 s max, expires in 24 h"
      : options.contentType === "feed" && isPortrait(probe)
        ? "9:16 sources are cropped to 4:5 on the feed"
        : null;

  return (
    <div className="space-y-3" data-testid="target-instagram">
      <div role="radiogroup" aria-label="Instagram post type" className="flex overflow-hidden rounded-lg border border-border">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={options.contentType === t}
            data-testid={`ig-type-${t}`}
            onClick={() => onChange({ ...options, contentType: t })}
            className={`cursor-pointer px-3 py-1 text-xs ${
              options.contentType === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {IG_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      {options.contentType === "reel" && (
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={options.shareToFeed !== false}
            onCheckedChange={(v: boolean) => onChange({ ...options, shareToFeed: v })}
            data-testid="ig-share-to-feed"
          />
          Share to feed
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={options.commentsEnabled !== false}
          onCheckedChange={(v: boolean) => onChange({ ...options, commentsEnabled: v })}
          data-testid="ig-comments"
        />
        Comments
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={options.isAiGenerated === true}
          onCheckedChange={(v: boolean) => onChange({ ...options, isAiGenerated: v })}
          data-testid="ig-ai-label"
        />
        AI-generated label
      </label>
    </div>
  );
}
