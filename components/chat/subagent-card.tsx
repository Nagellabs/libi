"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Bot, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMessagePart } from "@/lib/agents/message-types";
import { formatSubagentResult } from "@/lib/agents/format-tool-name";

type SubagentPart = Extract<AgentMessagePart, { type: "subagent" }>;

interface Props {
  part: SubagentPart;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function SubagentCard({ part }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Lazy initializer: the impure Date.now() runs once at mount, not on every
  // render (the interval below keeps it fresh while running).
  const [now, setNow] = useState(() => Date.now());

  // The stored result is a JSON-stringified MCP content array
  // (`[{"type":"text","text":"…"}]`). Strip the wrapper and pretty-print
  // the inner JSON when it parses, so the expanded card shows readable
  // structured output instead of escape-laden raw JSON.
  const prettyResult = useMemo(
    () => (part.result ? formatSubagentResult(part.result) : ""),
    [part.result],
  );

  // Tick every second while running so the elapsed timer updates.
  useEffect(() => {
    if (part.status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [part.status]);

  // Replayed history has no startedAt (a replay-time stamp would be a lie);
  // fall back to the completion's measured duration, else show no timer.
  const elapsedMs =
    part.status === "running"
      ? part.startedAt !== undefined
        ? now - part.startedAt
        : null
      : (part.usage?.durationMs ??
        (part.startedAt !== undefined ? now - part.startedAt : null));

  const statusColor =
    part.status === "running"
      ? "text-blue-400"
      : part.status === "completed"
        ? "text-green-400"
        : part.status === "cancelled"
          ? "text-muted-foreground"
          : "text-destructive";

  return (
    <div
      className={cn(
        "my-2 rounded-lg border bg-card/60 px-3 py-2 text-sm",
        part.status === "failed" && "border-destructive/40",
        part.status === "running" && "border-blue-500/30",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Bot className={cn("h-4 w-4", statusColor)} />
        <span className="flex-1 truncate font-medium">{part.description}</span>
        <span
          role="status"
          className={cn("rounded px-1.5 py-0.5 text-xs font-medium", statusColor, "bg-muted/40")}
        >
          {part.status}
        </span>
        {part.model && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {part.model}
          </span>
        )}
        {part.background && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            background
          </span>
        )}
        {elapsedMs !== null && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDuration(elapsedMs)}
          </span>
        )}
      </button>

      {/* Live progress while running — shows the sub-agent's most recent
       *  activity text (tool name, file being read, etc.) so a long
       *  dispatch doesn't look like an unresponsive spinner. */}
      {part.progress && part.status === "running" && (
        <p
          className="mt-1 truncate pl-6 text-[11px] italic leading-tight text-muted-foreground/80"
          aria-live="polite"
        >
          <span className="mr-1 opacity-60">…</span>
          {part.progress}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-snug">
              {part.prompt}
            </pre>
          </div>
          {part.result && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
              <pre className="max-h-60 overflow-auto whitespace-pre rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
                {prettyResult}
              </pre>
            </div>
          )}
          {part.usage && (
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              {part.usage.totalTokens != null && <span>tokens: {part.usage.totalTokens.toLocaleString()}</span>}
              {part.usage.toolUses != null && <span>tools: {part.usage.toolUses}</span>}
              {part.usage.durationMs != null && <span>duration: {formatDuration(part.usage.durationMs)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
