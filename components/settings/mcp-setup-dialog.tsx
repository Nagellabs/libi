"use client";

import { useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { McpServerUI } from "@/lib/queries/mcp-servers";
import { useMcpInstallPlan } from "@/lib/queries/mcp-servers";
import type { DependencyStatus } from "@/mcp/registry/types";
import { buildInstallPrompt, buildRepairPrompt } from "@/lib/install-with-agent/prompts";
import { useSetupWithAgent } from "@/hooks/settings/use-setup-with-agent";
import { useEditorState } from "@/lib/editor-state-context";

export interface McpSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: McpServerUI;
  deps: DependencyStatus[] | undefined;
  action: "install" | "repair";
}

// Minimal markdown component map — keeps plan rendering native to the dark
// UI without pulling in full chat-message styling.
const planComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-sm font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-xs font-semibold first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-2 text-xs last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-4 text-xs last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-4 text-xs last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code
          className="block overflow-x-auto rounded bg-black/30 p-2 text-[11px] font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-black/30 px-1 py-0.5 text-[11px] font-mono" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

function InstallPlanExpander({ serverId }: { serverId: string }) {
  const [enabled, setEnabled] = useState(false);
  const { data: plan, isLoading, error } = useMcpInstallPlan(serverId, { enabled });

  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    const details = e.currentTarget;
    if (details.open && !enabled) {
      setEnabled(true);
    }
  }

  return (
    <details className="group" onToggle={handleToggle}>
      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground list-none flex items-center gap-1">
        <span className="inline-block transition-transform group-open:rotate-90">▶</span>
        See full install plan
      </summary>
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-3">
        {isLoading && !plan && (
          <Skeleton className="h-32 w-full" />
        )}
        {error && !plan && (
          <p className="text-xs text-destructive">
            Could not load install plan: {error.message}
          </p>
        )}
        {plan && (
          <div className="text-xs leading-relaxed text-foreground/90">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={planComponents}>
              {plan.plan}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </details>
  );
}

export function McpSetupDialog({
  open,
  onOpenChange,
  server,
  action,
}: McpSetupDialogProps): ReactElement {
  const { activeProviderId, agentProviders } = useEditorState();
  const { run, isPending, error } = useSetupWithAgent();

  const agentName =
    activeProviderId != null
      ? (agentProviders.find((p) => p.id === activeProviderId)?.name ?? activeProviderId)
      : null;

  const prompt =
    action === "install"
      ? buildInstallPrompt({ id: server.id, name: server.name })
      : buildRepairPrompt({ id: server.id, name: server.name, installError: server.installError });

  const title = action === "install" ? `Set up ${server.name}` : `Fix ${server.name}`;
  const primaryLabel = action === "install" ? "Set up with agent" : "Fix with agent";

  async function handlePrimary() {
    try {
      await run({ prompt });
      onOpenChange(false);
    } catch {
      // error is surfaced via the `error` state from useSetupWithAgent
    }
  }

  const isDisabled = agentName === null || isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the default dialog so the expanded install plan (with
          code blocks) reads comfortably. Override `sm:max-w-sm` from the
          DialogContent base. */}
      <DialogContent className="max-w-4xl sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Lead text */}
          <p className="text-sm text-muted-foreground">
            {agentName != null
              ? `I'll start a new session with ${agentName} and send the prompt below.`
              : "Select an agent in the sidebar first to enable this."}
          </p>

          {/* Prompt preview */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Prompt</p>
            <pre className="rounded-md border border-border bg-muted/40 p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
              {prompt}
            </pre>
          </div>

          {/* Lazy install plan expander */}
          <InstallPlanExpander serverId={server.id} />

          {/* Inline error from run() */}
          {error != null && (
            <p className="text-xs text-destructive">
              {error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>

          {isDisabled && agentName === null ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <Button
                    variant="default"
                    className="cursor-pointer"
                    disabled
                  >
                    {primaryLabel}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Select an agent in the sidebar first.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button
              variant="default"
              className="cursor-pointer"
              disabled={isDisabled}
              onClick={handlePrimary}
            >
              {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {primaryLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
