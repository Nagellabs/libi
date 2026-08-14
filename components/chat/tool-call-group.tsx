"use client";

import { useRef, useState } from "react";
import type { AgentMessagePart } from "@/lib/agents/message-types";
import {
  formatToolId,
  formatBuiltinTitle,
  extractResultPreview,
  type ResultPreview,
} from "@/lib/agents/format-tool-name";
import ToolCallTimer from "./tool-call-timer";
import ToolCallStopButton from "./tool-call-stop-button";
import { cn } from "@/lib/utils";

export type ToolCallPart = Extract<AgentMessagePart, { type: "tool-call" }>;
export type ToolResultPart = Extract<AgentMessagePart, { type: "tool-result" }>;

export interface ToolCallEntry {
  call: ToolCallPart;
  result?: ToolResultPart;
}

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
  /** True while the message is still streaming and no final text follows this group */
  active: boolean;
}

const PROGRESS_MAX_CHARS = 220;
// Result blocks render as a wrapping mono code block, so we keep more
// characters and let the line-clamp constrain visual height.
const RESULT_MAX_CHARS = 1200;

/** Trim a multi-line string to a single line and truncate for display. */
function previewLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Cap the raw text length without collapsing whitespace — used for
 *  multi-line code blocks so we can preserve formatting up to a budget. */
function truncateBlock(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Extract a brief detail string from tool call args.
 * Returns null if the tool title already contains the detail.
 */
function extractToolDetail(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;

  // These tools already have descriptive titles from claude-agent-acp
  // (e.g. "Read /path (1-50)", "grep -i 'pattern' /path", "git status")
  const descriptiveTools = /^(Read |Edit |Write |grep |Fetch |Find |")/;
  if (descriptiveTools.test(toolName)) return null;

  // For tools with generic titles, extract the most informative arg
  if (typeof a.query === "string") return a.query;
  if (typeof a.pattern === "string") return a.pattern;
  if (typeof a.command === "string") return a.command;
  if (typeof a.description === "string") return a.description;
  if (typeof a.prompt === "string" && a.prompt.length <= 120) return a.prompt;
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.url === "string") return a.url;
  if (typeof a.skill === "string") return a.skill;
  if (typeof a.pieceId === "string") return `piece: ${a.pieceId}`;

  return null;
}

function ToolCallRow({ entry }: { entry: ToolCallEntry }) {
  const isDone = !!entry.result;
  const isFailed = entry.result?.success === false;
  const isRunning = !isDone && entry.call.status === "running";
  const isPending = !isDone && !isRunning;
  const runningAt = entry.call.runningAt;
  const completedAt = entry.result?.completedAt;
  const name = entry.call.toolId
    ? formatToolId(entry.call.toolId)
    : formatBuiltinTitle(entry.call.rawTitle);
  // For tool-detail extraction we use the rawTitle so the "descriptive
  // tools" regex (`Read /path`, `grep -i '…'`, etc.) keeps working.
  const detail = extractToolDetail(entry.call.rawTitle, entry.call.args);
  const truncatedDetail = detail && detail.length > 80 ? detail.slice(0, 77) + "…" : detail;

  // Live progress (in-flight) → inline italic line.
  // Completed result is either a one-line summary ("3 servers", "ok",
  // "id: abc") OR a multi-line code block (raw JSON / text). The
  // extractor decides which based on payload shape — short structured
  // results become summaries, long / unstructured payloads become blocks.
  let progressLine: string | null = null;
  let resultPreview: { preview: ResultPreview; tone: "result" | "error" } | null =
    null;
  if (isDone) {
    const preview = extractResultPreview(entry.result?.result);
    if (preview) {
      const truncated: ResultPreview =
        preview.kind === "block"
          ? { kind: "block", text: truncateBlock(preview.text, RESULT_MAX_CHARS) }
          : preview;
      resultPreview = {
        preview: truncated,
        tone: isFailed ? "error" : "result",
      };
    }
  } else if (isRunning && entry.call.progress) {
    progressLine = previewLine(entry.call.progress, PROGRESS_MAX_CHARS);
  }

  return (
    <div className="py-0.5 min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
            isFailed
              ? "bg-destructive/10 text-destructive ring-destructive/30"
              : "bg-[color:var(--accent-soft)] text-primary ring-primary/20",
          )}
        >
          {isFailed ? (
            <span className="size-1.5 rounded-full bg-destructive" />
          ) : isDone ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          ) : isPending ? (
            <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-label="queued" />
          ) : (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="libi-sparkle"
              aria-hidden="true"
            >
              <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
            </svg>
          )}
          <span>{name}</span>
          {isFailed && <span>— failed</span>}
        </span>
        {runningAt !== undefined && (isDone ? completedAt !== undefined : isRunning) && (
          <ToolCallTimer runningAt={runningAt} completedAt={completedAt} />
        )}
        {isRunning && entry.call.jobId && (
          <ToolCallStopButton jobId={entry.call.jobId} />
        )}
      </div>
      {truncatedDetail && (
        <p className="ml-4 mt-0.5 text-[10px] leading-tight text-muted-foreground/60 truncate">
          {truncatedDetail}
        </p>
      )}
      {progressLine && (
        <p
          className="ml-4 mt-0.5 text-[10px] leading-tight italic text-muted-foreground/80 truncate"
          aria-live="polite"
        >
          <span className="mr-1 opacity-60">…</span>
          {progressLine}
        </p>
      )}
      {resultPreview && resultPreview.preview.kind === "summary" && (
        <p
          className={cn(
            "ml-4 mt-0.5 text-[10px] leading-tight truncate",
            resultPreview.tone === "result" && "text-muted-foreground/70",
            resultPreview.tone === "error" && "text-destructive/80",
          )}
        >
          <span className="mr-1 opacity-50">→</span>
          {resultPreview.preview.text}
        </p>
      )}
      {resultPreview && resultPreview.preview.kind === "block" && (
        <pre
          className={cn(
            "ml-4 mt-1 overflow-hidden rounded-md border px-2 py-1 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all line-clamp-4",
            resultPreview.tone === "result" &&
              "border-border/50 bg-muted/30 text-muted-foreground/90",
            resultPreview.tone === "error" &&
              "border-destructive/30 bg-destructive/5 text-destructive/90",
          )}
        >
          {resultPreview.preview.text}
        </pre>
      )}
    </div>
  );
}

export default function ToolCallGroup({ entries, active }: ToolCallGroupProps) {
  const allDone = entries.every((e) => !!e.result);
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  // Stay open while tools are running OR while the message is still active
  // (agent may start more tool calls). Only collapse once a final text response follows.
  const expanded = userToggled ? userExpanded : !allDone || active;

  const handleToggle = () => {
    setUserToggled(true);
    setUserExpanded((prev) => !prev);
  };

  // Header aggregate timer — derived PURELY from part fields. Ticks from the
  // earliest observed `runningAt` while any tool still runs; freezes to the
  // span [earliest runningAt → latest completedAt] once all are done. Absent
  // when timing is unknown (no tool ever observed running).
  const runningAts = entries
    .map((e) => e.call.runningAt)
    .filter((v): v is number => v !== undefined);
  const completedAts = entries.map((e) => e.result?.completedAt);
  const headerRunningAt = runningAts.length > 0 ? Math.min(...runningAts) : undefined;
  const headerCompletedAt =
    allDone && completedAts.every((v): v is number => v !== undefined) && completedAts.length > 0
      ? Math.max(...completedAts)
      : undefined;

  // For single tool call, don't group — just show the row directly.
  // The outer wrapper takes full chat width and `min-w-0` lets the
  // bordered card respect its parent so wide result blocks (JSON,
  // multi-line text) wrap inside the card instead of pushing it past
  // the chat panel.
  if (entries.length === 1) {
    const entry = entries[0];
    return (
      <div className="mt-2 min-w-0 max-w-full">
        <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-sm overflow-hidden">
          <ToolCallRow entry={entry} />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 min-w-0 max-w-full">
      <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-sm overflow-hidden">
        {/* Summary header — always visible */}
        <button
          onClick={handleToggle}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
          <span>
            {entries.length} tool calls
          </span>
          {headerRunningAt !== undefined && (!allDone || headerCompletedAt !== undefined) && (
            <ToolCallTimer
              runningAt={headerRunningAt}
              completedAt={allDone ? headerCompletedAt : undefined}
            />
          )}
        </button>

        {/* Expandable content */}
        <div
          ref={contentRef}
          className="overflow-hidden transition-all duration-200"
          style={{
            // Each row can be up to ~6 lines tall now: title + args
            // detail + progress line + a 4-line code block. Estimate
            // generously rather than measure — ToolCallGroup is a
            // streaming target and we want expansion to stay smooth as
            // result blocks grow line-by-line.
            maxHeight: expanded ? `${entries.length * 140 + 16}px` : "0px",
            opacity: expanded ? 1 : 0,
          }}
        >
          <div className="mt-1 space-y-0.5 border-l border-border/50 pl-3 ml-0.5">
            {entries.map((entry) => (
              <ToolCallRow key={entry.call.toolCallId} entry={entry} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
