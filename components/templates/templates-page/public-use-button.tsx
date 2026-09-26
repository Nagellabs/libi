"use client";

import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import { DispatchToAgentDialog } from "@/components/agent/dispatch-to-agent-dialog";
import { Button } from "@/components/ui/button";
import { useDispatchToAgent } from "@/hooks/agent/use-dispatch-to-agent";
import { useInstallTemplate } from "@/lib/queries/templates-cloud";
import { templatePrompt } from "@/lib/templates/prompts";

/**
 * "Use" on a public catalog entry — its card and its List-view row alike:
 * install the version shown, then hand the agent an apply prompt that names
 * the template by its id alone. The name, description and tags are a
 * stranger's words, and the prompt is sent in the user's voice. The wait is
 * named on the button ("Installing…"); a failed install toasts (the hook) and
 * hands the agent nothing.
 */
export function PublicUseButton({ cloudId, version, testId }: { cloudId: string; version: number; testId: string }) {
  const install = useInstallTemplate();
  const dispatch = useDispatchToAgent();
  const use = async () => {
    let templateId: string;
    try {
      templateId = (await install.mutateAsync({ cloudId, version })).templateId;
    } catch {
      return; // the hook toasts why
    }
    // No piece is made here: `apply_template({ newPiece: {} })` makes one
    // (named "From template", never the listing's name), so closing the
    // dialog leaves only the installed template behind.
    dispatch.openWith(templatePrompt("apply", { templateId, origin: "installed" }));
  };
  return (
    <>
      <Button
        size="sm"
        className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
        data-testid={testId}
        focusableWhenDisabled={install.isPending}
        disabled={install.isPending}
        onClick={() => void use()}
      >
        {install.isPending ? <BusyLabel>Installing…</BusyLabel> : "Use"}
      </Button>
      <DispatchToAgentDialog {...dispatch} title="Ask the agent" />
    </>
  );
}
