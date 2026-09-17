"use client";

import Link from "next/link";
import { Download, Plug } from "lucide-react";
import { suggestionHref, type ProviderSuggestionPayload } from "@/lib/chat/provider-suggestion";

/** A provider kind as it reads in "To make … you need a provider". */
const KIND_LABEL: Record<string, string> = {
  image: "images",
  video: "video",
  music: "music",
  voice: "voice",
  sfx: "sound effects",
  transcription: "transcripts",
};

/**
 * The in-chat answer to `libi.suggest_provider`: one button per suggestion.
 * An on-device extension offers Install (with its download size) and opens its
 * card on the libi MCP tab; a third-party provider offers Connect and opens its
 * row on the Providers tab. Both carry `from=<sessionId>` so the destination
 * shows Back to chat. The card never asks for a key.
 */
export function ProviderSuggestionCard({
  payload,
  sessionId,
}: {
  payload: ProviderSuggestionPayload;
  sessionId: string | null;
}) {
  return (
    <div
      data-testid="provider-suggestion-card"
      className="my-1.5 w-full max-w-[420px] rounded-lg border border-border bg-card p-3"
    >
      <p className="text-sm font-medium">
        To make {KIND_LABEL[payload.kind] ?? payload.kind} you need a provider
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        libi needs a provider for this. Pick one below — nothing here asks for a key.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {payload.suggested.map((s) => (
          <Link
            key={s.id}
            href={suggestionHref(s, sessionId)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
          >
            {s.kind === "extension" ? (
              <Download className="size-3.5 shrink-0" />
            ) : (
              <Plug className="size-3.5 shrink-0" />
            )}
            <span>{s.kind === "extension" ? `Install ${s.name}` : `Connect ${s.name}`}</span>
            {s.sizeNote ? (
              <span className="ml-auto text-[11px] text-muted-foreground">{s.sizeNote}</span>
            ) : null}
          </Link>
        ))}
      </div>
      {payload.covered.length > 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          You already have: {payload.covered.map((c) => c.name).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
