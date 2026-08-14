"use client";

import { useState } from "react";
import type { PermissionOption, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { cn } from "@/lib/utils";
import { formatToolId, formatBuiltinTitle } from "@/lib/agents/format-tool-name";
import { fromAnyToolName } from "@/lib/agents/mcp-tool-id";

type Props = {
  sessionId: string;
  pendingId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  reason: "acp" | "generation";
  status: "pending" | "resolved";
  outcome?: { kind: "selected"; optionId: string } | { kind: "cancelled" };
};

export function PermissionRequestCard({
  sessionId,
  pendingId,
  toolCall,
  options,
  reason,
  status,
  outcome,
}: Props) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(optionId: string) {
    setSubmitting(optionId);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingId, optionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSubmitting(null);
    }
  }

  const rawTitle =
    (toolCall as { title?: string }).title ?? "Permission required";
  const toolId = fromAnyToolName(rawTitle);
  const title = toolId ? formatToolId(toolId) : formatBuiltinTitle(rawTitle);
  const headline =
    reason === "generation"
      ? "Approve generation tool"
      : "Approve tool call";

  if (status === "resolved") {
    const selected =
      outcome?.kind === "selected"
        ? options.find((o) => o.optionId === outcome.optionId)
        : undefined;
    const verb = selected
      ? selected.kind === "allow_once" || selected.kind === "allow_always"
        ? "Allowed"
        : selected.kind === "reject_once" || selected.kind === "reject_always"
          ? "Rejected"
          : "Decision"
      : null;
    const label =
      outcome?.kind === "cancelled"
        ? "Cancelled"
        : `${verb}: ${selected?.name ?? "selected"}`;
    return (
      <div className="my-2 rounded-lg border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
        {headline} — <span className="text-foreground">{title}</span> · {label}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-sm">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-amber-500">
        {headline}
      </div>
      <div className="mb-3 break-all font-medium text-foreground">{title}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const isAllow =
            opt.kind === "allow_once" || opt.kind === "allow_always";
          const isBusy = submitting === opt.optionId;
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={submitting !== null}
              aria-busy={isBusy}
              aria-label={opt.name}
              onClick={() => choose(opt.optionId)}
              className={cn(
                "cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                isAllow
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
              )}
            >
              {isBusy ? "…" : opt.name}
            </button>
          );
        })}
      </div>
      {error && (
        <div role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
