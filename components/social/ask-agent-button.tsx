"use client";

import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DispatchToAgentDialog } from "@/components/agent/dispatch-to-agent-dialog";
import { useDispatchToAgent } from "@/hooks/agent/use-dispatch-to-agent";
import { askAgentPrompt, type AskCtx, type AskKind } from "@/lib/social/prompts";
import { trackEvent } from "@/lib/analytics/client";

/**
 * The one door from libi's own UI into everything the closed action list
 * does NOT let the UI do itself — a caption beyond a typed edit, deciding
 * where to post, working across pieces, bulk scheduling, or anything ad
 * related. Never a form of our own; always a prompt handed to the agent.
 *
 * Pass `icon` where the button sits in a header rather than in the flow of a
 * page: it then renders as an icon with `label` as its tooltip and its
 * accessible name, which is the same button — not a second, quieter one.
 */
export function AskAgentButton({
  kind,
  ctx,
  label,
  variant = "outline",
  icon: Icon,
}: {
  kind: AskKind;
  ctx: AskCtx;
  label?: string;
  variant?: "outline" | "ghost" | "default";
  icon?: LucideIcon;
}) {
  const dispatch = useDispatchToAgent();
  const text = label ?? "Ask the agent";
  const onClick = () => {
    trackEvent("social_ask_agent", { kind });
    dispatch.openWith(askAgentPrompt(kind, ctx));
  };

  return (
    <>
      {Icon ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  data-testid={`ask-agent-${kind}`}
                  aria-label={text}
                  onClick={onClick}
                />
              }
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{text}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Button variant={variant} size="sm" className="cursor-pointer" data-testid={`ask-agent-${kind}`} onClick={onClick}>
          {text}
        </Button>
      )}
      <DispatchToAgentDialog {...dispatch} title="Ask the agent" />
    </>
  );
}
