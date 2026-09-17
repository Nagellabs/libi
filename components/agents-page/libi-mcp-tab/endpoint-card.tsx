"use client";

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { useMcpHealth, type McpHealth } from "@/lib/queries/mcp-health";
import { useRestartMcpEndpoint } from "@/lib/queries/mcp-restart";
import { cn } from "@/lib/utils";

/**
 * What a restart does to a chat that is already open, per agent. Measured
 * against both CLIs: killing the endpoint mid-chat and asking for a libi tool
 * again succeeded in the SAME chat — each client re-initializes its session.
 * An agent that instead lost its tools until a new chat would read "Open chats
 * lose libi's tools until you start a new chat."
 */
export const RESTART_COPY: Record<SetupAgentId, string> = {
  "claude-code": "Open chats keep working — their next libi tool call reconnects on its own.",
  codex: "Open chats keep working — their next libi tool call reconnects on its own.",
};

const AGENT_NAME: Record<SetupAgentId, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** One sentence when every agent behaves the same; otherwise one per agent, named. */
function restartCopyLines(): string[] {
  const entries = Object.entries(RESTART_COPY) as [SetupAgentId, string][];
  const distinct = [...new Set(entries.map(([, sentence]) => sentence))];
  return distinct.length === 1 ? distinct : entries.map(([id, sentence]) => `${AGENT_NAME[id]}: ${sentence}`);
}

type Tone = "ok" | "busy" | "bad";

/** The word beside the dot — a colour alone is not readable. */
function endpointStatus(health: McpHealth): { word: string; tone: Tone } {
  switch (health.childStatus) {
    case "restarting":
      return { word: "Restarting", tone: "busy" };
    case "gave-up":
      return { word: "Gave up", tone: "bad" };
    case "stopped":
      return { word: "Stopped", tone: "bad" };
    default:
      return health.childStatus === "running" && health.ok
        ? { word: "Running", tone: "ok" }
        : { word: "Unreachable", tone: "bad" };
  }
}

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  busy: "bg-amber-400",
  bad: "bg-destructive",
};

/**
 * libi's MCP endpoint: where it is, what version answers, whether it is up, and
 * a Restart that relaunches only the endpoint (never libi) on the same port.
 *
 * The dot is the source of truth, never the mutation's result: a failed restart
 * toasts its error, but the crash path may still bring the endpoint back, and
 * the health poll is what shows that.
 */
export function EndpointCard() {
  const visible = useDocumentVisible();
  const { data, isLoading } = useMcpHealth({ enabled: visible });
  const restart = useRestartMcpEndpoint();
  const [confirming, setConfirming] = useState(false);

  if (isLoading && !data) return <Skeleton className="h-24 w-full" />;

  const health: McpHealth = data ?? { ok: false, url: "", childStatus: "unknown" };
  const status = endpointStatus(health);

  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4" data-testid="endpoint-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <h2 className="text-sm font-semibold text-foreground">Libi&rsquo;s MCP endpoint</h2>
          {health.url ? (
            <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-[13px] text-foreground">
              {health.url}
            </code>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 rounded-full", DOT[status.tone])} />
              <span data-testid="endpoint-status" className="text-foreground">
                {status.word}
              </span>
            </span>
            {health.version ? (
              <span className="inline-flex items-center gap-1">
                Version <span className="font-mono text-foreground">{health.version}</span>
              </span>
            ) : null}
          </div>
          {!health.ok && health.error ? (
            <p className="text-[11px] text-muted-foreground">{health.error}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 cursor-pointer"
          // Also while the health poll already reads a restart in progress: the
          // route would only refuse a second one.
          disabled={restart.isPending || health.childStatus === "restarting"}
          onClick={() => setConfirming(true)}
        >
          <RotateCw
            className={cn("size-3.5", (restart.isPending || health.childStatus === "restarting") && "animate-spin")}
          />
          Restart
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Libi&rsquo;s MCP endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {restartCopyLines().map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                setConfirming(false);
                restart.mutate(undefined, {
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              Restart now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
