"use client";

import { DocsLink } from "@/components/agents-page/providers-tab/pieces";
import { SetupTerminal } from "@/components/terminal/setup-terminal";
import type { ProviderDef, ProviderKind } from "@/lib/providers/catalog";
import { cn } from "@/lib/utils";
import { AgentChip, type AgentChipProps } from "./agent-chip";

export type RowChip = Omit<AgentChipProps, "providerId" | "providerName">;

/** The line under a row after its command: ready to use, or added but not usable until the user signs in. */
export interface RowNotice {
  tone: "ready" | "sign-in";
  text: string;
}

const KIND_LABEL: Record<ProviderKind, string> = {
  image: "Images",
  video: "Video",
  music: "Music",
  voice: "Voice",
  sfx: "Sound effects",
  transcription: "Transcription",
};

/**
 * One third-party provider: what it makes, its docs, and the chip for the
 * agent the tab shows. A provider with no published MCP server (no catalog
 * commands) gets its docs link and no actions.
 *
 * The tab's one setup terminal is rendered inside the row whose action opened
 * it (`showTerminal`), so the command sits next to the provider it is about.
 */
export function ProviderRow({
  def,
  chip,
  highlighted,
  showTerminal,
  notice,
}: {
  def: ProviderDef;
  /** The selected agent's chip; null for a docs-only provider that agent doesn't have. */
  chip: RowChip | null;
  highlighted: boolean;
  showTerminal: boolean;
  /** What this row's open command led to, once detection shows it (`rowNotice` in providers-tab.tsx). */
  notice: RowNotice | null;
}) {
  return (
    <div
      data-testid={`provider-row-${def.id}`}
      className={cn("space-y-3 rounded-lg border border-border p-4", highlighted && "ring-2 ring-yellow-500/60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{def.name}</div>
          <div className="text-xs text-muted-foreground">{def.kinds.map((k) => KIND_LABEL[k]).join(" · ")}</div>
        </div>
        {def.docsUrl ? <DocsLink href={def.docsUrl} /> : null}
      </div>

      {/* Credits: https://higgsfield.ai/mcp — each generation costs credits by model and resolution, from the
          user's existing Higgsfield plan credits, through any connected agent. */}
      {def.auth === "oauth" ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No key: you sign in with your {def.name} account in your browser, and generations use your {def.name} credits.
        </p>
      ) : null}

      {def.commands ? null : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No MCP server published yet — see the vendor&apos;s docs for how to connect it.
        </p>
      )}

      {chip ? <AgentChip providerId={def.id} providerName={def.name} {...chip} /> : null}

      {notice ? (
        <p
          data-testid={`provider-notice-${def.id}`}
          className={cn("text-xs", notice.tone === "ready" ? "text-emerald-500" : "text-amber-500")}
        >
          {notice.text}
        </p>
      ) : null}

      {showTerminal ? <SetupTerminal surface="providers" /> : null}
    </div>
  );
}
