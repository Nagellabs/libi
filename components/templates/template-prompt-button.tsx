"use client";

import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DispatchToAgentDialog } from "@/components/agent/dispatch-to-agent-dialog";
import { useDispatchToAgent } from "@/hooks/agent/use-dispatch-to-agent";
import { templatePrompt, type TemplatePromptCtx, type TemplatePromptKind } from "@/lib/templates/prompts";

/**
 * The Templates page's door to the agent (spec §7: "Never a form of our own").
 * Every button on this page does the same thing: build a prompt from the
 * template and show it in the shared dispatch dialog. Nothing is created,
 * written or deleted on the way — `Use` hands over
 * `apply_template({ newPiece: {} })` and lets the AGENT make the piece, so
 * closing the dialog leaves nothing behind.
 *
 * No analytics fires here: the page's adoption signal is the server-side
 * `template_applied`, recorded when the agent actually applies one. Counting
 * opened dialogs instead would count intentions.
 */
export function TemplatePromptButton({
  kind,
  ctx,
  label,
  variant = "outline",
  icon: Icon,
  testId,
  describedBy,
}: {
  kind: TemplatePromptKind;
  ctx: TemplatePromptCtx;
  label: string;
  variant?: "outline" | "ghost" | "default";
  icon?: LucideIcon;
  testId: string;
  /** The id of a note that says more about what this button does (`aria-describedby`). */
  describedBy?: string;
}) {
  const dispatch = useDispatchToAgent();
  const onClick = () => dispatch.openWith(templatePrompt(kind, ctx));
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
                  data-testid={testId}
                  aria-label={label}
                  aria-describedby={describedBy}
                  onClick={onClick}
                />
              }
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Button variant={variant} size="sm" className="cursor-pointer" data-testid={testId} aria-describedby={describedBy} onClick={onClick}>
          {label}
        </Button>
      )}
      <DispatchToAgentDialog {...dispatch} title="Ask the agent" />
    </>
  );
}
